import assert from "node:assert/strict";
import {
  decodeAgentRecord,
  decodeLocalAgentDaemonRequest,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonRequest,
  encodeLocalAgentDaemonResponse,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

assert.equal(LOCAL_AGENT_DAEMON_PROTOCOL_VERSION, 5);

const request = decodeLocalAgentDaemonRequest({
  requestId: "req_1",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
    writeMode: "read_only",
  },
});
assert.equal(request.method, "agent.start");
if (request.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(request.params.writeMode, "read_only");
assert.match(encodeLocalAgentDaemonRequest(request), /"method":"agent.start"/);

const whitespaceRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_whitespace",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "  keep prompt whitespace  \n",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
  },
});
if (whitespaceRequest.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(whitespaceRequest.params.prompt, "  keep prompt whitespace  \n");

const directRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_direct",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceRoot: "/tmp/project",
  },
});
if (directRequest.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(directRequest.params.workspaceId, undefined);

assert.throws(
  () => decodeLocalAgentDaemonRequest({
    requestId: "req_2",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "test-secret",
    method: "agent.start",
    params: { target: "reviewer", prompt: "" },
  }),
  (error: unknown) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
);

const record = decodeAgentRecord({
  id: "agt_1234",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "idle",
  latestResponse: "  response whitespace  \n",
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(record.id, "agt_1234");
assert.equal(record.latestResponse, "  response whitespace  \n");

const directRecord = decodeAgentRecord({ ...record, workspaceId: undefined });
assert.equal(directRecord.workspaceId, undefined);

const response = decodeLocalAgentDaemonResponse({
  requestId: "req_1",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ok: true,
  result: record,
});
assert.equal(response.ok, true);

const errorResponse = decodeLocalAgentDaemonResponse(JSON.parse(encodeLocalAgentDaemonResponse({
  requestId: "req_error",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ok: false,
  error: {
    code: "PROVIDER_UNAVAILABLE",
    message: "Codex executable was not found.",
    retryable: false,
    provider: "codex",
    agentId: "agt_1234",
    operation: "create_runtime",
  },
}))) ;
assert.equal(errorResponse.ok, false);
if (!errorResponse.ok) {
  assert.equal(errorResponse.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(errorResponse.error.retryable, false);
  assert.equal(errorResponse.error.provider, "codex");
  assert.equal(errorResponse.error.agentId, "agt_1234");
  assert.equal(errorResponse.error.operation, "create_runtime");
}

const cancelScope = { workspaceRoot: "/workspace", workspaceId: "ws_test" };
const cancelRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_cancel",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.cancel",
  params: { id: "agt_test", scope: cancelScope },
});
assert.equal(cancelRequest.method, "agent.cancel");
if (cancelRequest.method !== "agent.cancel") throw new Error("expected agent.cancel request");
assert.deepEqual(cancelRequest.params, { id: "agt_test", scope: cancelScope });

for (const params of [
  {},
  { id: "agt_test" },
  { scope: cancelScope },
  { id: "", scope: cancelScope },
  { id: "agt_test", scope: { workspaceId: "ws_test" } },
  { id: "agt_test", scope: { workspaceRoot: 42 } },
]) {
  assert.throws(
    () => decodeLocalAgentDaemonRequest({
      requestId: "req_invalid_cancel",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      authToken: "test-secret",
      method: "agent.cancel",
      params,
    }),
    (error: unknown) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
  );
}

const failedRecord = decodeAgentRecord({
  id: "agt_error",
  workspaceId: "ws_error",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "error",
  error: "Timed out waiting for the local agent daemon.",
  errorCode: "DAEMON_TIMEOUT",
  errorRetryable: true,
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(failedRecord.errorCode, "DAEMON_TIMEOUT");
assert.equal(failedRecord.errorRetryable, true);
