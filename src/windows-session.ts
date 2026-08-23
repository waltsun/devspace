import { execFileSync } from "node:child_process";

type ExecFileSync = typeof execFileSync;

export function getCurrentWindowsSessionId(exec: ExecFileSync = execFileSync): number {
  let output: string | Buffer;
  try {
    output = exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).SessionId"],
      { encoding: "utf8" },
    );
  } catch (cause) {
    throw new Error("Unable to determine the current Windows session ID.", { cause });
  }
  return parseWindowsSessionId(String(output));
}

export function assertInteractiveWindowsSession(sessionId: number): void {
  if (!Number.isSafeInteger(sessionId) || sessionId < 0) {
    throw new Error(`Invalid Windows session ID: ${sessionId}.`);
  }
  if (sessionId === 0) {
    throw new Error([
      "DevSpace agent host must run in an interactive Windows session.",
      "Current Windows session: 0 (Services).",
    ].join("\n"));
  }
}

export function parseWindowsSessionId(output: string): number {
  const value = output.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`PowerShell returned an invalid Windows session ID: ${JSON.stringify(output)}.`);
  }
  const sessionId = Number(value);
  if (!Number.isSafeInteger(sessionId) || sessionId < 0) {
    throw new Error(`PowerShell returned an invalid Windows session ID: ${JSON.stringify(output)}.`);
  }
  return sessionId;
}
