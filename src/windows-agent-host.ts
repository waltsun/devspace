import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

export function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}
