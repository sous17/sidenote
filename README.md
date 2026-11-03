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
- **Code changes as diffs.** When you ask Claude to see or change code, in a note or in the
  terminal, it explains each change and shows it as a diff, with the edited words highlighted.
  Answers that touch several files fold each file open from its header.
- **One window per session.** Each Claude Code session gets its own window, titled with the
  name you gave the session with `/rename` (or its project folder). Notes always go back to
  the session they were written on.
- **Or stay in the terminal.** `sidenote tui` shows the same feed, notes and threads in any
  terminal window you run it in.
- **Or talk to Claude in sidenote itself** (preview). `sidenote chat` runs the Claude Code
  session for you: you type messages, watch Claude work, answer its permission prompts, and
  note its replies in the same window.
- **Light, dark, or system theme**, from the switch in the top right.
- **Local only.** Everything stays on your machine. See [Security](#security).

![A thread answer that walks through a code change: an explanation, then a diff of the file with the edited words highlighted, and a second file folded under its header](docs/diffs.png)

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

| Command              | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `/sidenote:on`       | Turns sidenote on and opens this session's window                                |
| `/sidenote:off`      | Turns it off for all sessions. Pending notes are kept for next time              |
| `/sidenote:open`     | Reopens this session's window, for example after closing it                      |
| `/sidenote:status`   | Shows this session's window address, replies, pending notes, and Send now status |
| `/sidenote:backfill` | Imports this session's earlier replies, so you can leave notes on those too      |

### In the terminal

If you'd rather not leave the terminal, read replies and leave notes with `sidenote tui`, in any
terminal window or tab. `/sidenote:status` prints the command for this session on its
`terminal:` line:

```shell
'…/sidenote/bin/sidenote' tui <session id>
```

Run without a session id, it shows the most recently active session in the folder it was
started in, and waits for one if there is none yet. The browser window and `sidenote tui` can
be open at the same time; they show the same notes. To talk to Claude from sidenote itself,
without a Claude Code window, see `sidenote chat` below.

| Key                  | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `j` `k` (or arrows)  | Move between blocks, notes and answers. Long blocks scroll first |
| `n`                  | Note on this block. On a note: reply in its thread               |
| `N`                  | Note on the whole reply                                          |
| `v`                  | Pick lines of code or a diff, then `n` to note just those        |
| `Enter`              | Open a note's thread, or fold and unfold a file of a diff        |
| `x` `x`              | Delete a note that hasn't been sent                              |
| `S`                  | Send every pending note now                                      |
| `g` `G`, `Space` `b` | First and latest reply, page down and up                         |
| `q`                  | Quit                                                             |

In the note editor, **Enter** sends now (or saves, when Claude isn't listening), **Ctrl+S**
saves for your next prompt, **Alt+Enter** starts a new line, **Ctrl+E** opens `$EDITOR`, and
**Esc** closes it, keeping what you wrote for next time. A thread replaces the feed in the
window: `r` replies, `f` shows the note's block in the feed, and `Esc` goes back.

Wider than 110 columns, notes sit in a margin beside the text they are about; narrower, under
it. Colors come from your terminal's own theme, `NO_COLOR` turns them off, and links are
clickable in terminals that support it (set `SIDENOTE_HYPERLINKS=0` or `1` to override).

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
`enabled: no`, run `/sidenote:on`. If the tab says "Stale tab" or "This link has expired",
run `/sidenote:open`: links to a window work once, and a restart of sidenote retires old tabs.

**The window shows the folder name, not the session name.** Name the session with `/rename`;
the window picks up the new name with Claude's next reply.

**Hooks can't find Node.** Hooks don't always get your shell's `PATH`, for example with nvm
when Claude Code isn't started from a terminal. sidenote also looks in the usual Homebrew,
Volta, mise, asdf, nvm and fnm locations. If it still can't find Node, set `SIDENOTE_NODE` to
the full path of your `node` binary. Problems are logged to `~/.sidenote/server.log`.

### Talk to Claude in sidenote (preview)

`sidenote chat` makes sidenote the whole session, in one terminal window: no Claude Code pane
beside it. Run it in your project folder (it doesn't need `/sidenote:on`):

```shell
'…/sidenote/bin/sidenote' chat
```

A new Claude Code session starts there, using your normal Claude Code login and settings. Type
at the `you ›` line and press **Enter**. Claude's reply streams in above it: who spoke and when
in a column on the left, the conversation in the middle, and a turn's tool calls on one line
(`✓ read app.py   ◐ npm test`, `✗` when one failed). When Claude asks to use a tool, the request
shows in full under the reply: **y** allows it, **a** always allows it (Claude Code's suggested
rule, such as accepting edits for this session), **n** denies it. **Esc** interrupts Claude;
messages you typed while it worked come back to the prompt line.

**Tab** moves between the prompt line and the conversation, where the keys above work: move to
a block, **n** to note it, **v** to pick lines, **]** and **[** to go to the next or previous
note. Wider than 120 columns, notes sit in a margin on the right, level with their text (◆ until
sent, ◇ after, with the start of Claude's answer), and you write them in a box right there.
Notes ride along with your next message, or go on their own with **S**. Their answers land in
the notes' threads, as in the browser.

**Enter** on a note opens its thread in the right half, beside the conversation. **r** writes a
reply at the bottom of that half; **Enter** asks it now, **Ctrl+S** keeps it for your next
message. **Tab** switches halves, **]** and **[** go to the next or previous thread, and **Esc**
closes it. In windows narrower than 120 columns the thread takes the whole window instead.

Claude runs in the sidenote server, not in the window, so it keeps working if you close the
window. The window prints the session's id when it closes; `sidenote chat <session id>` picks
the session up again, and also continues a session you started in Claude Code. The browser
window works for these sessions too.

## How it works

Four hooks connect Claude Code to a small local server:

- **Stop** (`hook-stop`) posts each finished reply to the server, starting it if needed, and
  opens the session's window the first time that session replies.
- **Stop, in the background** (`hook-wait`, with `asyncRewake`) waits for **Send now**. When you
  click it, the hook prints your notes and exits with code 2, which wakes Claude to answer.
- **UserPromptSubmit** (`hook-prompt`) attaches pending notes to the prompt you type.
- **SessionStart** (`hook-session`) asks Claude to show code changes as diffs, so the window can
  draw them. It applies to sessions started, resumed or cleared while sidenote is on.

`sidenote chat` doesn't use the hooks: the server runs Claude Code headless (`claude -p` with
stream-json input and output), one process per session, and sends your messages to it. Claude
Code's permission prompts come back to the server as requests, which wait until you answer.
Each finished turn is stored like a reply the Stop hook would have sent. The hooks see these
sessions too, and stand aside.

When notes reach Claude, it is asked to answer each one under a line like `**↳ Re: note 12**`.
The server moves those sections out of the reply and into the notes' threads. If Claude leaves
the markers out, the reply stays whole in the feed and the thread links to it.

## Security

Anyone who can call sidenote's API can put words in front of your Claude session, so the API is
locked down:

- **Local only.** The server listens on `127.0.0.1`, and refuses requests whose `Host` header
  isn't its own address, which blocks DNS-rebinding attacks.
- **A token for every call.** A random 256-bit token, created on each start, is stored in
  `~/.sidenote/server.json`, readable only by you. It travels in a custom header, which other
  websites can't send to the server: the server never approves a cross-origin request.
- **No token in URLs.** The CLI opens a window with a single-use launch code in the URL
  fragment, which browsers never send over the network. The page trades the code for the token
  once and keeps it in the tab's session storage, so browser history, synced history and
  `ps` only ever see a spent code that expires within two minutes anyway.
- **Validated input.** Every request body is parsed against a fixed shape, with size limits,
  before it reaches the store. Session ids must look like ids.
- **Inert replies.** Raw HTML in a reply is shown as text. The rendered markdown is sanitized
  with DOMPurify, which also strips forms, ids and classes that could imitate sidenote's own
  controls. The page's content security policy allows no inline or remote scripts, and every
  response carries `nosniff`, `no-referrer` and anti-framing headers.
- **Sessions sidenote runs.** For `sidenote chat` sessions, the API can also send messages to
  Claude and answer its permission prompts, under the same token and checks. A session only
  starts in a folder that exists, and only your answer allows a tool Claude Code would ask about.
- **Private files.** `~/.sidenote` and everything in it are readable only by you.

Found a security problem? Please report it privately through GitHub's
[security advisories](https://github.com/sous17/sidenote/security/advisories/new) rather than
in a public issue.

## Development

Development needs Node 22.18 or newer: tests run the TypeScript directly with Node's type
stripping, with no compile step. The plugin itself runs on Node 20 or newer.

```shell
npm install
npm run check      # formatting, types, build dist/, then the tests
npm run format     # apply Prettier
```

| Path                                   | What's there                                                             |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `src/shared/types.ts`                  | The API contract, used by the server, the hooks and the page             |
| `src/server/`                          | Request parsing, the store, Send now, the session host, and the routes   |
| `src/agent/`                           | Running an agent headless: the driver interface and the Claude adapter   |
| `src/cli/`                             | The `/sidenote:*` commands and the three hooks                           |
| `src/node/`                            | Paths and clock, shared by the server and the CLI                        |
| `src/web/`                             | The page: feed, thread pane, note editor, and Send now controls          |
| `src/tui/`                             | `sidenote tui` and `sidenote chat`: views, prompt line, editor, renderer |
| `test/`                                | Unit tests, HTTP security tests, and an end-to-end run of the real hooks |
| `bin/sidenote`                         | Finds Node and runs `dist/cli.js`                                        |
| `hooks/`, `skills/`, `.claude-plugin/` | The plugin wiring                                                        |
| `dist/`                                | Built output, committed so installing needs no build step                |

Run `npm run build` after changing anything in `src/`, and commit `dist/` with it. CI runs
`npm run check` on Linux and macOS and fails if `dist/` doesn't match the source.

To try a change without reinstalling, start Claude Code with `claude --plugin-dir .` from this
folder.

## License

MIT
