import assert from "node:assert/strict";
import {
  buildAgentHostRunCommand,
  installWindowsAgentHost,
  uninstallWindowsAgentHost,
  WINDOWS_AGENT_HOST_RUN_KEY,
  WINDOWS_AGENT_HOST_VALUE_NAME,
} from "./windows-agent-host.js";

const calls: Array<{ file: string; args: string[] }> = [];
const execute = (file: string, args: string[]) => {
  calls.push({ file, args });
};

assert.equal(
  buildAgentHostRunCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Dev Space\\dist\\cli.js"),
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Dev Space\\dist\\cli.js" agent-host run',
);

installWindowsAgentHost(execute, "win32");
installWindowsAgentHost(execute, "win32");
assert.deepEqual(calls[0], {
  file: "reg.exe",
  args: [
    "add",
    WINDOWS_AGENT_HOST_RUN_KEY,
    "/v",
    WINDOWS_AGENT_HOST_VALUE_NAME,
    "/t",
    "REG_SZ",
    "/d",
    buildAgentHostRunCommand(),
    "/f",
  ],
});
assert.equal(calls.length, 2, "install should be idempotent");

uninstallWindowsAgentHost(execute, "win32");
assert.deepEqual(calls[2], {
  file: "reg.exe",
  args: ["delete", WINDOWS_AGENT_HOST_RUN_KEY, "/v", WINDOWS_AGENT_HOST_VALUE_NAME, "/f"],
});

const missingValue = () => {
  throw Object.assign(new Error("registry value missing"), {
    status: 1,
    stderr: "ERROR: The system was unable to find the specified registry key or value.",
  });
};
assert.doesNotThrow(() => uninstallWindowsAgentHost(missingValue, "win32"));
assert.throws(() => installWindowsAgentHost(execute, "linux"), /only on Windows/);
