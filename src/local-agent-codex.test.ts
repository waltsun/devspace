import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexAppServerRuntime,
  CodexLocalAgentDriver,
  isCodexWindowsSandboxRunnerStartupFailure,
  probeCodexWindowsSandbox,
  codexCommandEnvironment,
  parseCodexVersion,
  resolveCodexCommand,
  sandboxFor,
} from "./local-agent-codex.js";
import {
  AgentProviderInfrastructureError,
  agentErrorFromPayload,
  isAgentProviderError,
  toAgentErrorPayload,
} from "./local-agent-errors.js";


function fakeProbeChild() {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  Object.assign(child, {
    stdout,
    stderr,
    pid: undefined,
    killed: false,
    exitCode: null,
    kill: () => {
      killed = true;
      return true;
    },
  });
  return {
    child,
    stdout,
    stderr,
    events: child as unknown as EventEmitter,
    wasKilled: () => killed,
  };
}

const probeInput = {
  command: "C:/Codex/codex.exe",
  version: "0.149.0",
  env: { PATH: "C:/Windows/System32" },
  workspaceRoot: "C:/workspace",
};

let capturedProbeCommand = "";
let capturedProbeArgs: string[] = [];
let capturedProbeOptions: SpawnOptions | undefined;
const successfulProbeChild = fakeProbeChild();
const successfulProbeSpawn = ((command: string, args: string[], options: SpawnOptions) => {
  capturedProbeCommand = command;
  capturedProbeArgs = args;
  capturedProbeOptions = options;
  return successfulProbeChild.child;
}) as unknown as typeof spawn;
const successfulProbe = probeCodexWindowsSandbox(probeInput, successfulProbeSpawn);
successfulProbeChild.stdout.emit("data", "DEVSPACE_CODEX_SANDBOX_OK");
successfulProbeChild.events.emit("close", 0, null);
await successfulProbe;
assert.equal(capturedProbeCommand, probeInput.command);
assert.deepEqual(capturedProbeArgs, [
  "sandbox",
  "--permission-profile",
  ":workspace",
  "-C",
  probeInput.workspaceRoot,
  "--",
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference='Stop'; $null = Get-Location; Write-Output 'DEVSPACE_CODEX_SANDBOX_OK'",
]);
assert.equal(capturedProbeArgs.includes("windows"), false);
assert.equal(capturedProbeOptions?.cwd, probeInput.workspaceRoot);
assert.deepEqual(capturedProbeOptions?.stdio, ["pipe", "pipe", "pipe"]);

assert.equal(isCodexWindowsSandboxRunnerStartupFailure("timed out after 15000ms connecting runner pipe-in"), true);
assert.equal(isCodexWindowsSandboxRunnerStartupFailure("timed out after 16000ms connecting runner pipe-out"), true);
assert.equal(isCodexWindowsSandboxRunnerStartupFailure("timed out after 15000ms connecting runner pipe"), false);

async function rejectedProbe(
  child: ReturnType<typeof fakeProbeChild>,
  stderr: string,
  exitCode: number | null,
  timeoutMs?: number,
) {
  const promise = probeCodexWindowsSandbox(
    probeInput,
    (() => child.child) as unknown as typeof spawn,
    timeoutMs,
  );
  if (stderr) child.stderr.emit("data", stderr);
  if (exitCode !== null) child.events.emit("close", exitCode, null);
  return promise.then(
    () => { throw new Error("Expected sandbox probe to fail."); },
    (error) => error,
  );
}

const markerMissing = await rejectedProbe(fakeProbeChild(), "", 0);
assert.equal(markerMissing.code, "PROVIDER_INFRASTRUCTURE_ERROR");
assert.equal(markerMissing.retryable, false);
assert.match(markerMissing.message, /did not execute the expected probe command/);

const knownRunnerIn = fakeProbeChild();
const knownRunnerInError = await rejectedProbe(knownRunnerIn, "Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in", 1);
assert.equal(knownRunnerInError.code, "PROVIDER_INFRASTRUCTURE_ERROR");
assert.match(knownRunnerInError.message, /command runner failed to start/);

const knownRunnerOut = fakeProbeChild();
const knownRunnerOutError = await rejectedProbe(knownRunnerOut, "timed out after 15000ms connecting runner pipe-out", 1);
assert.equal(knownRunnerOutError.code, "PROVIDER_INFRASTRUCTURE_ERROR");
assert.match(knownRunnerOutError.message, /command runner failed to start/);

