#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json mode, for tests. It records its arguments, answers
// each message with a short streamed reply, asks permission when a message says "write", and
// ends the turn as interrupted when asked to. FAKE_CLAUDE_LOG names the file it records to.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) =>
  process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
const out = (message) => process.stdout.write(`${JSON.stringify({ session_id: "fake", ...message })}\n`);
const session = process.argv[process.argv.indexOf(process.argv.includes("--resume") ? "--resume" : "--session-id") + 1];
log({ args: process.argv.slice(2), cwd: process.cwd(), headless: process.env.SIDENOTE_HEADLESS });

let waiting = null; // the turn paused on a permission prompt or a slow reply

function finish(subtype, text = "") {
  out({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: text,
    total_cost_usd: 0.01,
    modelUsage: { "fake-model": { contextWindow: 200000 } },
  });
}

function reply(text) {
  out({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    },
  });
  finish("success", text);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ received: message });
  if (message.type === "control_request" && message.request.subtype === "interrupt") {
    out({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } },
    });
    waiting = null;
    finish("error_during_execution");
    return;
  }
  if (message.type === "control_response") {
    const allowed = message.response.response.behavior === "allow";
    out({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: !allowed }] },
    });
    waiting = null;
    reply(allowed ? "Wrote the file." : "Okay, I won't.");
    return;
  }
  if (message.type !== "user") return;
  const prompt = message.message.content;
  out({
    type: "system",
    subtype: "init",
    session_id: session,
    model: "fake-model",
    capabilities: ["interrupt_receipt_v1"],
  });
  out({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Thinking " } },
  });
  out({
    type: "assistant",
    parent_tool_use_id: "agent-1",
    message: { content: [{ type: "text", text: "subagent chatter" }] },
  });
  if (/write/i.test(prompt)) {
    out({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "a.txt", content: "hi" } }],
      },
    });
    out({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        description: "a.txt",
        input: { file_path: "a.txt", content: "hi" },
        permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        tool_use_id: "tool-1",
      },
    });
    waiting = "permission";
  } else if (/slow/i.test(prompt)) {
    waiting = "slow";
  } else if (/crash/i.test(prompt)) {
    process.stderr.write("something broke\n");
    process.exit(3);
  } else {
    reply(`You said: ${prompt}`);
  }
});
