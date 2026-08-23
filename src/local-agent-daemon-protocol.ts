import type {
  LocalAgentRecord,
  LocalAgentStatus,
  LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  readActivityEvents,
  type LocalAgentActivityEvent,
} from "./local-agent-activity.js";
import type {
  AgentWaitResult,
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";
import {
  DEFAULT_AGENT_WAIT_TIMEOUT_MS,
  MAX_AGENT_WAIT_TIMEOUT_MS,
} from "./local-agent-manager.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

export type LocalAgentDaemonMethod =
  | "hello"
  | "agent.start"
  | "agent.continue"
  | "agent.get"
  | "agent.cancel"
  | "agent.wait"
  | "agent.list"
  | "daemon.status"
  | "daemon.stop"
  | "daemon.logs";

export type LocalAgentDaemonRequest =
  | AgentDaemonRequestBase<"hello", Record<string, never>>
  | AgentDaemonRequestBase<"agent.start", StartLocalAgentInput>
  | AgentDaemonRequestBase<"agent.continue", { id: string; prompt: string; scope: LocalAgentWorkspaceScope; overrides?: RunOverrides }>
  | AgentDaemonRequestBase<"agent.get", { id: string; scope: LocalAgentWorkspaceScope }>
  | AgentDaemonRequestBase<"agent.cancel", { id: string; scope: LocalAgentWorkspaceScope }>
  | AgentDaemonRequestBase<"agent.wait", { id: string; scope: LocalAgentWorkspaceScope; timeoutMs: number; afterSequence?: number }>
  | AgentDaemonRequestBase<"agent.list", LocalAgentWorkspaceScope>
  | AgentDaemonRequestBase<"daemon.status", Record<string, never>>
  | AgentDaemonRequestBase<"daemon.stop", Record<string, never>>
  | AgentDaemonRequestBase<"daemon.logs", { lines?: number }>;

interface AgentDaemonRequestBase<
  M extends LocalAgentDaemonMethod,
  P,
> {
  requestId: string;
  protocolVersion: number;
  authToken: string;
  method: M;
  params: P;
}

export interface LocalAgentDaemonHost {
  pid: number;
  platform: NodeJS.Platform;
  windowsSessionId: number | null;
  interactive: boolean | null;
}
export interface LocalAgentDaemonStatus {
  state: "ready" | "stopping";
  protocolVersion: number;
  pid: number;
  endpoint: string;
  host: LocalAgentDaemonHost;
  startedAt: string;
  activeTurns: number;
  runtimeCount: number;
  clientConnections: number;
}

export interface LocalAgentDaemonErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  provider?: string;
  agentId?: string;
  workspaceId?: string;
  operation?: string;
  target?: string;
}

export type LocalAgentDaemonResponse =
  | {
      requestId: string;
      protocolVersion: number;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      protocolVersion: number;
      ok: false;
      error: LocalAgentDaemonErrorPayload;
    };

export function encodeLocalAgentDaemonRequest(request: LocalAgentDaemonRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeLocalAgentDaemonResponse(response: LocalAgentDaemonResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function decodeLocalAgentDaemonRequest(value: unknown): LocalAgentDaemonRequest {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  const authToken = requiredString(record?.authToken, "authToken");
  const method = requiredString(record?.method, "method") as LocalAgentDaemonMethod;
  const params = record?.params;

  switch (method) {
    case "hello":
    case "daemon.status":
    case "daemon.stop":
      return { requestId, protocolVersion, authToken, method, params: decodeEmptyParams(params) } as LocalAgentDaemonRequest;
    case "agent.start":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeStartInput(params),
      } as LocalAgentDaemonRequest;
    case "agent.continue":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeContinueInput(params),
      } as LocalAgentDaemonRequest;
    case "agent.get":
    case "agent.cancel":
      return {
        requestId,
        protocolVersion,
        method,
        authToken,
        params: decodeAgentScopedIdParams(params),
      } as LocalAgentDaemonRequest;
    case "agent.wait": {
      const record = asRecord(params);
      return {
        requestId,
        protocolVersion,
        method,
        authToken,
        params: {
          ...decodeAgentScopedIdParams(params),
          timeoutMs: decodeWaitTimeoutMs(record?.timeoutMs),
          ...(record?.afterSequence === undefined
            ? {}
            : { afterSequence: decodeActivityCursor(record.afterSequence) }),
        },
      } as LocalAgentDaemonRequest;
    }
    case "agent.list":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeListScope(params),
      } as LocalAgentDaemonRequest;
    case "daemon.logs":
      return {
        requestId,
        protocolVersion,
        authToken,
        method,
        params: decodeLogsParams(params),
      } as LocalAgentDaemonRequest;
    default:
      throw new LocalAgentDaemonProtocolError("UNKNOWN_METHOD", `Unknown daemon method: ${method}`);
  }
}

