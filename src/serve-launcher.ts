import type { ChildProcess } from "node:child_process";
import { LocalAgentClient, spawnPersistentAgentHost } from "./local-agent-client.js";
import {
  getCurrentWindowsSessionId,
  assertInteractiveWindowsSession,
} from "./windows-session.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  startTunnel,
  type ManagedTunnel,
  type TunnelStartOptions,
} from "./tunnel.js";
import type { LocalAgentDaemonStatus } from "./local-agent-daemon-protocol.js";

const DEFAULT_AGENT_HOST_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_AGENT_HOST_POLL_INTERVAL_MS = 100;
const AGENT_HOST_REQUEST_TIMEOUT_MS = 1_000;

export interface AgentHostProbe {
  status(): Promise<LocalAgentDaemonStatus | undefined>;
}

export interface OwnedAgentHost {
  child: ChildProcess;
  stop(): Promise<void>;
  onExit(listener: (error: Error) => void): void;
}

export interface PreparedServe {
  config: ServerConfig;
  tunnel?: ManagedTunnel;
  agentHost?: OwnedAgentHost;
  closeChildren(): Promise<void>;
}

export interface PrepareServeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  loadConfig?: (env?: NodeJS.ProcessEnv) => ServerConfig;
  startTunnel?: typeof startTunnel;
  tunnelOptions?: TunnelStartOptions;
  createAgentHostProbe?: (config: ServerConfig) => AgentHostProbe;
  getCurrentWindowsSessionId?: () => number;
  spawnAgentHost?: () => ChildProcess;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function prepareServe(options: PrepareServeOptions = {}): Promise<PreparedServe> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const load = options.loadConfig ?? loadConfig;
  const initialConfig = load(env);
  let agentHost: OwnedAgentHost | undefined;
  let tunnel: ManagedTunnel | undefined;

  const closeChildren = createChildrenCloser(() => tunnel, () => agentHost);

  try {
    if (platform === "win32" && initialConfig.subagents.enabled) {
      agentHost = await ensureWindowsAgentHost(initialConfig, {
        createProbe: options.createAgentHostProbe,
        getCurrentWindowsSessionId: options.getCurrentWindowsSessionId ?? getCurrentWindowsSessionId,
        spawnAgentHost: options.spawnAgentHost ?? (() => spawnPersistentAgentHost(env)),
        startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_AGENT_HOST_STARTUP_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? DEFAULT_AGENT_HOST_POLL_INTERVAL_MS,
        sleep: options.sleep,
      });
    }

    tunnel = await (options.startTunnel ?? startTunnel)(
      initialConfig.tunnel,
      initialConfig.port,
      options.tunnelOptions,
    );

    const finalConfig = tunnel
      ? load({ ...env, DEVSPACE_PUBLIC_BASE_URL: tunnel.publicUrl })
      : initialConfig;
    return { config: finalConfig, tunnel, agentHost, closeChildren };
  } catch (error) {
    await closeChildren().catch(() => undefined);
    throw error;
  }
}

