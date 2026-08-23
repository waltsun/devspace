import assert from "node:assert/strict";
import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { daemonExecArgv, LocalAgentClient } from "./local-agent-client.js";
import { LocalAgentDaemon, type LocalAgentDaemonManager } from "./local-agent-daemon.js";
import {
  ensureLocalAgentDaemonSecret,
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  LocalAgentDaemonLock,
  localAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import {
  encodeLocalAgentDaemonResponse,
} from "./local-agent-daemon-protocol.js";
import { AgentConflictError, AgentScopeError, AgentTargetError } from "./local-agent-errors.js";
import type {
  AgentWaitError,
  AgentWaitResult,
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agentd-test-"));
const record: LocalAgentRecord = {
  id: "agt_test",
  workspaceId: "ws_test",
  workspaceRoot: join(root, "project"),
  profileName: "reviewer",
  provider: "codex",
  status: "running",
  activitySequence: 0,
  activity: [],
  createdAt: "now",
  updatedAt: "now",
};

class FakeManager implements LocalAgentDaemonManager {
  activeTurnCount = 1;
  runtimeCount = 0;
  closed = false;
  lastInput?: StartLocalAgentInput;
  lastCancel?: { agentId: string; scope: { workspaceId?: string; workspaceRoot: string } };
  cancelCalls = 0;
  cancelError = false;
  waitCalls: Array<{ agentId: string; scope: LocalAgentWorkspaceScope; timeoutMs: number; afterSequence?: number }> = [];
  waitRecordStatus: LocalAgentRecord["status"] = "idle";
  waitTimedOut = false;
  waitError?: AgentWaitError;
  waitGate?: Promise<import("better-result").Result<AgentWaitResult, AgentWaitError>>;
  resolveWait?: () => void;

  async start(input: StartLocalAgentInput) {
    this.lastInput = input;
    return Result.ok(record);
  }

  async continue(
    _agentId: string,
    _prompt: string,
    _overrides: RunOverrides | undefined,
    _scope: { workspaceId: string; workspaceRoot: string },
  ) {
    return Result.ok({ ...record, status: "running" } as LocalAgentRecord);
  }

  cancel(agentId: string, scope: { workspaceId?: string; workspaceRoot: string }) {
    this.cancelCalls += 1;
    this.lastCancel = { agentId, scope };
    if (this.cancelError) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "cancel",
        retryable: false,
        message: `Agent ${agentId} has no active turn to cancel.`,
      }));
    }
    return Result.ok({ ...record, status: "running" } as LocalAgentRecord);
  }

  get(_id: string, _scope: { workspaceId: string; workspaceRoot: string }) {
    return Result.ok(record);
  }

  wait(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
    timeoutMs: number,
    afterSequence?: number,
  ): Promise<import("better-result").Result<AgentWaitResult, AgentWaitError>> {
    this.waitCalls.push({ agentId, scope, timeoutMs, afterSequence });
    if (this.waitGate) return this.waitGate;
    if (this.waitError) return Promise.resolve(Result.err(this.waitError));
    return Promise.resolve(Result.ok({
      record: { ...record, status: this.waitRecordStatus },
      timedOut: this.waitTimedOut,
      wakeReason: this.waitTimedOut ? "timeout" : "terminal",
      activitySequence: record.activitySequence,
      activity: [],
      activityTruncated: false,
    }));
  }

  list(_scope: { workspaceId: string; workspaceRoot: string }) {
    return Result.ok([record]);
  }

  async evictIdle(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.activeTurnCount = 0;
  }
}

const manager = new FakeManager();
const daemon = new LocalAgentDaemon({
  stateDir: join(root, "state"),
  manager,
  idleShutdownMs: 60_000,
});
const client = new LocalAgentClient({
  stateDir: join(root, "state"),
  startupTimeoutMs: 2_000,
  platform: "linux",
  requestTimeoutMs: 2_000,
  spawnDaemon: () => { void daemon.start(); },
});

