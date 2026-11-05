# Changelog

## Unreleased

### Changed

- sidenote now needs Node.js 22 or newer.

### Security

- A new session's prompt and name can't contain control characters. On macOS, Terminal read them as
  keystrokes.
- Folders reported to the API must be absolute paths without control characters.
- Open folder refuses an app, which macOS would run.
- Ending a session checks that the recorded process is Claude.
