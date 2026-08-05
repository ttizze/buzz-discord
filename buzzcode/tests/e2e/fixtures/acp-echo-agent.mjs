#!/usr/bin/env node

import readline from "node:readline";

let cwd = "";
const sessionId = "fixture-session";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fixture", title: "Fixture Agent", version: "1" },
        authMethods: [],
      },
    });
    return;
  }
  if (message.method === "session/new") {
    cwd = message.params.cwd;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `cwd=${cwd}\nprompt=${text}` },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
  }
});