const missingDaemonStateDir = join(root, "missing-daemon-state");
let diagnosticSpawnCount = 0;
const missingDaemonClient = new LocalAgentClient({
  stateDir: missingDaemonStateDir,
  startupTimeoutMs: 50,
  platform: "linux",
  requestTimeoutMs: 50,
  spawnDaemon: () => { diagnosticSpawnCount += 1; },
});
for (const diagnostic of [
  () => missingDaemonClient.status(),
  () => missingDaemonClient.stop(),
  () => missingDaemonClient.logs(),
]) {
  const result = await diagnostic();
  assert.equal(result.isErr(), true);
  if (result.isErr()) assert.equal(result.error.code, "DAEMON_UNAVAILABLE");
}
assert.equal(diagnosticSpawnCount, 0, "daemon diagnostics must not start a missing daemon");

assert.deepEqual(
  daemonExecArgv([
    "--enable-source-maps",
    "--inspect=127.0.0.1:9229",
    "--inspect-brk",
    "--inspect-wait=127.0.0.1:9230",
    "--inspect-port", "9231",
    "--trace-warnings",
  ]),
  ["--enable-source-maps", "--trace-warnings"],
  "detached daemon startup must not inherit inspector flags",
);

let shutdownSocket: ReturnType<typeof createConnection> | undefined;
try {
  const started = unwrap(await client.run({
    target: "reviewer",
    prompt: "Review this",
    workspaceId: record.workspaceId!,
    workspaceRoot: join(root, "project"),
  }));
  assert.equal(started.id, record.id);
  assert.equal(manager.lastInput?.prompt, "Review this");
  const recordScope = { workspaceId: record.workspaceId!, workspaceRoot: record.workspaceRoot };
  assert.equal(unwrap(await client.get(record.id, recordScope)).id, record.id);
  assert.equal(unwrap(await client.list(recordScope))[0]?.id, record.id);
  const completedWait = unwrap(await client.wait(record.id, recordScope, 5_000));
  assert.equal(completedWait.timedOut, false);
  assert.equal(completedWait.record.status, "idle");
  assert.deepEqual(manager.waitCalls.at(-1), {
    agentId: record.id,
    scope: recordScope,
    timeoutMs: 5_000,
    afterSequence: undefined,
  });
  const cursorWait = unwrap(await client.wait(record.id, recordScope, 5_000, 7));
  assert.equal(cursorWait.wakeReason, "terminal");
  assert.equal(manager.waitCalls.at(-1)?.afterSequence, 7);
  manager.waitRecordStatus = "running";
  manager.waitTimedOut = true;
  const timedOutWait = unwrap(await client.wait(record.id, recordScope));
  assert.equal(timedOutWait.timedOut, true);
  assert.equal(timedOutWait.record.status, "running");
  assert.equal(manager.waitCalls.at(-1)?.timeoutMs, 20_000);
  manager.waitRecordStatus = "idle";
  manager.waitTimedOut = false;
  const longPoll = new Promise<import("better-result").Result<AgentWaitResult, AgentWaitError>>((resolve) => {
    manager.resolveWait = () => resolve(Result.ok({
      record: { ...record, status: "idle", latestResponse: "completed by wait" },
      timedOut: false,
      wakeReason: "terminal",
      activitySequence: record.activitySequence,
      activity: [],
      activityTruncated: false,
    }));
  });
  manager.waitGate = longPoll;
  const pendingWait = client.wait(record.id, recordScope, 5_000);
  await waitFor(() => manager.waitCalls.length >= 3);
  assert.equal(unwrap(await client.status()).state, "ready");
  manager.resolveWait?.();
  const longPollResult = unwrap(await pendingWait);
  assert.equal(longPollResult.timedOut, false);
  assert.equal(longPollResult.record.latestResponse, "completed by wait");
  manager.waitGate = undefined;
  manager.resolveWait = undefined;

  const shortTransportClient = new LocalAgentClient({
    stateDir: join(root, "state"),
    platform: "linux",
    requestTimeoutMs: 20,
    spawnDaemon: () => { throw new Error("existing daemon should be used"); },
  });
  manager.waitGate = new Promise((resolve) => {
    setTimeout(() => resolve(Result.ok({
      record: { ...record, status: "idle", latestResponse: "completed after transport timeout" },
      timedOut: false,
      wakeReason: "terminal",
      activitySequence: record.activitySequence,
      activity: [],
      activityTruncated: false,
    })), 40);
  });
  const extendedTransportWait = unwrap(await shortTransportClient.wait(record.id, recordScope, 50));
  assert.equal(extendedTransportWait.record.latestResponse, "completed after transport timeout");
  manager.waitGate = undefined;

  manager.waitError = new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: record.id,
    retryable: false,
    message: "Unknown subagent id.",
  });
  const missingWait = await client.wait(record.id, recordScope, 5_000);
  assert.equal(missingWait.isErr(), true);
  if (missingWait.isErr()) assert.equal(missingWait.error.code, "AGENT_NOT_FOUND");
  manager.waitError = new AgentScopeError({
    code: "WORKSPACE_MISMATCH",
    agentId: record.id,
    workspaceId: recordScope.workspaceId,
    operation: "wait",
    retryable: false,
    message: "Subagent belongs to a different workspace.",
  });
  const scopedWait = await client.wait(record.id, recordScope, 5_000);
  assert.equal(scopedWait.isErr(), true);
  if (scopedWait.isErr()) assert.equal(scopedWait.error.code, "WORKSPACE_MISMATCH");
  manager.waitError = undefined;
  const cancelled = unwrap(await client.cancel(record.id, recordScope));
  assert.equal(cancelled.status, "running", "cancel returns an acknowledgement record immediately");
  assert.equal(manager.cancelCalls, 1);
  assert.deepEqual(manager.lastCancel, { agentId: record.id, scope: recordScope });
  manager.cancelError = true;
  const cancelConflict = await client.cancel(record.id, recordScope);
  assert.equal(cancelConflict.isErr(), true);
  if (cancelConflict.isErr()) {
    assert.equal(cancelConflict.error.code, "AGENT_CONFLICT");
    assert.equal(cancelConflict.error.operation, "cancel");
  }
  assert.equal(manager.cancelCalls, 2);
  manager.cancelError = false;
  assert.equal(unwrap(await client.status()).state, "ready");

  unwrap(await client.stop());
  await waitFor(() => manager.closed && !existsSync(daemon.paths.socketPath));
} finally {
  await daemon.close();
}

