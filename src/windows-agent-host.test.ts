import assert from "node:assert/strict";
import {
  buildAgentHostRunCommand,
} from "./windows-agent-host.js";

assert.equal(
  buildAgentHostRunCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Dev Space\\dist\\cli.js"),
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Dev Space\\dist\\cli.js" agent-host run',
);
