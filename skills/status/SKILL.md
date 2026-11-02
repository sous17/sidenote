---
name: status
description: Show this session's sidenote window address, replies and pending notes. Use only when the user invokes /sidenote:status.
disable-model-invocation: true
---

Run this and report its output to the user in one or two lines:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" status "${CLAUDE_SESSION_ID}"
```
