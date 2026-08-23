import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  assertInteractiveWindowsSession,
  getCurrentWindowsSessionId,
  parseWindowsSessionId,
} from "./windows-session.js";

assert.equal(parseWindowsSessionId(" 12\r\n"), 12);
assert.throws(() => parseWindowsSessionId("12\n13"), /invalid Windows session ID/);
assert.throws(() => parseWindowsSessionId("-1"), /invalid Windows session ID/);

let call: { file: string; args: string[]; encoding?: string } | undefined;
const fakeExec = ((file: string, args: string[], options: { encoding: string }) => {
  call = { file, args, encoding: options.encoding };
  return "7\r\n";
}) as typeof execFileSync;
assert.equal(getCurrentWindowsSessionId(fakeExec), 7);
assert.deepEqual(call, {
  file: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).SessionId"],
  encoding: "utf8",
});

assert.throws(
  () => assertInteractiveWindowsSession(0),
  /Current Windows session: 0 \(Services\)/,
);
assert.doesNotThrow(() => assertInteractiveWindowsSession(2));