export function decodeLocalAgentDaemonResponse(value: unknown): LocalAgentDaemonResponse {
  const record = asRecord(value);
  const requestId = requiredString(record?.requestId, "requestId");
  const protocolVersion = requiredInteger(record?.protocolVersion, "protocolVersion");
  if (record?.ok === true) {
    return { requestId, protocolVersion, ok: true, result: record.result };
  }
  if (record?.ok === false) {
    const error = asRecord(record.error);
    return {
      requestId,
      protocolVersion,
      ok: false,
      error: {
        code: requiredString(error?.code, "error.code"),
        message: requiredString(error?.message, "error.message"),
        retryable: optionalBoolean(error?.retryable),
        provider: optionalString(error?.provider),
        agentId: optionalString(error?.agentId),
        workspaceId: optionalString(error?.workspaceId),
        operation: optionalString(error?.operation),
        target: optionalString(error?.target),
      },
    };
  }
  throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon returned an invalid response.");
}

export function decodeAgentRecord(value: unknown): LocalAgentRecord {
  const record = asRecord(value);
  const status = requiredString(record?.status, "status");
  if (!isLocalAgentStatus(status)) throw new LocalAgentDaemonProtocolError("INVALID_RECORD", "Invalid agent status.");
  const activitySequence = requiredNonNegativeInteger(record?.activitySequence, "activitySequence");
  const activity = decodeActivityList(record?.activity);
  if (activity.at(-1)?.sequence && activity.at(-1)!.sequence > activitySequence) {
    throw new LocalAgentDaemonProtocolError("INVALID_RECORD", "Activity sequence is behind the retained activity ring.");
  }
  return {
    id: requiredString(record?.id, "id"),
    workspaceId: optionalString(record?.workspaceId),
    workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
    profileName: requiredString(record?.profileName, "profileName"),
    provider: requiredString(record?.provider, "provider"),
    model: optionalString(record?.model),
    effort: optionalString(record?.effort),
    providerSessionId: optionalString(record?.providerSessionId),
    status,
    latestResponse: optionalContentString(record?.latestResponse),
    error: optionalContentString(record?.error),
    errorCode: optionalString(record?.errorCode),
    errorRetryable: optionalBoolean(record?.errorRetryable),
    activitySequence,
    lastActivityAt: optionalString(record?.lastActivityAt),
    activity,
    createdAt: requiredString(record?.createdAt, "createdAt"),
    updatedAt: requiredString(record?.updatedAt, "updatedAt"),
  };
}

export function decodeAgentRecordList(value: unknown): LocalAgentRecord[] {
  if (!Array.isArray(value)) throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid agent list.");
  return value.map(decodeAgentRecord);
}

export function decodeDaemonStatus(value: unknown): LocalAgentDaemonStatus {
  const record = asRecord(value);
  const state = requiredString(record?.state, "state");
  if (state !== "ready" && state !== "stopping") {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid status.");
  }
  return {
    state,
    protocolVersion: requiredInteger(record?.protocolVersion, "protocolVersion"),
    pid: requiredInteger(record?.pid, "pid"),
    endpoint: requiredString(record?.endpoint, "endpoint"),
    host: decodeDaemonHost(record?.host),
    startedAt: requiredString(record?.startedAt, "startedAt"),
    activeTurns: requiredInteger(record?.activeTurns, "activeTurns"),
    runtimeCount: requiredInteger(record?.runtimeCount, "runtimeCount"),
    clientConnections: requiredInteger(record?.clientConnections, "clientConnections"),
  };
}

function decodeDaemonHost(value: unknown): LocalAgentDaemonHost {
  const record = asRecord(value);
  const platform = requiredString(record?.platform, "host.platform");
  if (!isNodePlatform(platform)) {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid host platform.");
  }
  const windowsSessionId = record?.windowsSessionId === null
    ? null
    : requiredInteger(record?.windowsSessionId, "host.windowsSessionId");
  const interactive = record?.interactive === null
    ? null
    : requiredBoolean(record?.interactive, "host.interactive");
  if (platform === "win32" && (windowsSessionId === null || interactive === null)) {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Windows daemon host metadata is incomplete.");
  }
  if (platform !== "win32" && (windowsSessionId !== null || interactive !== null)) {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Non-Windows daemon host metadata is invalid.");
  }
  return {
    pid: requiredInteger(record?.pid, "host.pid"),
    platform,
    windowsSessionId,
    interactive,
  };
}

export function decodeDaemonLogs(value: unknown): string {
  if (typeof value !== "string") throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned invalid logs.");
  return value;
}

export class LocalAgentDaemonProtocolError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalAgentDaemonProtocolError";
  }
}

function decodeEmptyParams(value: unknown): Record<string, never> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record || Object.keys(record).length > 0) {
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "This daemon method does not accept parameters.");
  }
  return {};
}

