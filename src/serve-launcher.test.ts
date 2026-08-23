import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  prepareServe,
  type AgentHostProbe,
} from "./serve-launcher.js";
import type { LocalAgentDaemonStatus } from "./local-agent-daemon-protocol.js";
import type { ManagedTunnel } from "./tunnel.js";

class FakeChild extends EventEmitter {
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly pid = 4321;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedSignals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeChildProcess(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

function hostStatus(sessionId = 2): LocalAgentDaemonStatus {
  return {
    state: "ready",
    protocolVersion: 6,
    pid: 4321,
    endpoint: "test-agent-host",
    host: {
      pid: 4321,
      platform: "win32",
      windowsSessionId: sessionId,
      interactive: sessionId > 0,
    },
    startedAt: "now",
    activeTurns: 0,
    runtimeCount: 0,
    clientConnections: 1,
  };
}

function baseConfig(): ServerConfig {
  return loadConfig({
    DEVSPACE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "devspace-serve-launcher-config-")),
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
}

function fakeTunnel(publicUrl: string, events: string[]): ManagedTunnel {
  const child = new FakeChild();
  return {
    provider: "cloudflared",
    publicUrl,
    child: fakeChildProcess(child),
    command: "cloudflared",
    args: [],
    stop: async () => { events.push("tunnel"); },
    close: async () => { events.push("tunnel"); },
    onExit: () => undefined,
  };
}

const reusedConfig = { ...baseConfig(), subagents: { enabled: true, providers: [] } };
let reuseSpawnCount = 0;
let reuseSessionLookups = 0;
const reuseOrder: string[] = [];
const reused = await prepareServe({
  platform: "win32",
  loadConfig: () => reusedConfig,
  createAgentHostProbe: (): AgentHostProbe => ({
    status: async () => {
      reuseOrder.push("agent-host");
      return hostStatus(4);
    },
  }),
  getCurrentWindowsSessionId: () => (reuseSessionLookups += 1, 4),
  spawnAgentHost: () => {
    reuseSpawnCount += 1;
    throw new Error("reused host must not spawn");
  },
  startTunnel: async () => {
    reuseOrder.push("tunnel");
    return undefined;
  },
});
assert.equal(reused.agentHost, undefined, "a valid interactive host is reused");
assert.equal(reuseSpawnCount, 0);
assert.equal(reuseSessionLookups, 0, "the current session is not needed when reusing a host");
assert.deepEqual(reuseOrder, ["agent-host", "tunnel"]);
await reused.closeChildren();

const spawnedConfig = { ...baseConfig(), subagents: { enabled: true, providers: [] } };
const spawnedChild = new FakeChild();
let spawnedStatusChecks = 0;
let spawnedCount = 0;
const spawned = await prepareServe({
  platform: "win32",
  loadConfig: () => spawnedConfig,
  createAgentHostProbe: (): AgentHostProbe => ({
    status: async () => {
      spawnedStatusChecks += 1;
      return spawnedStatusChecks === 1 ? undefined : hostStatus(3);
    },
  }),
  getCurrentWindowsSessionId: () => 3,
  spawnAgentHost: () => {
    spawnedCount += 1;
    return fakeChildProcess(spawnedChild);
  },
  startupTimeoutMs: 100,
  pollIntervalMs: 1,
  sleep: async () => undefined,
  startTunnel: async () => undefined,
});
assert.ok(spawned.agentHost, "an absent host is spawned in an interactive session");
assert.equal(spawnedCount, 1);
await spawned.closeChildren();
assert.deepEqual(spawnedChild.killedSignals, ["SIGTERM"]);

let sessionZeroSpawnCount = 0;
await assert.rejects(
  prepareServe({
    platform: "win32",
    loadConfig: () => spawnedConfig,
    createAgentHostProbe: (): AgentHostProbe => ({ status: async () => undefined }),
    getCurrentWindowsSessionId: () => 0,
    spawnAgentHost: () => {
      sessionZeroSpawnCount += 1;
      return fakeChildProcess(new FakeChild());
    },
  }),
  /DevSpace agent host must run in an interactive Windows session.*Current Windows session: 0/s,
);
assert.equal(sessionZeroSpawnCount, 0, "Session 0 never spawns agentd");

const tunnelEvents: string[] = [];
const tunnelConfigEnv = {
  DEVSPACE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "devspace-serve-launcher-tunnel-config-")),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};
const tunnelConfig = loadConfig(tunnelConfigEnv);
const finalEnvironments: NodeJS.ProcessEnv[] = [];
const configuredTunnel = await prepareServe({
  env: { ...tunnelConfigEnv, DEVSPACE_PUBLIC_BASE_URL: "https://old.example" },
  loadConfig: (env) => {
    finalEnvironments.push(env ?? {});
    return loadConfig({ ...tunnelConfigEnv, ...env });
  },
  startTunnel: async () => fakeTunnel("https://managed.example", tunnelEvents),
});
assert.equal(configuredTunnel.config.publicBaseUrl, "https://managed.example");
assert.ok(configuredTunnel.config.allowedHosts.includes("managed.example"));
assert.equal(finalEnvironments.length, 2);
assert.equal(finalEnvironments[1]?.DEVSPACE_PUBLIC_BASE_URL, "https://managed.example");
await configuredTunnel.closeChildren();
assert.deepEqual(tunnelEvents, ["tunnel"]);
