---
name: backfill
description: Import this session's earlier Claude replies into its sidenote window, so you can leave notes on them. Use only when the user invokes /sidenote:backfill.
disable-model-invocation: true
---

Run this and report its output to the user in one or two lines:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" backfill "${CLAUDE_SESSION_ID}"
```
