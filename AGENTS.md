# AGENTS.md

Guidance for coding agents working on sidenote. The [documentation](docs/index.html) explains what sidenote
does and how it is built; this file covers the rules and decisions to keep.

## Before you commit

- Run `npm run check`: formatting, both type checks, the build, then all tests. It must pass.
- `dist/` is committed so installing needs no build step. After changing anything in `src/`, run
  `npm run build` and commit `dist/` in the same commit. CI fails when `dist/` doesn't match.
- Every behavior change comes with a test. Bugs found by hand get a test that would have caught them.
- Run `npm run format` rather than formatting by hand.

## Code

- TypeScript in strict mode, run directly by Node with type stripping. Use only erasable syntax:
  no enums, namespaces, parameter properties or `<Type>value` casts; use `as`. Import types with
  `import type`, and include the `.ts` extension in relative imports.
- The plugin runs on Node 20 or newer, with no runtime dependencies on the server or CLI side.
  Development needs Node 22.18 or newer.
- `src/shared/types.ts` is the contract between the server, the hooks and the page, and also the
  on-disk format of `~/.sidenote/sessions/`. Change the store's shape only together with a
  migration in `src/server/persistence.ts`, so existing stores keep loading.
- Keep each module to one job, with no import cycles. The page wires its parts together in
  `src/web/main.ts`.
- Comments explain why, not what. Keep the existing tone: plain and specific.

## Security

Anyone who can call the API can put text in front of the user's agent, so:

- Never put the API token in a URL, a log line or command output. Windows open with single-use
  launch codes in the URL fragment (`src/server/launch.ts`).
- Every request body goes through a parser in `src/server/requests.ts` before it reaches the
  store: typed, size-limited, and refused unless it is a JSON object.
- Keep data keyed by user-supplied ids in a `Map`, not a plain object, and check ids against
  `SESSION_ID_PATTERN`.
- Replies are untrusted. Raw HTML in markdown is shown as text, DOMPurify stays strict, and
  anything rendered after sanitizing, like diffs, is built with DOM calls and `textContent`,
  never `innerHTML`.
- Keep the content security policy free of inline and remote scripts, and keep the server bound
  to `127.0.0.1` with its `Host` check.
- Anything that starts or stops a process takes a session id, never a path or a pid from the
  request. Starting uses the folder recorded for the session; stopping uses the Claude process the
  session's hooks reported, and checks its start time first, so a reused pid is never signalled
  (`src/node/process.ts`). A new session's prompt goes to `claude` as one argument after `--`, its
  name inside `--name=`; never build a shell command from them, except on macOS, where
  AppleScript's `quoted form of` quotes them (`src/node/terminal.ts`).

## Hooks

- A hook must never break the agent's session: catch everything, log to `~/.sidenote/server.log`,
  and exit 0, except the exit code 2 that deliberately wakes Claude for Send now.
- When a hook needs a detail of an agent's hook API, check that agent's current official docs.
  Don't rely on memory or third-party articles; these APIs change often.

## Product decisions

These were settled with the maintainer. Don't change them without asking.

- **One window per folder, its sessions in a list on the left.** The window's address names the
  folder (`/<folder>`, the last segment of the session's cwd), so it can be bookmarked. The list
  names each session by the name given in the window, else `/rename`, else its first message. It
  docks only where the feed keeps
  room for notes in the margin, and a thread leaves it as the user set it. No view across folders.
- **Notes sit in the margin beside the reply.** Clicking a note splits the room beside the session
  list into two halves, the feed and that note's thread. The list stays docked or folded, as the
  user left it.
- **No duplicated text.** The agent answers each note under a `**↳ Re: note N**` marker; those
  sections live only in the note's thread. A reply that only answers notes shows as a one-line
  row in the feed.
- **Code changes are shown as annotated diffs:** an explanation, then a ` ```diff ` block.
  Answers that touch several files fold each file open from its header.
- **Look:** the "Bracket" logo, the `sidenote` wordmark in the normal text color (not purple), and
  a light, dark or system theme switch.
- **Retention:** up to 100 replies per session; a session is forgotten after 7 days without
  activity, or at once when `/clear` ends it, unless it holds notes or messages Claude never got.

- **One server per machine, and it never outlives its use:** `src/server/lock.ts` decides who runs,
  by asking the system whether the lock's owner lives, never by reading `server.json`.
  `src/server/watch.ts` puts `server.json` back, gives up if another server owns the lock, and stops
  the server after 30 minutes without an API request, unless an agent it runs is in a turn.

## Screenshots

`docs/` screenshots are taken in light mode, with made-up demo data only (never real
conversations), from a scratch server, with the mouse pointer cropped out.

## Testing by hand

- In tests, `fakebin/claude` is a symlink to the real node binary. Only run it. Writing to that path
  replaces node on the machine.
- Never touch the real `~/.sidenote`: run the server with `HOME` pointing at a scratch directory,
  and put a stand-in `open`/`xdg-open` first on `PATH` so no real browser tabs open. See
  `test/hooks.test.ts`.
- Check page changes in a browser, in both themes, and look for console errors.

## Git

- Don't push, force-push, or open pull requests unless the maintainer asks.
- The repository is private and stays private until the maintainer decides to make it public.
- End commit messages with a `Co-Authored-By` line for the agent that wrote the change.
