---
name: open
description: Reopen this session's sidenote window or terminal pane. Use only when the user invokes /sidenote:open.
disable-model-invocation: true
---

Run this and report its output to the user in one or two lines. If it prints a command to run in
another pane, give that command exactly as printed, in a code block:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" open "${CLAUDE_SESSION_ID}"
```