const genericFailure = await rejectedProbe(fakeProbeChild(), "windows sandbox: setup refresh failed with status exit code: 1", 1);
assert.equal(genericFailure.code, "PROVIDER_INFRASTRUCTURE_ERROR");
assert.equal(genericFailure.retryable, false);
assert.match(genericFailure.message, /Diagnostic: windows sandbox: setup refresh failed/);

const timeoutChild = fakeProbeChild();
const timeoutError = await rejectedProbe(timeoutChild, "", null, 5);
assert.equal(timeoutError.code, "PROVIDER_INFRASTRUCTURE_ERROR");
assert.equal(timeoutError.retryable, false);
assert.match(timeoutError.message, /timed out after 20000ms/);
assert.equal(timeoutChild.wasKilled(), true);

const enoentChild = fakeProbeChild();
const enoentPromise = probeCodexWindowsSandbox(probeInput, (() => enoentChild.child) as unknown as typeof spawn);
enoentChild.events.emit("error", Object.assign(new Error("spawn codex failed"), { code: "ENOENT" }));
const enoentError = await enoentPromise.then(
  () => { throw new Error("Expected ENOENT probe to fail."); },
  (error) => error,
);
assert.equal(enoentError.code, "PROVIDER_UNAVAILABLE");
assert.equal(enoentError.retryable, false);

const infrastructure = new AgentProviderInfrastructureError({
  code: "PROVIDER_INFRASTRUCTURE_ERROR",
  provider: "codex",
  agentId: "agt_test",
  operation: "sandbox_preflight",
  retryable: false,
  message: "sandbox failed",
});
assert.equal(isAgentProviderError(infrastructure), true);
const infrastructurePayload = toAgentErrorPayload(infrastructure);
assert.deepEqual(infrastructurePayload, {
  code: "PROVIDER_INFRASTRUCTURE_ERROR",
  message: "sandbox failed",
  retryable: false,
  provider: "codex",
  agentId: "agt_test",
  operation: "sandbox_preflight",
});
const reconstructedInfrastructure = agentErrorFromPayload(infrastructurePayload);
assert.ok(reconstructedInfrastructure);
assert.equal(reconstructedInfrastructure?.code, infrastructure.code);
assert.equal(reconstructedInfrastructure?.message, infrastructure.message);
assert.equal(reconstructedInfrastructure?.retryable, infrastructure.retryable);
assert.equal(reconstructedInfrastructure?.provider, infrastructure.provider);
assert.equal(reconstructedInfrastructure?.operation, infrastructure.operation);
let resolverCalls = 0;
const cachedDriver = new CodexLocalAgentDriver(
  { CODEX_HOME: "/tmp/codex-home" },
  () => {
    resolverCalls += 1;
    return { executable: "/usr/local/bin/codex", version: "1.2.3" };
  },
);
const cachedContext = { agentId: "agt_test", provider: "codex" as const, workspaceRoot: "/tmp/project" };
const resolvedCodexHome = resolve("/tmp/codex-home");
assert.equal(cachedDriver.runtimeKey(cachedContext), `codex:/usr/local/bin/codex:${resolvedCodexHome}`);
assert.equal(cachedDriver.runtimeKey(cachedContext), `codex:/usr/local/bin/codex:${resolvedCodexHome}`);
assert.equal(resolverCalls, 1, "Codex executable identity is resolved once per driver lifecycle");

assert.equal(parseCodexVersion("codex-cli 0.9.1"), "0.9.1");
assert.equal(sandboxFor("read_only"), "read-only");
assert.equal(sandboxFor("allowed"), "workspace-write");
assert.equal(sandboxFor("full_access"), "danger-full-access");
assert.equal(
  codexCommandEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test", PATH: "/tmp/bin" }).CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  undefined,
);