const idleStateDir = join(root, "idle-state");
const idleManager = new FakeManager();
idleManager.activeTurnCount = 0;
const idleDaemon = new LocalAgentDaemon({
  stateDir: idleStateDir,
  manager: idleManager,
  idleShutdownMs: 200,
  idleCheckIntervalMs: 10,
});
const idleClient = new LocalAgentClient({
  stateDir: idleStateDir,
  startupTimeoutMs: 2_000,
  platform: "linux",
  requestTimeoutMs: 2_000,
  spawnDaemon: () => { void idleDaemon.start(); },
});

try {
  unwrap(await idleClient.ensureReady());
  await waitFor(() => idleManager.closed && !existsSync(idleDaemon.paths.socketPath));
} finally {
  await idleDaemon.close();
  await rm(root, { recursive: true, force: true });
}

const ownershipStateDir = join(root, "ownership-state");
const persistentStateDir = join(root, "persistent-state");
const persistentManager = new FakeManager();
persistentManager.activeTurnCount = 0;
const persistentDaemon = new LocalAgentDaemon({
  stateDir: persistentStateDir,
  manager: persistentManager,
  idleShutdownMs: null,
  idleCheckIntervalMs: 10,
});
await persistentDaemon.start();
await new Promise<void>((resolve) => setTimeout(resolve, 250));
assert.equal(persistentManager.closed, false, "persistent daemon must not idle-shutdown");
await persistentDaemon.close();
const ownerManager = new FakeManager();
const competingManager = new FakeManager();
const ownerDaemon = new LocalAgentDaemon({
  stateDir: ownershipStateDir,
  manager: ownerManager,
  idleShutdownMs: 60_000,
});
const competingDaemon = new LocalAgentDaemon({
  stateDir: ownershipStateDir,
  manager: competingManager,
  idleShutdownMs: 60_000,
});

