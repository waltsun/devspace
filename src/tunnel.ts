import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ResolvedTunnelConfig } from "./config.js";
import type { TunnelProvider } from "./user-config.js";

const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const NGROK_REQUEST_TIMEOUT_MS = 1_000;

type ManagedProvider = Exclude<TunnelProvider, "manual">;

export interface ManagedTunnel {
  provider: ManagedProvider;
  publicUrl: string;
  child: ChildProcess;
  command: string;
  args: string[];
  close(): Promise<void>;
  stop(): Promise<void>;
  onExit(listener: (error: Error) => void): void;
}

type SpawnTunnelProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface TunnelStartOptions {
  spawn?: SpawnTunnelProcess;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

/** Start a configured tunnel. Manual mode deliberately starts no child process. */
export async function startTunnel(
  config: ResolvedTunnelConfig,
  port: number,
  options: TunnelStartOptions = {},
): Promise<ManagedTunnel | undefined> {
  if (config.provider === "manual") return undefined;

  validatePort(port);
  const startupTimeoutMs = positiveDuration(
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    "Tunnel startup timeout",
  );
  const pollIntervalMs = positiveDuration(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "Tunnel poll interval",
  );
  const shutdownTimeoutMs = nonNegativeDuration(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "Tunnel shutdown timeout",
  );
  const command = tunnelCommand(config.provider, port);

  let child: ChildProcess;
  try {
    child = (options.spawn ?? defaultSpawn)(command.command, command.args, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw tunnelStartupError(config.provider, `could not spawn ${command.command}: ${errorMessage(error)}`, error);
  }

  const managed = createManagedTunnel(config.provider, command, child, shutdownTimeoutMs);
  if (config.provider === "ngrok") drainChildOutput(child);

  try {
    const publicUrl = config.provider === "ngrok"
      ? await waitForNgrokUrl(
        child,
        port,
        options.fetch ?? globalThis.fetch,
        startupTimeoutMs,
        pollIntervalMs,
        options.sleep,
        managed.childStopped,
      )
      : await waitForOutputUrl(child, startupTimeoutMs, managed.childStopped);

    managed.publicUrl = publicUrl;
    drainChildOutput(child);
    return managed;
  } catch (error) {
    await managed.stop().catch(() => undefined);
    throw tunnelStartupError(config.provider, errorMessage(error), error);
  }
}

export function extractHttpsUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/[^\s"'<>]+/i);
  if (!match) return undefined;

  const candidate = match[0].replace(/[),.;]+$/g, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || !parsed.hostname) return undefined;
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function selectNgrokPublicUrl(payload: unknown, port: number): string | undefined {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { tunnels?: unknown }).tunnels)) {
    return undefined;
  }

  const tunnels = (payload as { tunnels: unknown[] }).tunnels.filter(
    (tunnel): tunnel is Record<string, unknown> => (
      Boolean(tunnel) && typeof tunnel === "object" && !Array.isArray(tunnel)
    ),
  );
  const httpsTunnels = tunnels.filter((tunnel) => extractHttpsUrl(String(tunnel.public_url ?? "")));
  const matchingTunnel = httpsTunnels.find((tunnel) => tunnelTargetsPort(tunnel.config, port));
  const selected = matchingTunnel ?? httpsTunnels[0];
  return selected ? extractHttpsUrl(String(selected.public_url ?? "")) : undefined;
}

function tunnelCommand(provider: ManagedProvider, port: number): { command: string; args: string[] } {
  switch (provider) {
    case "ngrok":
      return { command: "ngrok", args: ["http", String(port)] };
    case "cloudflared":
      return {
        command: "cloudflared",
        args: ["tunnel", "--url", `http://127.0.0.1:${port}`],
      };
    case "localtunnel":
      return {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: ["localtunnel", "--port", String(port)],
      };
  }
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return nodeSpawn(command, args, options);
}

interface ManagedTunnelInternals extends ManagedTunnel {
  childStopped: Promise<never>;
}

