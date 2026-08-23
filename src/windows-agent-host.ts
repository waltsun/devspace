import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WINDOWS_AGENT_HOST_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_AGENT_HOST_VALUE_NAME = "DevSpaceAgentHost";

type RegistryExecutor = (file: string, args: string[]) => unknown;

export function buildAgentHostRunCommand(
  nodeExecutable = process.execPath,
  cliEntrypoint = resolveCliEntrypoint(),
): string {
  return [
    quoteWindowsCommandArgument(nodeExecutable),
    quoteWindowsCommandArgument(cliEntrypoint),
    "agent-host",
    "run",
  ].join(" ");
}

export function resolveCliEntrypoint(): string {
  const compiled = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

export function installWindowsAgentHost(
  execute: RegistryExecutor = defaultRegistryExecutor,
  platform: NodeJS.Platform = process.platform,
): void {
  assertWindows(platform);
  execute("reg.exe", [
    "add",
    WINDOWS_AGENT_HOST_RUN_KEY,
    "/v",
    WINDOWS_AGENT_HOST_VALUE_NAME,
    "/t",
    "REG_SZ",
    "/d",
    buildAgentHostRunCommand(),
    "/f",
  ]);
}

export function uninstallWindowsAgentHost(
  execute: RegistryExecutor = defaultRegistryExecutor,
  platform: NodeJS.Platform = process.platform,
): void {
  assertWindows(platform);
  try {
    execute("reg.exe", [
      "delete",
      WINDOWS_AGENT_HOST_RUN_KEY,
      "/v",
      WINDOWS_AGENT_HOST_VALUE_NAME,
      "/f",
    ]);
  } catch (error) {
    if (isMissingRegistryValueError(error)) return;
    throw error;
  }
}

export function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function defaultRegistryExecutor(file: string, args: string[]): unknown {
  return execFileSync(file, args, { stdio: "pipe" });
}

function assertWindows(platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    throw new Error("devspace agent-host install and uninstall are supported only on Windows.");
  }
}

function isMissingRegistryValueError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 1) return false;
  const stderr = String((error as { stderr?: unknown }).stderr ?? "").toLowerCase();
  return stderr.includes("unable to find")
    || stderr.includes("not found")
    || stderr.includes("cannot find")
    || stderr.includes("找不到")
    || stderr.includes("不存在");
}