if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-app-server-test-"));
  const badBin = join(root, "bad-bin");
  const goodBin = join(root, "good-bin");
  await mkdir(badBin);
  await mkdir(goodBin);
  const badCandidate = join(badBin, "codex");
  const goodCandidate = join(goodBin, "codex");
  await writeFile(badCandidate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(goodCandidate, "#!/bin/sh\necho 'codex-cli 9.8.7'\n", { mode: 0o700 });
  await chmod(badCandidate, 0o700);
  await chmod(goodCandidate, 0o700);
  assert.deepEqual(
    resolveCodexCommand({ PATH: `${badBin}:${goodBin}` }),
    { executable: goodCandidate, version: "9.8.7" },
    "command resolution must skip candidates whose version probe exits non-zero",
  );

  const command = join(root, "fake-codex");
  await writeFile(command, `#!/usr/bin/env node
import readline from "node:readline";
let turn = 0;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    output({ id: message.id, result: { thread: { id: message.params.threadId || "thread_new" } } });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    output({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn_" + turn;
    output({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      if (message.params.input[0].text === "fail") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "failed", error: { message: "fake failure" } } } });
        return;
      }
      if (message.params.input[0].text === "empty") {
        output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [] } } });
        return;
      }
      const item = { type: "agentMessage", text: "fake response " + turn };
      output({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
      output({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [item] } } });
    });
  }
});
`, { mode: 0o700 });
  await chmod(command, 0o700);

  const runtime = new CodexAppServerRuntime({ command, env: process.env });
  try {
    await runtime.initialize();
    let callbackSessionId: string | undefined;
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: "/tmp/project",
      writeMode: "read_only",
      model: "gpt-5.4",
      effort: "high",
    }, { onSessionId: (id) => { callbackSessionId = id; } });
    assert.equal(firstResult.isOk(), true);
    if (firstResult.isErr()) throw firstResult.error;
    const first = firstResult.value;
    const resumedResult = await runtime.run({
      prompt: "resumed",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(resumedResult.isOk(), true);
    if (resumedResult.isErr()) throw resumedResult.error;
    const resumed = resumedResult.value;
    assert.equal(first.providerSessionId, "thread_new");
    assert.equal(callbackSessionId, "thread_new");
    assert.equal(first.finalResponse, "fake response 1");
    assert.equal(resumed.providerSessionId, "thread_new");
    assert.equal(resumed.finalResponse, "fake response 2");
    const failed = await runtime.run({
      prompt: "fail",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(failed.isErr(), true);
    if (failed.isErr()) {
      assert.equal(failed.error.code, "PROVIDER_EXECUTION_ERROR");
      assert.equal(failed.error.provider, "codex");
      assert.equal(failed.error.retryable, false);
    }
    const protocolFailure = await runtime.run({
      prompt: "empty",
      workspaceRoot: "/tmp/project",
      providerSessionId: first.providerSessionId ?? undefined,
    });
    assert.equal(protocolFailure.isErr(), true);
    if (protocolFailure.isErr()) {
      assert.equal(protocolFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
      assert.equal(protocolFailure.error.provider, "codex");
      assert.equal(protocolFailure.error.retryable, false);
      assert.ok(protocolFailure.error.cause, "provider protocol cause remains available internally");
      assert.equal("cause" in toAgentErrorPayload(protocolFailure.error), false);
    }
    await runtime.releaseSession("thread_new");
  } finally {
    await runtime.close();
    await runtime.close();

    let successfulDriverProbeCalls = 0;
    const successfulDriver = new CodexLocalAgentDriver(
      process.env,
      () => ({ executable: command, version: "9.8.7" }),
      async (input) => {
        successfulDriverProbeCalls += 1;
        assert.equal(input.command, command);
        assert.equal(input.workspaceRoot, root);
      },
      "win32",
    );
    const successfulRuntimeOne = await successfulDriver.createRuntime({ ...cachedContext, workspaceRoot: root });
    assert.equal(successfulRuntimeOne.isOk(), true);
    if (successfulRuntimeOne.isOk()) await successfulRuntimeOne.value.close();
    const successfulRuntimeTwo = await successfulDriver.createRuntime({ ...cachedContext, workspaceRoot: root });
    assert.equal(successfulRuntimeTwo.isOk(), true);
    if (successfulRuntimeTwo.isOk()) await successfulRuntimeTwo.value.close();
    assert.equal(successfulDriverProbeCalls, 1, "successful sandbox probe is cached per driver");

    let failedDriverProbeCalls = 0;
    const failedDriver = new CodexLocalAgentDriver(
      process.env,
      () => ({ executable: command, version: "9.8.7" }),
      async () => {
        failedDriverProbeCalls += 1;
        throw new AgentProviderInfrastructureError({
          code: "PROVIDER_INFRASTRUCTURE_ERROR",
          provider: "codex",
          operation: "sandbox_preflight",
          retryable: false,
          message: "sandbox failed",
        });
      },
      "win32",
    );
    const failedRuntimeOne = await failedDriver.createRuntime({ ...cachedContext, workspaceRoot: root });
    const failedRuntimeTwo = await failedDriver.createRuntime({ ...cachedContext, workspaceRoot: root });
    assert.equal(failedRuntimeOne.isErr(), true);
    assert.equal(failedRuntimeTwo.isErr(), true);
    assert.equal(failedDriverProbeCalls, 1, "failed sandbox probe is cached per driver");

    let skippedDriverProbeCalls = 0;
    const skippedDriver = new CodexLocalAgentDriver(
      process.env,
      () => ({ executable: command, version: "9.8.7" }),
      async () => { skippedDriverProbeCalls += 1; },
      "linux",
    );
    const skippedRuntime = await skippedDriver.createRuntime({ ...cachedContext, workspaceRoot: root });
    assert.equal(skippedRuntime.isOk(), true);
    if (skippedRuntime.isOk()) await skippedRuntime.value.close();
    assert.equal(skippedDriverProbeCalls, 0, "non-Windows driver skips sandbox probe");
    await rm(root, { recursive: true, force: true });
  }
}

const unavailable = await new CodexLocalAgentDriver({}, () => undefined).createRuntime(cachedContext);
assert.equal(unavailable.isErr(), true);
if (unavailable.isErr()) {
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, false);
}

{
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-cancellation-test-"));
  const serverScript = join(root, "fake-codex.mjs");
  const logPath = join(root, "messages.log");
  const releasePath = join(root, "release");
  await writeFile(serverScript, String.raw`
import readline from "node:readline";
import { appendFileSync, existsSync } from "node:fs";

const logPath = process.env.DEVSPACE_FAKE_LOG;
const releasePath = process.env.DEVSPACE_FAKE_RELEASE;
let turn = 0;
let currentPrompt = "";
let currentThreadId = "";
let currentTurnId = "";

function log(value) {
  appendFileSync(logPath, value + "\n");
}

function output(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function waitForRelease(callback) {
  if (existsSync(releasePath)) callback();
  else setImmediate(() => waitForRelease(callback));
}

function complete(status, includeItem) {
  const items = includeItem ? [{ type: "agentMessage", text: "fake response " + turn }] : [];
  if (includeItem) {
    output({ method: "item/completed", params: { threadId: currentThreadId, turnId: currentTurnId, item: items[0] } });
  }
  log("turn/completed:" + status);
  output({ method: "turn/completed", params: {
    threadId: currentThreadId,
    turn: { id: currentTurnId, status, items },
  } });
}

function sendTurnStartResponse(message) {
  output({ id: message.id, result: { turn: { id: currentTurnId } } });
  if (currentPrompt === "active-cancel" || currentPrompt === "abort-before-turn-response" || currentPrompt === "interrupt-error") return;
  setImmediate(() => complete(currentPrompt === "external-interrupt" ? "interrupted" : "completed", true));
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) log(message.method);
  if (message.method === "initialize") {
    output({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    output({ id: message.id, result: { thread: { id: message.params.threadId || "thread_new" } } });
    return;
  }
  if (message.method === "turn/start") {
    turn += 1;
    currentPrompt = message.params.input[0].text;
    currentThreadId = message.params.threadId;
    currentTurnId = "turn_" + turn;
    if (currentPrompt === "abort-before-turn-response") {
      waitForRelease(() => sendTurnStartResponse(message));
    } else {
      sendTurnStartResponse(message);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    if (currentPrompt === "interrupt-error") {
      log("interrupt-error-response");
      output({ id: message.id, error: { code: -32000, message: "interrupt failed" } });
      waitForRelease(() => complete("completed", true));
      return;
    }
    output({ id: message.id, result: {} });
    setImmediate(() => complete("interrupted", false));
  }
});
`, { encoding: "utf8" });

  let command = serverScript;
  if (process.platform === "win32") {
    command = join(root, "fake-codex.cmd");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${serverScript}" %*\r\n`, { encoding: "utf8" });
  } else {
    await chmod(serverScript, 0o700);
  }

  const runtime = new CodexAppServerRuntime({
    command,
    env: { ...process.env, DEVSPACE_FAKE_LOG: logPath, DEVSPACE_FAKE_RELEASE: releasePath },
  });
  const inputFor = (prompt: string, providerSessionId?: string) => ({
    prompt,
    workspaceRoot: "/tmp/project",
    ...(providerSessionId ? { providerSessionId } : {}),
  });
  const methods = async (): Promise<string[]> => (await readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  const count = async (method: string): Promise<number> => (await methods()).filter((value) => value === method).length;
  const waitForLog = async (value: string): Promise<void> => {
    await waitForAsync(async () => (await methods()).includes(value));
  };
  const assertCancelled = (result: Awaited<ReturnType<CodexAppServerRuntime["run"]>>) => {
    assert.equal(result.isErr(), true);
    if (result.isErr()) {
      assert.equal(result.error.code, "PROVIDER_CANCELLED");
      assert.equal(result.error.retryable, false);
    }
  };

  try {
    await runtime.initialize();

    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedResult = await runtime.run(inputFor("pre-aborted"), undefined, { signal: preAborted.signal });
    assertCancelled(preAbortedResult);
    assert.equal(await count("thread/start"), 0, "pre-aborted run must not start a thread");
    assert.equal(await count("thread/resume"), 0, "pre-aborted run must not resume a thread");
    assert.equal(await count("turn/start"), 0, "pre-aborted run must not start a turn");
    assert.equal(await count("turn/interrupt"), 0, "pre-aborted run must not interrupt a turn");

    const beforeTurnController = new AbortController();
    const beforeTurnResult = await runtime.run(
      inputFor("before-turn"),
      { onSessionId: () => { beforeTurnController.abort(); } },
      { signal: beforeTurnController.signal },
    );
    assertCancelled(beforeTurnResult);
    assert.equal(await count("thread/start"), 1, "thread identity must be created before the cancellation");
    assert.equal(await count("turn/start"), 0, "cancellation after session callback must prevent turn/start");

    const activeController = new AbortController();
    const activeRun = runtime.run(inputFor("active-cancel"), undefined, { signal: activeController.signal });
    await waitForLog("turn/start");
    activeController.abort();
    activeController.abort();
    const activeResult = await activeRun;
    assertCancelled(activeResult);
    await waitForLog("turn/completed:interrupted");
    assert.equal(await count("turn/interrupt"), 1, "one active turn must receive at most one interrupt");
    assert.equal(await count("thread/unsubscribe"), 0, "cancellation must not release the thread");
    assert.equal(runtime.isAlive(), true, "cancellation must not close the app-server runtime");

    const reusedResult = await runtime.run(inputFor("reuse-after-cancel"), undefined, { signal: new AbortController().signal });
    assert.equal(reusedResult.isOk(), true, "the same runtime must handle a later turn after cancellation");
    if (reusedResult.isOk()) assert.equal(reusedResult.value.finalResponse, "fake response 2");
    assert.equal(runtime.isAlive(), true);

    const delayedController = new AbortController();
    const turnStartCount = await count("turn/start");
    const delayedRun = runtime.run(inputFor("abort-before-turn-response"), undefined, { signal: delayedController.signal });
    await waitForAsync(async () => (await count("turn/start")) > turnStartCount);
    delayedController.abort();
    assert.equal(await count("turn/interrupt"), 1, "turnId-unknown cancellation must not interrupt early");
    await writeFile(releasePath, "release", { encoding: "utf8" });
    const delayedResult = await delayedRun;
    assertCancelled(delayedResult);
    await waitForAsync(async () => (await count("turn/interrupt")) === 2);

    const externalInterrupted = await runtime.run(inputFor("external-interrupt"));
    assertCancelled(externalInterrupted);

    const lateController = new AbortController();
    const completedResult = await runtime.run(inputFor("completion-wins"), undefined, { signal: lateController.signal });
    assert.equal(completedResult.isOk(), true, "normal completion wins over a late abort");
    const interruptsAfterCompletion = await count("turn/interrupt");
    lateController.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await count("turn/interrupt"), interruptsAfterCompletion, "completed turns must not be interrupted");

    await rm(releasePath, { force: true });
    const errorController = new AbortController();
    let errorRunSettled = false;
    const errorTurnStartCount = await count("turn/start");
    const errorRun = runtime.run(inputFor("interrupt-error"), undefined, { signal: errorController.signal }).then((result) => {
      errorRunSettled = true;
      return result;
    });
    await waitForAsync(async () => (await count("turn/start")) > errorTurnStartCount);
    errorController.abort();
    await waitForLog("interrupt-error-response");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errorRunSettled, false, "interrupt RPC failure must not finish the run");
    await writeFile(releasePath, "release", { encoding: "utf8" });
    const errorResult = await errorRun;
    assert.equal(errorResult.isOk(), true, "authoritative normal completion still wins after interrupt error");
    assert.equal(await count("thread/unsubscribe"), 0);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForAsync(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check()) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(await check(), true, "condition did not become true before timeout");
}