try {
  const startupResults = await Promise.allSettled([
    ownerDaemon.start(),
    competingDaemon.start(),
  ]);
  assert.equal(
    startupResults.filter((result) => result.status === "fulfilled").length,
    1,
    "only one competing daemon may acquire the state-directory lock",
  );
  assert.equal(
    startupResults.filter((result) => result.status === "rejected").length,
    1,
  );
  const lockBefore = readFileSync(ownerDaemon.paths.lockPath, "utf8");
  const pidBefore = readFileSync(ownerDaemon.paths.pidPath, "utf8");
  assert.notEqual(ownerDaemon.paths.endpoint, "");
  assert.equal(readFileSync(ownerDaemon.paths.lockPath, "utf8"), lockBefore);
  assert.equal(readFileSync(ownerDaemon.paths.pidPath, "utf8"), pidBefore);
  const ownerClient = new LocalAgentClient({
    stateDir: ownershipStateDir,
    spawnDaemon: () => { throw new Error("the winning daemon should already be reachable"); },
  platform: "linux",
  });
  assert.equal(unwrap(await ownerClient.status()).pid, process.pid);
} finally {
  await competingDaemon.close();
  await ownerDaemon.close();
}

const startupFailureClient = new LocalAgentClient({
  stateDir: join(root, "startup-failure-state"),
  startupTimeoutMs: 20,
  platform: "linux",
  requestTimeoutMs: 10,
  spawnDaemon: () => { throw new Error("spawn failed"); },
});
const startupFailure = await startupFailureClient.ensureReady();
assert.equal(startupFailure.isErr(), true);
if (startupFailure.isErr()) assert.equal(startupFailure.error.code, "DAEMON_STARTUP_FAILURE");

const upgradeStateDir = join(root, "upgrade-state");
await mkdir(upgradeStateDir, { recursive: true });
const upgradePaths = localAgentDaemonPaths(upgradeStateDir);
ensureLocalAgentDaemonSecret(upgradePaths);
const legacyLock = new LocalAgentDaemonLock(upgradePaths);
legacyLock.acquire();
const legacyMethods: string[] = [];
const legacyServer = createNetServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline)) as {
      requestId: string;
      protocolVersion: number;
      method: string;
    };
    legacyMethods.push(`${request.method}:${request.protocolVersion}`);
    if (request.protocolVersion !== 1) {
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: 1,
        ok: false,
        error: {
          code: "DAEMON_PROTOCOL_MISMATCH",
          message: "Unsupported daemon protocol version 3; expected 1.",
          retryable: false,
        },
      }));
      return;
    }
    const stopping = request.method === "daemon.stop";
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: 1,
      ok: true,
      result: {
        state: stopping ? "stopping" : "ready",
        protocolVersion: 1,
        pid: process.pid,
        endpoint: upgradePaths.endpoint,
        host: { pid: process.pid, platform: "win32", windowsSessionId: 1, interactive: true },
        startedAt: "now",
        activeTurns: 0,
        runtimeCount: 0,
        clientConnections: 1,
      },
    }), () => {
      if (stopping) {
        legacyServer.close(() => {
          setTimeout(() => legacyLock.release(), 50);
        });
      }
    });
  });
});
await new Promise<void>((resolveListen, rejectListen) => {
  legacyServer.once("error", rejectListen);
  legacyServer.listen(upgradePaths.endpoint, resolveListen);
});
const replacementManager = new FakeManager();
replacementManager.activeTurnCount = 0;
const replacementDaemon = new LocalAgentDaemon({
  stateDir: upgradeStateDir,
  manager: replacementManager,
  idleShutdownMs: 60_000,
});
let replacementSpawns = 0;
let spawnedBeforeLegacyLockReleased = false;
const upgradeClient = new LocalAgentClient({
  stateDir: upgradeStateDir,
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 500,
  platform: "linux",
  spawnDaemon: () => {
    replacementSpawns += 1;
    spawnedBeforeLegacyLockReleased = existsSync(upgradePaths.lockPath);
    void replacementDaemon.start();
  },
});
try {
  assert.equal(unwrap(await upgradeClient.ensureReady()).protocolVersion, LOCAL_AGENT_DAEMON_PROTOCOL_VERSION);
  assert.equal(replacementSpawns, 1);
  assert.equal(spawnedBeforeLegacyLockReleased, false);
  assert.deepEqual(legacyMethods.slice(0, 3), [`hello:${LOCAL_AGENT_DAEMON_PROTOCOL_VERSION}`, "hello:1", "daemon.stop:1"]);
} finally {
  legacyLock.release();
  await replacementDaemon.close();
}

