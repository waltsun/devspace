import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result } from "better-result";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { AgentConflictError, AgentTargetError } from "./local-agent-errors.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, type LocalAgentMcpClient } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("agent controller tools are exposed only when subagents are enabled", async (t) => {
  const disabled = await fixture(t);
  const disabledTools = (await disabled.client.listTools()).tools;
  assert.equal(disabledTools.some((tool) => tool.name === "agent_start"), false);
  assert.equal(disabledTools.some((tool) => tool.name === "agent_wait"), false);
  assert.equal(disabledTools.some((tool) => tool.name === "agent_continue"), false);
  assert.equal(disabledTools.some((tool) => tool.name === "agent_cancel"), false);

  const enabled = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });
  const enabledTools = (await enabled.client.listTools()).tools;
  const startTool = enabledTools.find((tool) => tool.name === "agent_start");
  const waitTool = enabledTools.find((tool) => tool.name === "agent_wait");
  const continueTool = enabledTools.find((tool) => tool.name === "agent_continue");
  const cancelTool = enabledTools.find((tool) => tool.name === "agent_cancel");
  assert.ok(startTool);
  assert.ok(waitTool);
  assert.ok(continueTool);
  assert.ok(cancelTool);
  assert.deepEqual(startTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(waitTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(continueTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(cancelTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(startTool._meta, {});
  assert.deepEqual(waitTool._meta, {});
  assert.deepEqual(continueTool._meta, {});
  assert.deepEqual(cancelTool._meta, {});
});

test("agent_start resolves the workspace and returns without waiting", async (t) => {
  let startInput: Parameters<LocalAgentMcpClient["start"]>[0] | undefined;
  let waitCalled = false;
  const record = makeAgentRecord({
    id: "agt_start_test",
    profileName: "codex-luna",
    provider: "codex",
    status: "running",
    model: "gpt-test",
    effort: "high",
    providerSessionId: "provider-session-1",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async (input) => {
      startInput = input;
      return Result.ok(record);
    },
    wait: async () => {
      waitCalled = true;
      return Result.ok({ record, timedOut: false });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await callAgentStart(context.client, {
    workspaceId: opened.workspaceId,
    target: "codex-luna",
    prompt: "  preserve this prompt\nexactly  ",
    model: "gpt-test",
    effort: "high",
    writeMode: "allowed",
  });

  assert.ok(startInput);
  assert.equal(startInput.target, "codex-luna");
  assert.equal(startInput.prompt, "  preserve this prompt\nexactly  ");
  assert.equal(startInput.model, "gpt-test");
  assert.equal(startInput.effort, "high");
  assert.equal(startInput.writeMode, "allowed");
  assert.equal(startInput.workspaceId, opened.workspaceId);
  assert.equal(startInput.workspaceRoot, opened.root);
  assert.equal(waitCalled, false);

  const structured = structuredContent(response);
  const agent = structured.agent as Record<string, unknown>;
  assert.match(responseText(response), /Started agent agt_start_test/);
  assert.equal(agent.id, "agt_start_test");
  assert.equal(agent.status, "running");
  assert.equal(agent.target, "codex-luna");
  assert.equal(agent.provider, "codex");
  assert.equal(agent.model, "gpt-test");
  assert.equal(agent.effort, "high");
  assert.equal(agent.providerSessionId, "provider-session-1");
});

test("agent_wait forwards the resolved workspace scope and returns a completed turn", async (t) => {
  let waitInput: {
    agentId: string;
    scope: { workspaceId?: string; workspaceRoot: string };
    timeoutMs?: number;
  } | undefined;
  const record = makeAgentRecord({
    id: "agt_wait_done",
    status: "idle",
    latestResponse: "done",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => Result.ok(record),
    wait: async (agentId, scope, timeoutMs) => {
      waitInput = { agentId, scope, timeoutMs };
      return Result.ok({ record, timedOut: false });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await callAgentWait(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
  });

  assert.deepEqual(waitInput, {
    agentId: record.id,
    scope: {
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.root,
    },
    timeoutMs: undefined,
  });
  const structured = structuredContent(response);
  assert.equal(structured.timedOut, false);
  const agent = structured.agent as Record<string, unknown>;
  assert.equal(agent.status, "idle");
  assert.equal(agent.latestResponse, "done");
  assert.match(responseText(response), /finished its current turn with status idle/);
});

test("agent_wait reports a bounded timeout without stopping the agent", async (t) => {
  const record = makeAgentRecord({ id: "agt_wait_timeout", status: "running" });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => Result.ok(record),
    wait: async (_agentId, _scope, timeoutMs) => {
      assert.equal(timeoutMs, 1_000);
      return Result.ok({ record, timedOut: true });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await callAgentWait(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
    timeoutMs: 1_000,
  });

  const structured = structuredContent(response);
  assert.equal(structured.timedOut, true);
  assert.equal((structured.agent as Record<string, unknown>).status, "running");
  assert.match(responseText(response), /still running after the wait timeout/);
  assert.doesNotMatch(responseText(response), /stop/i);
});

test("agent_continue forwards the workspace scope and overrides without waiting", async (t) => {
  let continueInput: unknown;
  let waitCalled = false;
  const record = makeAgentRecord({
    id: "agt_continue_test",
    profileName: "codex-luna",
    provider: "codex",
    status: "running",
    model: "gpt-test",
    effort: "high",
    providerSessionId: "thread_xyz",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    continue: async (agentId, prompt, overrides, scope) => {
      continueInput = { agentId, prompt, overrides, scope };
      return Result.ok(record);
    },
    wait: async () => {
      waitCalled = true;
      return Result.ok({ record, timedOut: false });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await callAgentContinue(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
    prompt: "  preserve\nthis exactly  ",
    model: "gpt-test",
    effort: "high",
    writeMode: "allowed",
  });

  assert.deepEqual(continueInput, {
    agentId: record.id,
    prompt: "  preserve\nthis exactly  ",
    overrides: {
      model: "gpt-test",
      effort: "high",
      writeMode: "allowed",
    },
    scope: {
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.root,
    },
  });
  assert.equal(waitCalled, false);

  const structured = structuredContent(response);
  const agent = structured.agent as Record<string, unknown>;
  assert.equal(agent.id, record.id);
  assert.equal(agent.target, "codex-luna");
  assert.equal(agent.provider, "codex");
  assert.equal(agent.status, "running");
  assert.equal(agent.providerSessionId, "thread_xyz");
  assert.match(responseText(response), /Continued agent agt_continue_test; status: running\./);
  assert.doesNotMatch(responseText(response), /completed|succeeded|finished/i);
});

test("agent_continue preserves whitespace, sends clean empty overrides, and rejects an empty prompt", async (t) => {
  let continueCalls = 0;
  let receivedPrompt: string | undefined;
  let receivedOverrides: unknown;
  const record = makeAgentRecord({ id: "agt_continue_prompt" });
  const localAgentClient = makeLocalAgentMcpClient({
    continue: async (_agentId, prompt, overrides) => {
      continueCalls += 1;
      receivedPrompt = prompt;
      receivedOverrides = overrides;
      return Result.ok(record);
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));

  const response = await callAgentContinue(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
    prompt: "  preserve\nthis exactly  ",
  });
  assert.equal(response.isError, undefined);
  assert.equal(receivedPrompt, "  preserve\nthis exactly  ");
  assert.deepEqual(receivedOverrides, {});
  assert.equal(continueCalls, 1);

  const invalid = await callAgentContinue(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
    prompt: "",
  });
  assert.equal(invalid.isError, true);
  assert.match(responseText(invalid), /prompt/);
  assert.equal(continueCalls, 1);
});

test("agent_continue preserves conflict errors without waiting, cancelling, or retrying", async (t) => {
  const error = new AgentConflictError({
    code: "AGENT_CONFLICT",
    agentId: "agt_continue_conflict",
    operation: "continue",
    retryable: false,
    message: "Agent agt_continue_conflict already has a running turn.",
  });
  let waitCalled = false;
  let cancelCalled = false;
  const localAgentClient = makeLocalAgentMcpClient({
    continue: async () => Result.err(error),
    wait: async () => {
      waitCalled = true;
      return Result.ok({ record: makeAgentRecord(), timedOut: false });
    },
    cancel: async () => {
      cancelCalled = true;
      return Result.err(error);
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));

  const response = await callAgentContinue(context.client, {
    workspaceId: opened.workspaceId,
    agentId: error.agentId!,
    prompt: "try another turn",
  });
  assert.equal(response.isError, true);
  assert.match(responseText(response), /AGENT_CONFLICT/);
  assert.match(responseText(response), /already has a running turn/);
  const structured = structuredContent(response);
  assert.equal(structured.errorCode, "AGENT_CONFLICT");
  assert.equal(structured.error, error.message);
  assert.equal(structured.errorRetryable, false);
  assert.equal(waitCalled, false);
  assert.equal(cancelCalled, false);
});

test("agent_cancel forwards the workspace scope and reports an asynchronous request", async (t) => {
  let cancelInput: unknown;
  let waitCalled = false;
  const record = makeAgentRecord({
    id: "agt_cancel_test",
    profileName: "codex-luna",
    provider: "codex",
    status: "running",
    providerSessionId: "thread_cancel",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    cancel: async (agentId, scope) => {
      cancelInput = { agentId, scope };
      return Result.ok(record);
    },
    wait: async () => {
      waitCalled = true;
      return Result.ok({ record, timedOut: false });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));

  const response = await callAgentCancel(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
  });

  assert.deepEqual(cancelInput, {
    agentId: record.id,
    scope: {
      workspaceId: opened.workspaceId,
      workspaceRoot: opened.root,
    },
  });
  assert.equal(waitCalled, false);
  const structured = structuredContent(response);
  assert.equal(structured.cancelRequested, true);
  assert.equal((structured.agent as Record<string, unknown>).status, "running");
  assert.match(responseText(response), /Cancellation requested for agent agt_cancel_test; current status: running\./);
  assert.doesNotMatch(responseText(response), /cancelled|canceled|stopped|completed/i);
});

test("agent_cancel preserves conflict errors when no active turn exists", async (t) => {
  const error = new AgentConflictError({
    code: "AGENT_CONFLICT",
    agentId: "agt_cancel_conflict",
    operation: "cancel",
    retryable: false,
    message: "Agent agt_cancel_conflict has no active turn to cancel.",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    cancel: async () => Result.err(error),
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));

  const response = await callAgentCancel(context.client, {
    workspaceId: opened.workspaceId,
    agentId: error.agentId!,
  });
  assert.equal(response.isError, true);
  assert.match(responseText(response), /AGENT_CONFLICT/);
  assert.match(responseText(response), /has no active turn to cancel/);
  const structured = structuredContent(response);
  assert.equal(structured.errorCode, "AGENT_CONFLICT");
  assert.equal(structured.error, error.message);
  assert.equal(structured.errorRetryable, false);
});

test("agent_continue and agent_cancel reject unknown workspaces before calling the client", async (t) => {
  let continueCalled = false;
  let cancelCalled = false;
  const localAgentClient = makeLocalAgentMcpClient({
    continue: async () => {
      continueCalled = true;
      return Result.ok(makeAgentRecord());
    },
    cancel: async () => {
      cancelCalled = true;
      return Result.ok(makeAgentRecord());
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const continueResponse = await callAgentContinue(context.client, {
    workspaceId: "ws_missing",
    agentId: "agt_missing_workspace",
    prompt: "try this",
  });
  assert.equal(continueResponse.isError, true);
  assert.match(responseText(continueResponse), /Unknown workspaceId: ws_missing/);

  const cancelResponse = await callAgentCancel(context.client, {
    workspaceId: "ws_missing",
    agentId: "agt_missing_workspace",
  });
  assert.equal(cancelResponse.isError, true);
  assert.match(responseText(cancelResponse), /Unknown workspaceId: ws_missing/);
  assert.equal(continueCalled, false);
  assert.equal(cancelCalled, false);
});

test("agent_wait preserves terminal error record fields", async (t) => {
  const record = makeAgentRecord({
    id: "agt_wait_error",
    status: "error",
    error: "Provider infrastructure failed.",
    errorCode: "PROVIDER_INFRASTRUCTURE_ERROR",
    errorRetryable: false,
  });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => Result.ok(record),
    wait: async () => Result.ok({ record, timedOut: false }),
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const opened = structuredContent(await callOpen(context.client, context.project));
  const response = await callAgentWait(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
  });
  const agent = structuredContent(response).agent as Record<string, unknown>;
  assert.equal(agent.status, "error");
  assert.equal(agent.error, "Provider infrastructure failed.");
  assert.equal(agent.errorCode, "PROVIDER_INFRASTRUCTURE_ERROR");
  assert.equal(agent.errorRetryable, false);
});

test("agent_start exposes LocalAgentClient errors without replacing their code or message", async (t) => {
  const error = new AgentTargetError({
    code: "UNKNOWN_TARGET",
    target: "missing-target",
    retryable: false,
    message: "Unknown subagent profile or provider: missing-target.",
  });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => Result.err(error),
    wait: async () => Result.err(error),
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));

  const response = await callAgentStart(context.client, {
    workspaceId: opened.workspaceId,
    target: "missing-target",
    prompt: "try this",
  });
  assert.equal(response.isError, true);
  assert.match(responseText(response), /UNKNOWN_TARGET/);
  assert.match(responseText(response), /Unknown subagent profile or provider: missing-target/);
  const structured = structuredContent(response);
  assert.equal(structured.errorCode, "UNKNOWN_TARGET");
  assert.equal(structured.error, "Unknown subagent profile or provider: missing-target.");
});

test("agent_wait rejects timeout values outside the MCP bounds", async (t) => {
  const record = makeAgentRecord({ id: "agt_timeout_validation" });
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => Result.ok(record),
    wait: async () => Result.ok({ record, timedOut: false }),
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const input = (timeoutMs: number) => callAgentWait(context.client, {
    workspaceId: opened.workspaceId,
    agentId: record.id,
    timeoutMs,
  });

  for (const timeoutMs of [0, 20_001, 1.5]) {
    const response = await input(timeoutMs);
    assert.equal(response.isError, true);
    assert.match(responseText(response), /timeoutMs/);
  }
});

test("agent_start and agent_wait propagate unknown workspace errors", async (t) => {
  const record = makeAgentRecord({ id: "agt_unknown_workspace" });
  let clientCalled = false;
  const localAgentClient = makeLocalAgentMcpClient({
    start: async () => {
      clientCalled = true;
      return Result.ok(record);
    },
    wait: async () => {
      clientCalled = true;
      return Result.ok({ record, timedOut: false });
    },
  });
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    localAgentClient,
  });

  const startResponse = await callAgentStart(context.client, {
    workspaceId: "ws_missing",
    target: "codex",
    prompt: "try this",
  });
  assert.equal(startResponse.isError, true);
  assert.match(responseText(startResponse), /Unknown workspaceId: ws_missing/);

  const waitResponse = await callAgentWait(context.client, {
    workspaceId: "ws_missing",
    agentId: record.id,
  });
  assert.equal(waitResponse.isError, true);
  assert.match(responseText(waitResponse), /Unknown workspaceId: ws_missing/);
  assert.equal(clientCalled, false);
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
  } finally {
    await closeRestored();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    localAgentClient?: LocalAgentMcpClient;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: options.localAgentProviders ? "1" : "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...loadedConfig,
        subagents: options.subagents ?? {
          enabled: true,
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : loadedConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    options.localAgentClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

async function callAgentStart(
  client: Client,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "agent_start",
    arguments: input,
  } as Parameters<Client["callTool"]>[0]);
}

async function callAgentWait(
  client: Client,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "agent_wait",
    arguments: input,
  } as Parameters<Client["callTool"]>[0]);
}

async function callAgentContinue(
  client: Client,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "agent_continue",
    arguments: input,
  } as Parameters<Client["callTool"]>[0]);
}

async function callAgentCancel(
  client: Client,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "agent_cancel",
    arguments: input,
  } as Parameters<Client["callTool"]>[0]);
}

function makeLocalAgentMcpClient(
  overrides: Partial<LocalAgentMcpClient> = {},
): LocalAgentMcpClient {
  const record = makeAgentRecord();
  return {
    start: async () => Result.ok(record),
    wait: async () => Result.ok({ record, timedOut: false }),
    continue: async () => Result.ok(record),
    cancel: async () => Result.ok(record),
    ...overrides,
  };
}

function makeAgentRecord(overrides: Partial<LocalAgentRecord> = {}): LocalAgentRecord {
  return {
    id: "agt_test",
    workspaceRoot: "C:\\workspace",
    profileName: "codex",
    provider: "codex",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
