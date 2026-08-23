import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { extractHttpsUrl, selectNgrokPublicUrl, startTunnel } from "./tunnel.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly pid = 1234;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedSignals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeSpawn(child: FakeChild, calls: Array<{ command: string; args: string[]; options: SpawnOptions }>) {
  return (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    return child as unknown as ChildProcess;
  };
}

assert.equal(extractHttpsUrl("cloudflared: https://example.trycloudflare.com/.\n"), "https://example.trycloudflare.com");
assert.equal(extractHttpsUrl("public URL: http://example.test"), undefined);
assert.equal(
  selectNgrokPublicUrl({
    tunnels: [
      { public_url: "https://other.example", config: { addr: "http://127.0.0.1:9999" } },
      { public_url: "https://devspace.example/", config: { addr: "http://127.0.0.1:8787" } },
    ],
  }, 8787),
  "https://devspace.example",
);

let manualSpawned = false;
assert.equal(
  await startTunnel(
    { provider: "manual" },
    8787,
    {
      spawn: () => {
        manualSpawned = true;
        throw new Error("manual mode should not spawn");
      },
    },
  ),
  undefined,
);
assert.equal(manualSpawned, false);

const cloudflaredChild = new FakeChild();
const cloudflaredCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
const cloudflaredStart = startTunnel(
  { provider: "cloudflared" },
  8787,
  { spawn: fakeSpawn(cloudflaredChild, cloudflaredCalls) },
);
cloudflaredChild.stderr.write("INF route: https://devspace.trycloudflare.com\n");
const cloudflared = await cloudflaredStart;
assert.ok(cloudflared);
assert.equal(cloudflared.publicUrl, "https://devspace.trycloudflare.com");
assert.equal(cloudflared.command, "cloudflared");
assert.deepEqual(cloudflared.args, ["tunnel", "--url", "http://127.0.0.1:8787"]);
assert.deepEqual(cloudflaredCalls[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
await cloudflared.stop();
assert.deepEqual(cloudflaredChild.killedSignals, ["SIGTERM"]);

const localtunnelChild = new FakeChild();
const localtunnelCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
const localtunnelStart = startTunnel(
  { provider: "localtunnel" },
  4321,
  { spawn: fakeSpawn(localtunnelChild, localtunnelCalls) },
);
localtunnelChild.stdout.write("your url is: https://localtunnel.example\n");
const localtunnel = await localtunnelStart;
assert.ok(localtunnel);
assert.equal(localtunnel.publicUrl, "https://localtunnel.example");
assert.equal(localtunnel.command, process.platform === "win32" ? "npx.cmd" : "npx");
assert.deepEqual(localtunnel.args, ["localtunnel", "--port", "4321"]);
await localtunnel.close();
assert.deepEqual(localtunnelChild.killedSignals, ["SIGTERM"]);

const ngrokChild = new FakeChild();
const ngrokCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
let ngrokFetches = 0;
const ngrokFetch: typeof globalThis.fetch = async () => {
  ngrokFetches += 1;
  if (ngrokFetches === 1) return new Response(null, { status: 404 });
  return new Response(JSON.stringify({
    tunnels: [{ public_url: "https://abc.ngrok.app/", config: { addr: "http://127.0.0.1:2468" } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};
const ngrokStart = startTunnel(
  { provider: "ngrok" },
  2468,
  {
    spawn: fakeSpawn(ngrokChild, ngrokCalls),
    fetch: ngrokFetch,
    pollIntervalMs: 1,
    startupTimeoutMs: 100,
    sleep: async () => undefined,
  },
);
const ngrok = await ngrokStart;
assert.ok(ngrok);
assert.equal(ngrok.publicUrl, "https://abc.ngrok.app");
assert.deepEqual(ngrok.args, ["http", "2468"]);
assert.equal(ngrokFetches, 2);
await ngrok.stop();
assert.deepEqual(ngrokChild.killedSignals, ["SIGTERM"]);

const startupErrorChild = new FakeChild();
const startupError = startTunnel(
  { provider: "cloudflared" },
  8787,
  { spawn: fakeSpawn(startupErrorChild, []) },
);
queueMicrotask(() => startupErrorChild.emit("error", new Error("executable not found")));
await assert.rejects(startupError, /Unable to start cloudflared tunnel: Tunnel process failed: executable not found/);

const timeoutChild = new FakeChild();
const timeoutStart = startTunnel(
  { provider: "localtunnel" },
  8787,
  {
    spawn: fakeSpawn(timeoutChild, []),
    startupTimeoutMs: 10,
    shutdownTimeoutMs: 100,
  },
);
await assert.rejects(timeoutStart, /Unable to start localtunnel tunnel: did not emit a public HTTPS URL within 10ms/);
assert.deepEqual(timeoutChild.killedSignals, ["SIGTERM"]);
