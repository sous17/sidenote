---
name: status
description: Show this session's sidenote window address, replies and pending notes. Use only when the user invokes /sidenote:status.
disable-model-invocation: true
---

Run this and report its output to the user in one or two lines, then give the `terminal:`
command exactly as printed, in a code block, so they can run it in another terminal window. If the
output has a `tip:` line, pass that on too:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" status "${CLAUDE_SESSION_ID}"
```
