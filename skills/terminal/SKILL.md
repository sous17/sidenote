---
name: terminal
description: Install the sidenote command, so sidenote chat and sidenote tui run from any terminal. Use only when the user invokes /sidenote:terminal.
disable-model-invocation: true
---

Run this and report its output to the user in one or two lines. If it gives a line to add to their
shell's profile, show that line in a code block, and don't edit the profile for them:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/sidenote" install-command
```
