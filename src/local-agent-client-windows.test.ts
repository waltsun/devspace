import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgentClient } from "./local-agent-client.js";
import { encodeLocalAgentDaemonResponse } from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-host-client-test-"));
try {
  const unavailableEndpoint = await unusedEndpoint();
  let spawnCount = 0;
  const unavailableClient = new LocalAgentClient({
    stateDir: join(root, "unavailable"),
    endpoint: unavailableEndpoint,
    platform: "win32",
    requestTimeoutMs: 100,
    spawnDaemon: () => { spawnCount += 1; },
  });
  const unavailable = await unavailableClient.ensureReady();
  assert.equal(unavailable.isErr(), true);
  if (unavailable.isErr()) {
    assert.equal(unavailable.error.code, "INTERACTIVE_AGENT_HOST_UNAVAILABLE");
    assert.match(unavailable.error.message, /devspace agent-host run/);
  }
  assert.equal(spawnCount, 0);

  const sessionZero = await runHelloServer(root, 0);
  assert.equal(sessionZero.result.isErr(), true);
  if (sessionZero.result.isErr()) {
    assert.equal(sessionZero.result.error.code, "INTERACTIVE_AGENT_HOST_UNAVAILABLE");
    assert.match(sessionZero.result.error.message, /Windows Session 0/);
  }
  await closeServer(sessionZero.server);

  const interactive = await runHelloServer(root, 2);
  assert.equal(interactive.result.isOk(), true);
  if (interactive.result.isOk()) {
    assert.equal(interactive.result.value.host.windowsSessionId, 2);
    assert.equal(interactive.result.value.host.interactive, true);
  }
  await closeServer(interactive.server);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runHelloServer(root: string, windowsSessionId: number): Promise<{
  server: Server;
  result: Awaited<ReturnType<LocalAgentClient["ensureReady"]>>;
}> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { requestId: string };
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        ok: true,
        result: {
          state: "ready",
          protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
          pid: process.pid,
          host: {
            pid: process.pid,
            platform: "win32",
            windowsSessionId,
            interactive: windowsSessionId > 0,
          },
          endpoint: "test-endpoint",
          startedAt: "now",
          activeTurns: 0,
          runtimeCount: 0,
          clientConnections: 1,
        },
      }));
    });
  });
  const endpoint = await listen(server);
  const client = new LocalAgentClient({
    stateDir: join(root, `session-${windowsSessionId}`),
    endpoint,
    platform: "win32",
    requestTimeoutMs: 500,
    spawnDaemon: () => { throw new Error("Windows client must not spawn the host"); },
  });
  return { server, result: await client.ensureReady() };
}

async function unusedEndpoint(): Promise<string> {
  const server = createServer();
  const endpoint = await listen(server);
  await closeServer(server);
  return endpoint;
}

async function listen(server: Server): Promise<string> {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\devspace-agent-host-test-${randomUUID()}`
    : join(tmpdir(), `devspace-agent-host-test-${randomUUID()}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  return endpoint;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
