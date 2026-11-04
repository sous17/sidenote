---
name: restart
description: Restart sidenote's server and open this session's window, in one step. Pending notes are kept. Use only when the user invokes /sidenote:restart.
disable-model-invocation: true
---

Run this and report its output to the user in one line:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" restart "${CLAUDE_SESSION_ID}"
```
