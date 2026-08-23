export const LOCAL_AGENT_ACTIVITY_RING_SIZE = 64;

export type LocalAgentActivityCategory =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "assistant"
  | "progress"
  | "session"
  | "status";

export type LocalAgentActivityStatus =
  | "started"
  | "updated"
  | "completed"
  | "failed"
  | "cancelled";

export interface LocalAgentActivityInput {
  category: LocalAgentActivityCategory;
  kind: string;
  status?: LocalAgentActivityStatus;
  providerAt?: string;
  turnId?: string;
  itemId?: string;
  summary?: string;
  pathCount?: number;
}

export interface LocalAgentActivityEvent extends LocalAgentActivityInput {
  sequence: number;
  observedAt: string;
}

export function readActivityRing(value: string | null | undefined): LocalAgentActivityEvent[] {
  if (value === undefined || value === null || value === "") return [];
  const parsed: unknown = JSON.parse(value);
  return readActivityEvents(parsed, "activity");
}

export function readActivityEvents(
  value: unknown,
  field = "activity",
): LocalAgentActivityEvent[] {
  if (!Array.isArray(value)) throw new Error(`${field} is not an array.`);
  if (value.length > LOCAL_AGENT_ACTIVITY_RING_SIZE) {
    throw new Error(`${field} exceeds the configured ring size.`);
  }
  const events = value.map((event, index) => readActivityEvent(event, `${field}[${index}]`));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) {
      throw new Error(`${field} sequences are not increasing.`);
    }
  }
  return events;
}

export function readActivityEvent(value: unknown, field = "activity"): LocalAgentActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`${field}.sequence must be a positive safe integer.`);
  }
  const category = record.category;
  if (!isLocalAgentActivityCategory(category)) throw new Error(`${field}.category is invalid.`);
  const kind = record.kind;
  if (typeof kind !== "string" || !kind.trim() || kind.length > 80) {
    throw new Error(`${field}.kind is invalid.`);
  }
  const observedAt = record.observedAt;
  if (typeof observedAt !== "string" || !observedAt.trim()) {
    throw new Error(`${field}.observedAt is invalid.`);
  }
  const status = record.status;
  if (status !== undefined && !isLocalAgentActivityStatus(status)) {
    throw new Error(`${field}.status is invalid.`);
  }
  const providerAt = optionalString(record.providerAt, `${field}.providerAt`);
  const turnId = optionalString(record.turnId, `${field}.turnId`);
  const itemId = optionalString(record.itemId, `${field}.itemId`);
  const summary = optionalSummary(record.summary, `${field}.summary`);
  const pathCount = record.pathCount;
  if (pathCount !== undefined && (
    typeof pathCount !== "number" || !Number.isSafeInteger(pathCount) || pathCount < 0
  )) {
    throw new Error(`${field}.pathCount is invalid.`);
  }
  return {
    sequence,
    category,
    kind,
    ...(status === undefined ? {} : { status }),
    observedAt,
    ...(providerAt === undefined ? {} : { providerAt }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(summary === undefined ? {} : { summary }),
    ...(pathCount === undefined ? {} : { pathCount }),
  };
}

export function isLocalAgentActivityCategory(value: unknown): value is LocalAgentActivityCategory {
  return value === "read"
    || value === "search"
    || value === "edit"
    || value === "command"
    || value === "assistant"
    || value === "progress"
    || value === "session"
    || value === "status";
}

export function isLocalAgentActivityStatus(value: unknown): value is LocalAgentActivityStatus {
  return value === "started"
    || value === "updated"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is invalid.`);
  return value;
}

function optionalSummary(value: unknown, field: string): string | undefined {
  const result = optionalString(value, field);
  if (result === undefined) return undefined;
  if (result.length > 200) throw new Error(`${field} is too long.`);
  return result;
}
