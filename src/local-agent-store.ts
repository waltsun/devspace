import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import {
  LOCAL_AGENT_ACTIVITY_RING_SIZE,
  readActivityEvent,
  readActivityRing,
  type LocalAgentActivityEvent,
  type LocalAgentActivityInput,
} from "./local-agent-activity.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  activitySequence: number;
  lastActivityAt?: string;
  activity: LocalAgentActivityEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

type LocalAgentRecordPatch = Partial<Omit<
  LocalAgentRecord,
  "id" | "createdAt" | "activitySequence" | "lastActivityAt" | "activity"
>>;

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  activity_sequence: number | null;
  last_activity_at: string | null;
  activity_json: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      status: "starting",
      activitySequence: 0,
      activity: [],
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          status,
          activity_sequence,
          activity_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.status,
        record.activitySequence,
        JSON.stringify(record.activity),
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: LocalAgentRecordPatch): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          activity_sequence = ?,
          last_activity_at = ?,
          activity_json = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.activitySequence,
        updated.lastActivityAt ?? null,
        JSON.stringify(readActivityRing(JSON.stringify(updated.activity))),
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: LocalAgentRecordPatch,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  appendActivity(id: string, input: LocalAgentActivityInput): LocalAgentActivityEvent {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);
    const event = readActivityEvent({
      ...input,
      sequence: current.activitySequence + 1,
      observedAt: new Date().toISOString(),
    });
    const activity = [...current.activity, event].slice(-LOCAL_AGENT_ACTIVITY_RING_SIZE);
    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          activity_sequence = ?,
          last_activity_at = ?,
          activity_json = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        event.sequence,
        event.observedAt,
        JSON.stringify(activity),
        event.observedAt,
        id,
      );
    return event;
  }

  appendActivityResult(
    id: string,
    input: LocalAgentActivityInput,
  ): BetterResult<LocalAgentActivityEvent, AgentStoreError> {
    return storeResult("append_activity", () => this.appendActivity(id, input));
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    const now = new Date().toISOString();
    const active = this.database.sqlite
      .prepare("select id from local_agent_sessions where status in ('starting', 'running')")
      .all() as Array<{ id: string }>;
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions
         set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
         where status in ('starting', 'running')`,
      )
      .run(message, now);
    for (const row of active) {
      this.appendActivity(row.id, {
        category: "status",
        kind: "run_failed",
        status: "failed",
      });
    }
    return Number(result.changes);
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  close(): void {
    this.database.close();
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  const activitySequence = row.activity_sequence ?? 0;
  const activity = readActivityRing(row.activity_json);
  if (activity.at(-1)?.sequence && activity.at(-1)!.sequence > activitySequence) {
    throw new Error("Persisted local-agent activity sequence is behind the retained activity ring.");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    activitySequence,
    lastActivityAt: row.last_activity_at ?? undefined,
    activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}