function decodeStartInput(value: unknown): StartLocalAgentInput {
  const record = asRecord(value);
  return {
    target: requiredString(record?.target, "target"),
    prompt: requiredContentString(record?.prompt, "prompt"),
    workspaceRoot: requiredString(record?.workspaceRoot, "workspaceRoot"),
    workspaceId: optionalString(record?.workspaceId),
    model: optionalString(record?.model),
    effort: optionalString(record?.effort),
    writeMode: decodeWriteMode(record?.writeMode),
  };
}

function decodeContinueInput(value: unknown): { id: string; prompt: string; scope: LocalAgentWorkspaceScope; overrides?: RunOverrides } {
  const record = asRecord(value);
  const overrides = asRecord(record?.overrides);
  return {
    id: requiredString(record?.id, "id"),
    prompt: requiredContentString(record?.prompt, "prompt"),
    scope: decodeWorkspaceScope(record?.scope),
    ...(overrides ? { overrides: {
      model: optionalString(overrides.model),
      effort: optionalString(overrides.effort),
      writeMode: decodeWriteMode(overrides.writeMode),
    } } : {}),
  };
}

function decodeWorkspaceScope(value: unknown): LocalAgentWorkspaceScope {
  const record = asRecord(value);
  if (!record) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Workspace scope is required.");
  return {
    workspaceId: optionalString(record.workspaceId),
    workspaceRoot: requiredString(record.workspaceRoot, "scope.workspaceRoot"),
  };
}

function decodeListScope(value: unknown): LocalAgentWorkspaceScope {
  return decodeWorkspaceScope(value);
}

export function decodeAgentWaitResult(value: unknown): AgentWaitResult {
  const record = asRecord(value);
  const wakeReason = requiredString(record?.wakeReason, "wakeReason");
  if (wakeReason !== "activity" && wakeReason !== "terminal" && wakeReason !== "timeout") {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned an invalid agent wait wake reason.");
  }
  return {
    record: decodeAgentRecord(record?.record),
    timedOut: requiredBoolean(record?.timedOut, "timedOut"),
    wakeReason,
    activitySequence: requiredNonNegativeInteger(record?.activitySequence, "activitySequence"),
    activity: decodeActivityList(record?.activity),
    activityTruncated: requiredBoolean(record?.activityTruncated, "activityTruncated"),
  };
}

function decodeAgentScopedIdParams(value: unknown): {
  id: string;
  scope: LocalAgentWorkspaceScope;
} {
  const record = asRecord(value);
  return {
    id: requiredString(record?.id, "id"),
    scope: decodeWorkspaceScope(record?.scope),
  };
}

function decodeWaitTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_AGENT_WAIT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 1 || value > MAX_AGENT_WAIT_TIMEOUT_MS) {
    throw new LocalAgentDaemonProtocolError(
      "INVALID_PARAMS",
      `Wait timeoutMs must be an integer between 1 and ${MAX_AGENT_WAIT_TIMEOUT_MS}.`,
    );
  }
  return value;
}

function decodeActivityCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalAgentDaemonProtocolError(
      "INVALID_PARAMS",
      "Agent wait afterSequence must be a non-negative safe integer.",
    );
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalAgentDaemonProtocolError("INVALID_PROTOCOL", `Invalid ${field}.`);
  }
  return value;
}

function decodeActivityList(value: unknown): LocalAgentActivityEvent[] {
  try {
    return readActivityEvents(value, "activity");
  } catch (cause) {
    throw new LocalAgentDaemonProtocolError("INVALID_RESULT", "Daemon returned invalid agent activity.", { cause });
  }
}

function decodeLogsParams(value: unknown): { lines?: number } {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log options must be an object.");
  const lines = record.lines;
  if (lines === undefined) return {};
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 10_000) {
    throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Log lines must be an integer between 1 and 10000.");
  }
  return { lines };
}

function decodeWriteMode(value: unknown): LocalAgentWriteMode | undefined {
  if (value === undefined) return undefined;
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", "Invalid write mode.");
}

function isLocalAgentStatus(value: string): value is LocalAgentStatus {
  return value === "starting" || value === "running" || value === "idle" || value === "error" || value === "stopped";
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
  return result;
}

function requiredContentString(value: unknown, field: string): string {
  const result = optionalContentString(value);
  if (result === undefined) throw new LocalAgentDaemonProtocolError("INVALID_PARAMS", `Missing ${field}.`);
  return result;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LocalAgentDaemonProtocolError("INVALID_PROTOCOL", `Invalid ${field}.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new LocalAgentDaemonProtocolError("INVALID_PROTOCOL", `Invalid ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalContentString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isNodePlatform(value: string): value is NodeJS.Platform {
  return value === "aix"
    || value === "android"
    || value === "darwin"
    || value === "freebsd"
    || value === "haiku"
    || value === "linux"
    || value === "openbsd"
    || value === "sunos"
    || value === "win32";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function supportedDaemonProtocolVersion(): number {
  return LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
}
