import { homedir } from "node:os";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AgentProviderExecutionError,
  AgentProviderInfrastructureError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { terminateProcessTree } from "./process-platform.js";
import type { LocalAgentActivityInput } from "./local-agent-activity.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunControl,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export interface ResolvedCodexCommand {
  executable: string;
  version?: string;
}

export type CodexCommandResolver = (env: NodeJS.ProcessEnv) => ResolvedCodexCommand | undefined;
export interface CodexWindowsSandboxProbeInput {
  command: string;
  version?: string;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
}

export type CodexSandboxProbe = (input: CodexWindowsSandboxProbeInput) => Promise<void>;

const CODEX_WINDOWS_SANDBOX_PROBE_TIMEOUT_MS = 20_000;
const CODEX_SANDBOX_PROBE_MARKER = "DEVSPACE_CODEX_SANDBOX_OK";
const MAX_CODEX_DIAGNOSTIC_BYTES = 32 * 1024;
const MAX_CODEX_DIAGNOSTIC_CHARS = 1_000;
const CODEX_WINDOWS_SANDBOX_PROBE_SCRIPT = "$ErrorActionPreference='Stop'; $null = Get-Location; Write-Output 'DEVSPACE_CODEX_SANDBOX_OK'";

export function isCodexWindowsSandboxRunnerStartupFailure(text: string): boolean {
  return /timed out after \d+ms connecting runner pipe-(?:in|out)/i.test(text);
}

export async function probeCodexWindowsSandbox(
  input: CodexWindowsSandboxProbeInput,
  spawnImpl: typeof spawn = spawn,
  timeoutMs = CODEX_WINDOWS_SANDBOX_PROBE_TIMEOUT_MS,
): Promise<void> {
  const args = [
    "sandbox",
    "--permission-profile",
    ":workspace",
    "-C",
    input.workspaceRoot,
    "--",
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    CODEX_WINDOWS_SANDBOX_PROBE_SCRIPT,
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImpl(input.command, args, {
      cwd: input.workspaceRoot,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: usesWindowsCommandShell(input.command),
    });
  } catch (cause) {
    throw codexSandboxProbeError(input, "", "", undefined, cause);
  }

  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: AgentProviderInfrastructureError | AgentProviderUnavailableError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendTail(stdout, chunk.toString(), MAX_CODEX_DIAGNOSTIC_BYTES);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendTail(stderr, chunk.toString(), MAX_CODEX_DIAGNOSTIC_BYTES);
    });
    child.once("error", (cause) => {
      finish(codexSandboxProbeError(input, stdout, stderr, undefined, cause));
    });
    child.once("close", (code) => {
      if (timedOut) {
        finish(codexSandboxProbeError(input, stdout, stderr, undefined, undefined, true));
        return;
      }
      if (code === 0 && stdout.includes(CODEX_SANDBOX_PROBE_MARKER)) {
        finish();
        return;
      }
      finish(codexSandboxProbeError(input, stdout, stderr, code));
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcessTree(child, "SIGTERM", false);
      } catch {
        // The probe has already failed; cleanup errors do not change its classification.
      } finally {
        finish(codexSandboxProbeError(input, stdout, stderr, undefined, undefined, true));
      }
    }, timeoutMs);
  });
}

