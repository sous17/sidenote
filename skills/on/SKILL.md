---
name: on
description: Turn sidenote on and open this session's window, in the browser or a terminal pane. Use only when the user invokes /sidenote:on.
disable-model-invocation: true
argument-hint: "[terminal|browser]"
arguments: [ui]
---

Run this and report its output to the user in one or two lines. If it prints a command to run in
another pane, give that command exactly as printed, in a code block:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" on "${CLAUDE_SESSION_ID}" "$ui"
```