const replacementRaceStateDir = join(root, "upgrade-race-state");
await mkdir(replacementRaceStateDir, { recursive: true });
const replacementRacePaths = localAgentDaemonPaths(replacementRaceStateDir);
ensureLocalAgentDaemonSecret(replacementRacePaths);
let replacementRaceProtocol = 1;
const replacementRaceServer = createNetServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline)) as {
      requestId: string;
      protocolVersion: number;
      method: string;
    };
    if (request.protocolVersion !== replacementRaceProtocol) {
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: replacementRaceProtocol,
        ok: false,
        error: {
          code: "DAEMON_PROTOCOL_MISMATCH",
          message: `Unsupported daemon protocol version ${request.protocolVersion}.`,
          retryable: false,
        },
      }));
      return;
    }
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: replacementRaceProtocol,
      ok: true,
      result: {
        state: request.method === "daemon.stop" ? "stopping" : "ready",
        protocolVersion: replacementRaceProtocol,
        pid: process.pid,
        endpoint: replacementRacePaths.endpoint,
        host: { pid: process.pid, platform: "win32", windowsSessionId: 1, interactive: true },
        startedAt: "now",
        activeTurns: 0,
        runtimeCount: 0,
        clientConnections: 1,
      },
    }), () => {
      if (request.method === "daemon.stop") {
        replacementRaceProtocol = LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
      }
    });
  });
});
await new Promise<void>((resolveListen, rejectListen) => {
  replacementRaceServer.once("error", rejectListen);
  replacementRaceServer.listen(replacementRacePaths.endpoint, resolveListen);
});
const replacementRaceClient = new LocalAgentClient({
  stateDir: replacementRaceStateDir,
  startupTimeoutMs: 500,
  platform: "linux",
  requestTimeoutMs: 100,
  spawnDaemon: () => {
    throw new Error("the replacement daemon is already running");
  },
});
try {
  assert.equal(
    unwrap(await replacementRaceClient.ensureReady()).protocolVersion,
    LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  );
} finally {
  await new Promise<void>((resolveClose) => replacementRaceServer.close(() => resolveClose()));
}