function codexSandboxProbeError(
  input: CodexWindowsSandboxProbeInput,
  stdout: string,
  stderr: string,
  exitCode?: number | null,
  cause?: unknown,
  timedOut = false,
): AgentProviderInfrastructureError | AgentProviderUnavailableError {
  const combined = `${stderr}\n${stdout}\n${cause === undefined ? "" : errorMessage(cause)}`;
  if (errorCode(cause) === "ENOENT") {
    return new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "codex",
      operation: "sandbox_preflight",
      retryable: false,
      cause,
      message: "Codex executable became unavailable while starting the sandbox probe.",
    });
  }
  if (isCodexWindowsSandboxRunnerStartupFailure(combined)) {
    return new AgentProviderInfrastructureError({
      code: "PROVIDER_INFRASTRUCTURE_ERROR",
      provider: "codex",
      operation: "sandbox_preflight",
      retryable: false,
      cause,
      message: [
        "Codex Windows sandbox command runner failed to start.",
        "The sandbox probe timed out while connecting to the runner pipe.",
        input.version ? `Codex version: ${input.version}` : undefined,
      ].filter(Boolean).join("\n"),
    });
  }
  if (timedOut) {
    return new AgentProviderInfrastructureError({
      code: "PROVIDER_INFRASTRUCTURE_ERROR",
      provider: "codex",
      operation: "sandbox_preflight",
      retryable: false,
      cause,
      message: [
        `Codex Windows sandbox health probe timed out after ${CODEX_WINDOWS_SANDBOX_PROBE_TIMEOUT_MS}ms.`,
        input.version ? `Codex version: ${input.version}` : undefined,
      ].filter(Boolean).join("\n"),
    });
  }
  if (exitCode === 0 && !stdout.includes(CODEX_SANDBOX_PROBE_MARKER)) {
    return new AgentProviderInfrastructureError({
      code: "PROVIDER_INFRASTRUCTURE_ERROR",
      provider: "codex",
      operation: "sandbox_preflight",
      retryable: false,
      cause,
      message: [
        "Codex Windows sandbox health probe exited successfully but did not execute the expected probe command.",
        input.version ? `Codex version: ${input.version}` : undefined,
      ].filter(Boolean).join("\n"),
    });
  }
  const diagnostic = truncateCodexDiagnostic(stderr.trim() || stdout.trim() || (cause === undefined ? "" : errorMessage(cause)));
  return new AgentProviderInfrastructureError({
    code: "PROVIDER_INFRASTRUCTURE_ERROR",
    provider: "codex",
    operation: "sandbox_preflight",
    retryable: false,
    cause,
    message: [
      "Codex Windows sandbox health probe failed before the agent turn started.",
      diagnostic ? `Diagnostic: ${diagnostic}` : undefined,
      input.version ? `Codex version: ${input.version}` : undefined,
    ].filter(Boolean).join("\n"),
  });
}

function truncateCodexDiagnostic(text: string): string {
  return text.slice(0, MAX_CODEX_DIAGNOSTIC_CHARS);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function codexCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (env.CODEX_COMMAND) return next;
  const pathKey = environmentVariableKey(next, "PATH");
  if (pathKey && next[pathKey]) {
    next[pathKey] = removeDevspaceNodeModulesBinFromPath(next[pathKey]);
  }
  return next;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): ResolvedCodexCommand | undefined {
  const command = env.CODEX_COMMAND ?? "codex";
  const probeEnv = codexCommandEnvironment(env);
  for (const candidate of commandCandidates(command, probeEnv)) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: probeEnv,
      windowsHide: true,
      timeout: 5_000,
      shell: usesWindowsCommandShell(candidate),
    });
    const code = result.error && "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT") continue;
    if (result.error || result.status !== 0) continue;
    return { executable: candidate, version: parseCodexVersion(result.stdout) };
  }
  return undefined;
}

export function isCodexAppServerSupported(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = spawnSync(command, ["app-server", "--help"], {
    encoding: "utf8",
    env: codexCommandEnvironment(env),
    windowsHide: true,
    timeout: 5_000,
    shell: usesWindowsCommandShell(command),
  });
  return result.error === undefined && result.status === 0;
}

