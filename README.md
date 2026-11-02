# sidenote

Leave inline notes on Claude Code's replies in a browser window, and send them back to Claude,
right away or with your next prompt.

![The feed: Claude's replies with your notes in the margin](docs/feed.png)

Reading a long reply in the terminal and then typing "about the second point…" is clumsy.
With sidenote, every reply Claude finishes appears in a browser window. You select the text
you have a question about, write a note beside it, and click **Send now**. Claude answers each
note on its own, and each answer lands in that note's thread.

![A thread open beside the feed: a note, Claude's answer, a follow-up, and the next answer](docs/thread.png)

## Features

- **Notes in the margin.** Select any text, or hover a paragraph and click **+**. Notes sit next
  to the text they are about, or inline when the window is narrow.
- **Send now.** Claude answers your notes straight away, with nothing typed in the terminal.
  **Save** keeps a note until your next prompt instead.
- **Threads.** Click a note to open its thread beside the feed: your note, Claude's answer,
  your follow-ups. Claude's answer appears only in the thread, never duplicated in the feed.
- **One window per session.** Each Claude Code session gets its own window, titled with the
  name you gave the session with `/rename` (or its project folder). Notes always go back to
  the session they were written on.
- **Light, dark, or system theme**, from the switch in the top right.
- **Local only.** Everything stays on your machine. See [Security](#security).

## Requirements

- Claude Code with plugin support and `asyncRewake` hooks (any recent version)
- Node.js 20 or newer
- macOS or Linux

## Install

The repository is its own plugin marketplace.

```shell
claude plugin marketplace add sous17/sidenote
claude plugin install sidenote@sidenote
```

Or inside Claude Code: `/plugin marketplace add sous17/sidenote`, then
`/plugin install sidenote@sidenote`.

While the repository is private, the machine needs GitHub access to it first. The simplest
way is the GitHub CLI: `gh auth login`, then `gh auth setup-git`.

Then restart Claude Code, or run `/reload-plugins`, and turn sidenote on:

```
/sidenote:on
```

Your browser opens this session's sidenote window. From now on, every reply Claude finishes
shows up there. Other sessions get their own window, which opens with their first reply.

### From a local copy

```shell
git clone https://github.com/sous17/sidenote.git
claude plugin marketplace add ./sidenote
claude plugin install sidenote@sidenote
```

## Using it

1. **Leave a note.** Select text in a reply and click **Add sidenote**, or hover a paragraph and
   click **+**. To comment on a reply as a whole, click **Note on whole reply** next to its time.
2. **Send it.**
   - **Send now** (or ⌘↵ / Ctrl+↵) wakes Claude to answer right away. If Claude is busy, the
     note goes as soon as it finishes.
   - **Save** keeps the note pending. It goes to Claude with the next prompt you type in that
     session.
   - The **Send now** button in the top bar sends every pending note at once.
3. **Read the answer.** The reply shows up in the feed as a short "↳ Claude answered 1 note" row,
   and the full answer is in the note's thread. Notes in the margin show a preview of it.
4. **Keep going.** Click a note to open its thread, and reply there. Follow-ups are sent with
   the earlier notes, so Claude has the context.

| Command | What it does |
| --- | --- |
| `/sidenote:on` | Turns sidenote on and opens this session's window |
| `/sidenote:off` | Turns it off for all sessions. Pending notes are kept for next time |
| `/sidenote:open` | Reopens this session's window, for example after closing the tab |
| `/sidenote:status` | Shows this session's window address, replies, pending notes, and Send now status |
| `/sidenote:backfill` | Imports this session's earlier replies, so you can leave notes on those too |

## Update and uninstall

```shell
claude plugin marketplace update sidenote
claude plugin update sidenote@sidenote
```

```shell
claude plugin uninstall sidenote@sidenote
```

Your notes are kept in `~/.sidenote/` outside the plugin, so they survive updates and
reinstalls. Delete that folder to remove them.

sidenote keeps up to 100 replies per session, and forgets a session, with its replies and
notes, after 7 days without a new reply.

## Troubleshooting

**Send now is greyed out.** The session isn't listening yet. That happens when sidenote was
turned on, or the plugin installed, after that session's last reply. Send any prompt in that
session; once Claude replies, the button turns on. Saved notes still go with your next prompt.

**Nothing appears in the window.** Run `/sidenote:status` in that session. If it says
`enabled: no`, run `/sidenote:on`. If the tab says "Stale tab", sidenote was restarted: run
`/sidenote:open`.

**The window shows the folder name, not the session name.** Name the session with `/rename`;
the window picks up the new name with Claude's next reply.

**Hooks can't find Node.** Hooks don't always get your shell's `PATH`, for example with nvm
when Claude Code isn't started from a terminal. sidenote also looks in the usual Homebrew,
Volta, mise, asdf, nvm and fnm locations. If it still can't find Node, set `SIDENOTE_NODE` to
the full path of your `node` binary. Problems are logged to `~/.sidenote/server.log`.

## How it works

Three hooks connect Claude Code to a small local server:

- **Stop** (`hook-stop`) posts each finished reply to the server, starting it if needed, and
  opens the session's window the first time that session replies.
- **Stop, in the background** (`hook-wait`, with `asyncRewake`) waits for **Send now**. When you
  click it, the hook prints your notes and exits with code 2, which wakes Claude to answer.
- **UserPromptSubmit** (`hook-prompt`) attaches pending notes to the prompt you type.

When notes reach Claude, it is asked to answer each one under a line like `**↳ Re: note 12**`.
The server moves those sections out of the reply and into the notes' threads. If Claude leaves
the markers out, the reply stays whole in the feed and the thread links to it.

## Security

- The server listens on `127.0.0.1` only, on a port it reuses between runs.
- Every API call needs a random token, created on each start and stored in
  `~/.sidenote/server.json` (readable only by you). The page gets it through its URL.
- Requests with a foreign `Host` header are refused, which blocks DNS-rebinding attacks.
- Replies are rendered with marked and sanitized with DOMPurify. The page's content security
  policy allows no inline or remote scripts.

## Development

```shell
npm install
npm run check      # typecheck, run the tests, build dist/
```

| Path | What's there |
| --- | --- |
| `src/shared/types.ts` | The API contract, used by the server, the hooks and the page |
| `src/server/` | The store, reply splitting, Send now waiters, and the HTTP server |
| `src/cli/` | The `/sidenote:*` commands and the three hooks |
| `src/web/` | The page |
| `bin/sidenote` | Finds Node and runs `dist/cli.js` |
| `hooks/`, `skills/`, `.claude-plugin/` | The plugin wiring |
| `dist/` | Built output, committed so installing needs no build step |

Run `npm run build` after changing anything in `src/`, and commit `dist/` with it.

Tests run the TypeScript directly with Node's type stripping (Node 22.18 or newer for
development). `test/hooks.test.ts` drives the built launcher end to end in a scratch `HOME`.

To try a change without reinstalling, start Claude Code with `claude --plugin-dir .` from this
folder.

## License

MIT