function createManagedTunnel(
  provider: ManagedProvider,
  command: { command: string; args: string[] },
  child: ChildProcess,
  shutdownTimeoutMs: number,
): ManagedTunnelInternals {
  let intentionalStop = false;
  let exited = false;
  let exitError: Error | undefined;
  let resolveExit!: () => void;
  let rejectChildStopped!: (error: Error) => void;
  let stopPromise: Promise<void> | undefined;

  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const childStopped = new Promise<never>((_, reject) => {
    rejectChildStopped = reject;
  });
  childStopped.catch(() => undefined);
  const listeners: Array<(error: Error) => void> = [];

  const handleExit = (error: Error): void => {
    if (exited) return;
    exited = true;
    exitError = error;
    resolveExit();
    if (!intentionalStop) {
      rejectChildStopped(error);
      for (const listener of listeners) listener(error);
    }
  };

  child.once("error", (error) => {
    handleExit(new Error(`Tunnel process failed: ${error.message}`, { cause: error }));
  });
  child.once("exit", (code, signal) => {
    handleExit(new Error(
      `Tunnel process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`,
    ));
  });

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      intentionalStop = true;
      if (exited) return;

      killChild(child, "SIGTERM", provider);
      await waitForExit(exitPromise, shutdownTimeoutMs);
      if (exited) return;

      killChild(child, "SIGKILL", provider);
      await waitForExit(exitPromise, shutdownTimeoutMs);
      if (!exited) throw new Error(`Unable to terminate ${provider} tunnel process.`);
    })();
    return stopPromise;
  };

  return {
    provider,
    publicUrl: "",
    child,
    command: command.command,
    args: [...command.args],
    close: stop,
    stop,
    onExit: (listener) => {
      if (exitError && !intentionalStop) {
        queueMicrotask(() => listener(exitError!));
        return;
      }
      if (!intentionalStop) listeners.push(listener);
    },
    childStopped,
  };
}

async function waitForOutputUrl(
  child: ChildProcess,
  startupTimeoutMs: number,
  childStopped: Promise<never>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finishReject(new Error(`did not emit a public HTTPS URL within ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
    };
    const finishResolve = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onOutput = (chunk: string | Buffer): void => {
      output += chunk.toString();
      const url = extractHttpsUrl(output);
      if (url) finishResolve(url);
    };

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    childStopped.catch(finishReject);
  });
}

async function waitForNgrokUrl(
  child: ChildProcess,
  port: number,
  fetchImpl: typeof globalThis.fetch | undefined,
  startupTimeoutMs: number,
  pollIntervalMs: number,
  sleep: ((milliseconds: number) => Promise<void>) | undefined,
  childStopped: Promise<never>,
): Promise<string> {
  if (!fetchImpl) throw new Error("The Node runtime does not provide fetch for the ngrok API.");

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const url = await Promise.race([
      fetchNgrokUrl(fetchImpl, port, Math.min(NGROK_REQUEST_TIMEOUT_MS, remaining)),
      childStopped,
    ]);
    if (url) return url;

    const waitMs = Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()));
    if (sleep) {
      await waitForRetry(sleep, waitMs, childStopped);
    } else {
      await Promise.race([delay(waitMs), childStopped]);
    }
  }

  throw new Error(`ngrok API did not expose a public HTTPS URL within ${startupTimeoutMs}ms`);
}

async function fetchNgrokUrl(
  fetchImpl: typeof globalThis.fetch,
  port: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let requestTimeout: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(NGROK_API_URL, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        requestTimeout = setTimeout(() => reject(new Error("ngrok API request timed out")), timeoutMs);
      }),
    ]);
    if (!response.ok) return undefined;
    return selectNgrokPublicUrl(await response.json(), port);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    if (requestTimeout) clearTimeout(requestTimeout);
  }
}

function tunnelTargetsPort(value: unknown, port: number): boolean {
  if (!value || typeof value !== "object") return false;
  const address = (value as { addr?: unknown }).addr;
  if (typeof address !== "string") return false;
  try {
    const parsed = new URL(address.includes("://") ? address : `http://${address}`);
    return parsed.port === String(port);
  } catch {
    return address.includes(`:${port}`);
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid tunnel port: ${port}`);
  }
}

async function waitForRetry(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  childStopped: Promise<never>,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const boundedSleep = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([sleep(milliseconds), boundedSleep, childStopped]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function drainChildOutput(child: ChildProcess): void {
  child.stdout?.resume();
  child.stderr?.resume();
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite duration.`);
  return value;
}

function nonNegativeDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite duration.`);
  return value;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals, provider: ManagedProvider): void {
  try {
    child.kill(signal);
  } catch (error) {
    throw new Error(`Unable to stop ${provider} tunnel process: ${errorMessage(error)}`, { cause: error });
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

function tunnelStartupError(provider: ManagedProvider, reason: string, cause: unknown): Error {
  return new Error(`Unable to start ${provider} tunnel: ${reason}`, { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