export function parseCodexVersion(output: string | undefined): string | undefined {
  const match = output?.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

export interface CodexAppServerRuntimeOptions {
  command: string;
  env: NodeJS.ProcessEnv;
  version?: string;
}

export class CodexAppServerRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: CodexAppServerRpc;
  private alive = true;
  private closePromise?: Promise<void>;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.child = spawn(options.command, ["app-server"], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: usesWindowsCommandShell(options.command),
    });
    this.rpc = new CodexAppServerRpc(this.child, options.version);
    this.child.once("exit", (code, signal) => {
      this.alive = false;
      this.rpc.fail(new Error(
        `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
      ));
    });
    this.child.once("error", (error) => {
      this.alive = false;
      this.rpc.fail(error);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "devspace", title: "DevSpace", version: "1.0.7" },
      capabilities: {},
    });
    this.rpc.notify("initialized");
  }

  async run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
    control?: LocalAgentRunControl,
  ) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (control?.signal?.aborted) throw codexAbortError();
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "Codex app-server is not running.",
          });
        }
        const threadResponse = await this.rpc.request(
          input.providerSessionId ? "thread/resume" : "thread/start",
          threadParams(input),
        );
        const threadId = readString(asRecord(threadResponse)?.thread, "id");
        if (!threadId) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "open_thread",
            retryable: false,
            cause: threadResponse,
            message: "Codex app-server did not return a thread id.",
          });
        }

        await callbacks?.onSessionId?.(threadId);
        if (control?.signal?.aborted) throw codexAbortError();
        const completed = await this.rpc.runTurn(
          threadId,
          turnParams(input, threadId),
          control?.signal,
          callbacks?.onActivity,
        );
        const parsed = parseCompletedTurn(completed.event.params, completed.items);
        if (parsed.status === "interrupted") {
          throw codexAbortError();
        }
        if (parsed.failure) {
          throw new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            cause: completed.event.params,
            message: "Codex agent turn failed.",
          });
        }
        if (!parsed.finalResponse.trim()) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            cause: completed.event.params,
            message: "Codex did not return a final assistant response.",
          });
        }
        return {
          provider: this.provider,
          providerSessionId: threadId,
          finalResponse: parsed.finalResponse.trim(),
          items: parsed.items,
        };
      },
    });
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    if (!this.alive) return;
    try {
      await this.rpc.request("thread/unsubscribe", { threadId: providerSessionId });
    } catch {
      // Unsubscribe is an optimization; persisted thread identity remains valid.
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.alive = false;
      this.rpc.fail(new Error("codex app-server closed."));
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (this.child.exitCode === null) {
        terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
        if (!await waitForProcessExit(this.child, 1_000)) {
          terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32");
        }
      }
    })();
    return this.closePromise;
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class CodexLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "codex" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  private commandResolved = false;
  private resolvedCommand?: ResolvedCodexCommand;
  private windowsSandboxProbe?: Promise<void>;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: CodexCommandResolver = resolveCodexCommand,
    private readonly sandboxProbe: CodexSandboxProbe = probeCodexWindowsSandbox,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand();
    const executable = command?.executable ?? this.env.CODEX_COMMAND ?? "codex";
    const codexHome = resolve(this.env.CODEX_HOME ?? join(homedir(), ".codex"));
    return `codex:${executable}:${codexHome}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Codex executable was not found.",
          });
        }
        if (!isCodexAppServerSupported(command.executable, this.env)) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Installed Codex does not support app-server.",
          });
        }
        await this.ensureWindowsSandboxHealthy(command, context);
        const runtime = new CodexAppServerRuntime({
          command: command.executable,
          env: codexCommandEnvironment(this.env),
          version: command.version,
        });
        try {
          await runtime.initialize();
          return runtime;
        } catch (cause) {
          await runtime.close();
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "create_runtime",
            retryable: true,
            cause: codexAppServerError(errorMessage(cause), command.version),
            message: "Codex app-server initialization failed.",
          });
        }
      },
    });
  }

  private ensureWindowsSandboxHealthy(
    command: ResolvedCodexCommand,
    context: LocalAgentRuntimeContext,
  ): Promise<void> {
    if (this.platform !== "win32") return Promise.resolve();
    if (!this.windowsSandboxProbe) {
      this.windowsSandboxProbe = Promise.resolve().then(() => this.sandboxProbe({
        command: command.executable,
        version: command.version,
        env: codexCommandEnvironment(this.env),
        workspaceRoot: context.workspaceRoot,
      }));
    }
    return this.windowsSandboxProbe;
  }
  private resolveCommand(): ResolvedCodexCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;

interface CodexEvent {
  method: string;
  params?: unknown;
}

interface CodexTurnResult {
  event: CodexEvent;
  items: unknown[];
}

