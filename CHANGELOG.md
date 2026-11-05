# Changelog

## Unreleased

### Changed

- sidenote now needs Node.js 22 or newer.

### Security

- `sidenote chat` refuses a folder you haven't trusted in Claude Code. It runs `claude -p`, which never
  shows the trust prompt and would run the folder's hooks and MCP servers unasked.
- A new session's prompt and name can't contain control characters. On macOS, Terminal read them as
  keystrokes.
- Folders reported to the API must be absolute paths without control characters.
- Open folder refuses an app, which macOS would run.
- Ending a session checks that the recorded process is Claude.