interface AgentHostStartupOptions {
  createProbe?: (config: ServerConfig) => AgentHostProbe;
  getCurrentWindowsSessionId: () => number;
  spawnAgentHost: () => ChildProcess;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function ensureWindowsAgentHost(
  config: ServerConfig,
  options: AgentHostStartupOptions,
): Promise<OwnedAgentHost | undefined> {
  const probe = options.createProbe?.(config) ?? createDefaultAgentHostProbe(config, options.startupTimeoutMs);
  const existing = await probe.status();
  if (isValidInteractiveWindowsHost(existing)) return undefined;

  assertInteractiveWindowsSession(options.getCurrentWindowsSessionId());

  let child: ChildProcess;
  try {
    child = options.spawnAgentHost();
  } catch (cause) {
    throw new Error(`Unable to start the Windows agent host child: ${errorMessage(cause)}`, { cause });
  }

  const owned = createOwnedAgentHost(child, options.startupTimeoutMs);
  try {
    await waitForAgentHostReady(probe, owned.childStopped, {
      startupTimeoutMs: options.startupTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      sleep: options.sleep,
    });
    return owned;
  } catch (cause) {
    await owned.stop().catch(() => undefined);
    throw new Error(`Unable to start the Windows agent host: ${errorMessage(cause)}`, { cause });
  }
}

function createDefaultAgentHostProbe(
  config: ServerConfig,
  startupTimeoutMs: number,
): AgentHostProbe {
  const client = new LocalAgentClient({
    stateDir: config.stateDir,
    platform: "win32",
    requestTimeoutMs: Math.min(AGENT_HOST_REQUEST_TIMEOUT_MS, startupTimeoutMs),
  });
  return {
    async status(): Promise<LocalAgentDaemonStatus | undefined> {
      const result = await client.status();
      return result.isOk() ? result.value : undefined;
    },
  };
}

interface OwnedAgentHostInternals extends OwnedAgentHost {
  childStopped: Promise<never>;
}

function createOwnedAgentHost(child: ChildProcess, shutdownTimeoutMs: number): OwnedAgentHostInternals {
  let intentionalStop = false;
  let exited = false;
  let exitError: Error | undefined;
  let resolveExit!: () => void;
  let rejectChildStopped!: (error: Error) => void;
  let stopPromise: Promise<void> | undefined;
  const listeners: Array<(error: Error) => void> = [];
  const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
  const childStopped = new Promise<never>((_, reject) => { rejectChildStopped = reject; });
  childStopped.catch(() => undefined);

  const handleExit = (error: Error): void => {
    if (exited) return;
    exited = true;
    exitError = error;
    resolveExit();
    if (intentionalStop) return;
    rejectChildStopped(error);
    for (const listener of listeners) listener(error);
  };

  child.once("error", (error) => {
    handleExit(new Error(`Agent host process failed: ${error.message}`, { cause: error }));
  });
  child.once("exit", (code, signal) => {
    handleExit(new Error(
      `Agent host process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`,
    ));
  });

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      intentionalStop = true;
      if (exited) return;
      killAgentHost(child);
      await waitForExit(exitPromise, shutdownTimeoutMs);
      if (exited) return;
      killAgentHost(child, "SIGKILL");
      await waitForExit(exitPromise, shutdownTimeoutMs);
      if (!exited) throw new Error("Unable to terminate the Windows agent host child.");
    })();
    return stopPromise;
  };

  return {
    child,
    stop,
    onExit: (listener) => {
      if (exitError && !intentionalStop) {
        queueMicrotask(() => listener(exitError!));
      } else if (!intentionalStop) {
        listeners.push(listener);
      }
    },
    childStopped,
  };
}

interface AgentHostReadyOptions {
  startupTimeoutMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function waitForAgentHostReady(
  probe: AgentHostProbe,
  childStopped: Promise<never>,
  options: AgentHostReadyOptions,
): Promise<void> {
  const deadline = Date.now() + options.startupTimeoutMs;
  while (Date.now() < deadline) {
    const status = await Promise.race([probe.status(), childStopped]);
    if (isValidInteractiveWindowsHost(status)) return;

    const waitMs = Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now()));
    if (options.sleep) {
      await boundedSleep(options.sleep, waitMs, childStopped);
    } else {
      await Promise.race([delay(waitMs), childStopped]);
    }
  }
  throw new Error(`did not expose a valid interactive Windows agent host within ${options.startupTimeoutMs}ms`);
}

function isValidInteractiveWindowsHost(status: LocalAgentDaemonStatus | undefined): boolean {
  return Boolean(
    status
    && status.state === "ready"
    && status.host.platform === "win32"
    && status.host.windowsSessionId !== null
    && status.host.windowsSessionId > 0
    && status.host.interactive === true,
  );
}

function createChildrenCloser(
  getTunnel: () => ManagedTunnel | undefined,
  getAgentHost: () => OwnedAgentHost | undefined,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      try {
        await getTunnel()?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await getAgentHost()?.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to stop DevSpace child processes.");
      }
    })();
    return closePromise;
  };
}

function killAgentHost(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    child.kill(signal);
  } catch (cause) {
    throw new Error(`Unable to stop the Windows agent host child: ${errorMessage(cause)}`, { cause });
  }
}

async function boundedSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  childStopped: Promise<never>,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([sleep(milliseconds), timeoutPromise, childStopped]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs === 0) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    void exitPromise.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