const timeoutStateDir = join(root, "request-timeout-state");
await mkdir(timeoutStateDir, { recursive: true });
const timeoutPaths = localAgentDaemonPaths(timeoutStateDir);
ensureLocalAgentDaemonSecret(timeoutPaths);
const timeoutServer = createNetServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline)) as { requestId: string; method: string };
    if (request.method !== "hello") return;
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: request.requestId,
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: true,
      result: {
        state: "ready",
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        pid: process.pid,
        endpoint: timeoutPaths.endpoint,
        host: { pid: process.pid, platform: "win32", windowsSessionId: 1, interactive: true },
        startedAt: "now",
        activeTurns: 0,
        runtimeCount: 0,
        clientConnections: 1,
      },
    }));
  });
});
await new Promise<void>((resolveListen, rejectListen) => {
  timeoutServer.once("error", rejectListen);
  timeoutServer.listen(timeoutPaths.endpoint, resolveListen);
});
try {
  const timeoutClient = new LocalAgentClient({
    stateDir: timeoutStateDir,
    endpoint: timeoutPaths.endpoint,
  platform: "linux",
    requestTimeoutMs: 20,
    spawnDaemon: () => { throw new Error("existing daemon should be used"); },
  });
  const timedOut = await timeoutClient.status();
  assert.equal(timedOut.isErr(), true);
  if (timedOut.isErr()) assert.equal(timedOut.error.code, "DAEMON_TIMEOUT");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    timeoutServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

const invalidStateDir = join(root, "invalid-response-state");
await mkdir(invalidStateDir, { recursive: true });
const invalidPaths = localAgentDaemonPaths(invalidStateDir);
const invalidServer = createNetServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    if (!buffer.includes("\n")) return;
    socket.end(encodeLocalAgentDaemonResponse({
      requestId: "wrong_request_id",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: true,
      result: {},
    }));
  });
});
await new Promise<void>((resolveListen, rejectListen) => {
  invalidServer.once("error", rejectListen);
  invalidServer.listen(invalidPaths.endpoint, resolveListen);
});
try {
  const invalidClient = new LocalAgentClient({
    stateDir: invalidStateDir,
    endpoint: invalidPaths.endpoint,
  platform: "linux",
    requestTimeoutMs: 50,
    spawnDaemon: () => { throw new Error("existing daemon should be used"); },
  });
  const invalid = await invalidClient.ensureReady();
  assert.equal(invalid.isErr(), true);
  if (invalid.isErr()) assert.equal(invalid.error.code, "DAEMON_INVALID_RESPONSE");
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    invalidServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function unwrap<T, E>(result: import("better-result").Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

const socketStateDir = join(root, "socket-state");
const socketManager = new FakeManager();
socketManager.activeTurnCount = 0;
const socketDaemon = new LocalAgentDaemon({
  stateDir: socketStateDir,
  manager: socketManager,
  requestReadTimeoutMs: 30,
  shutdownTimeoutMs: 100,
  idleShutdownMs: 60_000,
});

try {
  await socketDaemon.start();
  const timedOutRequest = await sendRawRequest(socketDaemon.paths.endpoint);
  assert.equal(timedOutRequest.ok, false);
  if (!timedOutRequest.ok) {
    assert.equal(timedOutRequest.error.code, "DAEMON_TIMEOUT");
    assert.equal(timedOutRequest.error.retryable, true);
  }
  await waitFor(() => socketDaemon.status().clientConnections === 0);

  const unauthorized = await sendRawRequest(socketDaemon.paths.endpoint, JSON.stringify({
    requestId: "unauthorized",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "wrong-secret",
    method: "hello",
    params: {},
  }) + "\n");
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.error.code, "DAEMON_UNAUTHORIZED");

  const malformed = await sendRawRequest(socketDaemon.paths.endpoint, "{not-json}\n");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "DAEMON_INVALID_REQUEST");

  const oversized = await sendRawRequest(socketDaemon.paths.endpoint, "x".repeat(512 * 1024 + 1));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "DAEMON_INVALID_REQUEST");

  shutdownSocket = createConnection(socketDaemon.paths.endpoint);
  await onceSocket(shutdownSocket, "connect");
  const shutdownSocketClosed = onceSocket(shutdownSocket, "close");
  const startedAt = Date.now();
  await socketDaemon.close();
  await shutdownSocketClosed;
  assert.ok(Date.now() - startedAt < 500, "shutdown should destroy idle client sockets before closing the server");
} finally {
  shutdownSocket?.destroy();
  await socketDaemon.close();
  await rm(root, { recursive: true, force: true });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}

async function sendRawRequest(
  endpoint: string,
  payload?: string,
): Promise<RawDaemonResponse> {
  const socket = createConnection(endpoint);
  socket.setEncoding("utf8");
  const connected = onceSocket(socket, "connect");
  let buffer = "";
  const response = new Promise<RawDaemonResponse>((resolveResponse, rejectResponse) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onEnd);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as RawDaemonResponse;
        settle(() => resolveResponse(parsed));
      } catch (error) {
        settle(() => rejectResponse(error));
      }
    };
    const onError = (error: Error) => settle(() => rejectResponse(error));
    const onClose = () => settle(() => rejectResponse(
      new Error("Daemon closed the connection before returning a response."),
    ));
    const onEnd = () => settle(() => rejectResponse(
      new Error("Daemon ended the connection before returning a response."),
    ));
    const timeout = setTimeout(() => settle(() => rejectResponse(
      new Error("Daemon did not return a response within 2000ms."),
    )), 2_000);
    timeout.unref();

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onEnd);
  });
  await connected;
  if (payload !== undefined) socket.write(payload);
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

type RawDaemonResponse =
  | { ok: true }
  | { ok: false; error: { code?: string; retryable?: boolean } };

function onceSocket(
  socket: ReturnType<typeof createConnection>,
  event: "connect" | "close",
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket did not emit ${event} within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off("error", onError);
    };

    socket.once(event, onEvent);
    socket.once("error", onError);
  });
}