interface CodexTurnAccumulator {
  threadId: string;
  turnId?: string;
  items: unknown[];
  completed?: CodexEvent;
  abortRequested: boolean;
  interruptStarted: boolean;
  onActivity?: (activity: LocalAgentActivityInput) => void;
  lastNoisyActivityAt: number;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

class CodexAppServerRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly turns = new Map<string, CodexTurnAccumulator>();
  private nextId = 1;
  private fatalError?: Error;
  private buffer = "";
  private stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly version?: string,
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async runTurn(
    threadId: string,
    params: unknown,
    signal?: AbortSignal,
    onActivity?: (activity: LocalAgentActivityInput) => void,
  ): Promise<CodexTurnResult> {
    if (this.fatalError) throw this.fatalError;
    if (signal?.aborted) throw codexAbortError();
    if (this.turns.has(threadId)) throw new Error(`Codex thread ${threadId} already has an active turn.`);
    let resolveTurn!: (result: CodexTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: CodexTurnAccumulator = {
      threadId,
      items: [],
      abortRequested: false,
      interruptStarted: false,
      onActivity,
      lastNoisyActivityAt: 0,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.turns.set(threadId, turn);
    const onAbort = () => {
      turn.abortRequested = true;
      this.maybeInterruptTurn(turn);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const response = await this.request("turn/start", params);
      turn.turnId = readString(asRecord(response)?.turn, "id");
      this.maybeInterruptTurn(turn);
      if (turn.completed) return { event: turn.completed, items: turn.items };
      return await completion;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
    }
  }

  private maybeInterruptTurn(turn: CodexTurnAccumulator): void {
    if (!turn.abortRequested || !turn.turnId || turn.completed || turn.interruptStarted) return;
    turn.interruptStarted = true;
    void this.request("turn/interrupt", {
      threadId: turn.threadId,
      turnId: turn.turnId,
    }).catch(() => {
      // The authoritative outcome is still turn/completed; do not end the run here.
    });
  }

  fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = new Error(`${error.message}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}${this.version ? `\ncodex version: ${this.version}` : ""}`);
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    for (const turn of this.turns.values()) turn.reject(this.fatalError);
    this.pending.clear();
    this.turns.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    this.buffer += line;
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fail(new Error("codex app-server emitted malformed JSON."));
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error !== undefined) pending.reject(new Error(protocolErrorText(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (id && method) {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }
    if (!method) return;
    const event = { method, params: message.params };
    const turn = this.findTurn(event);
    if (!turn) return;
    if (!turnMatchesEvent(turn, event)) return;
    const params = asRecord(event.params);
    if (params?.item !== undefined) {
      turn.items.push(params.item);
      if (turn.items.length > MAX_TURN_ITEMS) turn.items.shift();
    }
    const activity = normalizeCodexActivity(event.method, event.params);
    if (activity && shouldEmitCodexActivity(turn, activity)) {
      try {
        turn.onActivity?.(activity);
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
    }
    if (event.method !== "turn/completed") return;
    turn.completed = event;
    turn.resolve({ event, items: turn.items.slice() });
  }

  private findTurn(event: CodexEvent): CodexTurnAccumulator | undefined {
    const params = asRecord(event.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params?.turnId === "string"
      ? params.turnId
      : readString(asRecord(params?.turn), "id");
    if (threadId) return this.turns.get(threadId);
    if (!turnId) return undefined;
    return Array.from(this.turns.values()).find((turn) => turn.turnId === turnId);
  }
}

export function normalizeCodexActivity(
  method: string,
  params: unknown,
): LocalAgentActivityInput | undefined {
  const record = asRecord(params);
  const turnId = typeof record?.turnId === "string"
    ? record.turnId
    : readString(asRecord(record?.turn), "id");
  const item = asRecord(record?.item);
  const providerAt = providerTimestamp(record, item);
  const itemType = normalizeCodexItemType(item?.type);
  const itemId = typeof record?.itemId === "string"
    ? record.itemId
    : readString(item, "id");

  if (method === "turn/started") {
    return activity("progress", "turn_started", "started", turnId, undefined, providerAt);
  }
  if (method === "turn/completed") {
    const status = readString(asRecord(record?.turn), "status");
    return activity(
      "status",
      "turn_completed",
      status === "failed" ? "failed" : status === "interrupted" ? "cancelled" : "completed",
      turnId,
      undefined,
      providerAt,
    );
  }

  if (method === "turn/diff/updated") {
    return activity("edit", "diff_updated", "updated", turnId, undefined, providerAt);
  }
  if (method === "turn/plan/updated") {
    return activity("progress", "plan_updated", "updated", turnId, undefined, providerAt);
  }
  if (method === "thread/tokenUsage/updated") {
    return activity("progress", "token_usage_updated", "updated", turnId, undefined, providerAt);
  }
  if (method === "model/safetyBuffering/updated") {
    return activity("progress", "safety_buffer_updated", "updated", turnId, undefined, providerAt);
  }
  if (method === "warning") {
    return activity("status", "warning", "updated", turnId, undefined, providerAt);
  }
  if (method === "error") {
    return activity("status", "provider_error", "failed", turnId, undefined, providerAt);
  }

  if (method === "item/started" || method === "item/completed") {
    if (!itemType) return undefined;
    return itemActivity(itemType, method === "item/started" ? "started" : "completed", turnId, itemId, item, providerAt);
  }

  const delta = deltaActivity(method, turnId, itemId, providerAt);
  if (delta) return delta;
  return undefined;
}

function itemActivity(
  itemType: string,
  status: LocalAgentActivityInput["status"],
  turnId: string | undefined,
  itemId: string | undefined,
  item: Record<string, unknown> | undefined,
  providerAt: string | undefined,
): LocalAgentActivityInput | undefined {
  switch (itemType) {
    case "commandExecution":
      return activity("command", "command_execution", status, turnId, itemId, providerAt);
    case "fileChange": {
      const changes = item?.changes;
      return {
        ...activity("edit", "file_change", status, turnId, itemId, providerAt),
        ...(Array.isArray(changes) ? { pathCount: changes.length } : {}),
      };
    }
    case "agentMessage":
      return activity("assistant", "assistant_message", status, turnId, itemId, providerAt);
    case "webSearch":
      return activity("search", "web_search", status, turnId, itemId, providerAt);
    case "fileRead":
      return activity("read", "file_read", status, turnId, itemId, providerAt);
    default:
      return undefined;
  }
}

function deltaActivity(
  method: string,
  turnId: string | undefined,
  itemId: string | undefined,
  providerAt: string | undefined,
): LocalAgentActivityInput | undefined {
  const status = method.endsWith("/started")
    ? "started"
    : method.endsWith("/completed")
      ? "completed"
      : "updated";
  if (method.includes("agentMessage/delta")) {
    return activity("assistant", "assistant_delta", "updated", turnId, itemId, providerAt);
  }
  if (method.includes("agentMessage/") || method.includes("agent_message/")) {
    return activity("assistant", "assistant_updated", status, turnId, itemId, providerAt);
  }
  if (method.includes("commandExecution/") || method.includes("command_execution/")) {
    return activity("command", "command_updated", status, turnId, itemId, providerAt);
  }
  if (method.includes("fileChange/") || method.includes("file_change/")) {
    return activity("edit", "file_change_updated", status, turnId, itemId, providerAt);
  }
  if (method.includes("webSearch/") || method.includes("web_search/")) {
    return activity("search", "web_search_updated", status, turnId, itemId, providerAt);
  }
  if (method.includes("fileRead/") || method.includes("file_read/")) {
    return activity("read", "file_read_updated", status, turnId, itemId, providerAt);
  }
  if (method.includes("reasoning/") || method.includes("plan/") || method.includes("mcpToolCall/")) {
    return activity("progress", "provider_progress", "updated", turnId, itemId, providerAt);
  }
  return undefined;
}

function activity(
  category: LocalAgentActivityInput["category"],
  kind: string,
  status: LocalAgentActivityInput["status"],
  turnId: string | undefined,
  itemId: string | undefined,
  providerAt: string | undefined,
): LocalAgentActivityInput {
  return {
    category,
    kind,
    ...(status === undefined ? {} : { status }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(providerAt === undefined ? {} : { providerAt }),
  };
}

function normalizeCodexItemType(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  switch (value) {
    case "agent_message": return "agentMessage";
    case "command_execution": return "commandExecution";
    case "file_change": return "fileChange";
    case "web_search": return "webSearch";
    case "search": return "webSearch";
    case "file_read":
    case "read": return "fileRead";
    default: return value;
  }
}

function providerTimestamp(
  params: Record<string, unknown> | undefined,
  item: Record<string, unknown> | undefined,
): string | undefined {
  const values = [
    params?.timestamp,
    asRecord(params?.turn)?.timestamp,
    item?.timestamp,
  ];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function shouldEmitCodexActivity(
  turn: CodexTurnAccumulator,
  activity: LocalAgentActivityInput,
): boolean {
  const noisy = activity.kind.includes("delta")
    || activity.kind.includes("updated")
    || activity.kind === "provider_progress";
  if (!noisy) return true;
  const now = Date.now();
  if (now - turn.lastNoisyActivityAt < 500) return false;
  turn.lastNoisyActivityAt = now;
  return true;
}

function threadParams(input: LocalAgentRunInput): Record<string, unknown> {
  return {
    ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
    cwd: input.workspaceRoot,
    approvalPolicy: "never",
    sandbox: sandboxFor(input.writeMode),
    ...(input.model ? { model: input.model } : {}),
  };
}

function turnParams(input: LocalAgentRunInput, threadId: string): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicyFor(input.writeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
}

export function sandboxFor(writeMode: LocalAgentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed": return "workspace-write";
    case "full_access": return "danger-full-access";
    case "read_only":
    case undefined: return "read-only";
  }
}

function sandboxPolicyFor(writeMode: LocalAgentWriteMode | undefined): Record<string, string> {
  switch (writeMode) {
    case "allowed": return { type: "workspaceWrite" };
    case "full_access": return { type: "dangerFullAccess" };
    case "read_only":
    case undefined: return { type: "readOnly" };
  }
}

function parseCompletedTurn(params: unknown, items: unknown[]): {
  status?: string;
  finalResponse: string;
  items: unknown[];
  failure?: string;
} {
  const turn = asRecord(asRecord(params)?.turn);
  const turnItems = Array.isArray(turn?.items) ? turn.items : [];
  const completedItems = (turnItems.length > 0 ? turnItems : items).slice(-MAX_TURN_ITEMS);
  let finalResponse = "";
  for (const item of completedItems) {
    const record = asRecord(item);
    if (!record) continue;
    const type = record.type;
    if ((type === "agentMessage" || type === "agent_message") && typeof record.text === "string") {
      finalResponse = record.text;
    }
  }
  const status = typeof turn?.status === "string" ? turn.status : undefined;
  const error = asRecord(turn?.error);
  const failure = status === "failed"
    ? directString(error?.message) ?? "Codex turn failed."
    : undefined;
  return { status, finalResponse, items: completedItems, failure };
}

function codexAbortError(): Error {
  const error = new Error("Codex agent turn was cancelled.");
  error.name = "AbortError";
  return error;
}

export function codexAppServerError(message: string, version?: string, stderr?: string): Error {
  return new Error([
    message,
    version ? `codex version: ${version}` : undefined,
    stderr?.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n"));
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || command.includes("\\") || /\.(?:cmd|bat|exe|com)$/i.test(command)) return [command];
  const pathKey = environmentVariableKey(env, "PATH");
  const path = pathKey ? env[pathKey] : undefined;
  if (!path) return [command];
  const extensions = process.platform === "win32"
    ? (environmentVariableValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return path.split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => resolve(directory, `${command}${extension}`)));
}

function environmentVariableKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name)) return name;
  if (process.platform !== "win32") return undefined;
  const normalized = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === normalized);
}

function environmentVariableValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = environmentVariableKey(env, name);
  return key ? env[key] : undefined;
}

function usesWindowsCommandShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function turnMatchesEvent(turn: CodexTurnAccumulator, event: CodexEvent): boolean {
  const params = asRecord(event.params);
  const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const eventTurnId = typeof params?.turnId === "string"
    ? params.turnId
    : readString(asRecord(params?.turn), "id");
  if (eventThreadId && eventThreadId !== turn.threadId) return false;
  if (turn.turnId && eventTurnId && turn.turnId !== eventTurnId) return false;
  return eventThreadId === turn.threadId || Boolean(turn.turnId && eventTurnId === turn.turnId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function protocolErrorText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return String(value);
  const message = directString(record.message);
  const code = record.code;
  return message ? `codex app-server${code === undefined ? "" : ` ${String(code)}`}: ${message}` : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTail(value: string, chunk: string, maxBytes: number): string {
  const next = value + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
