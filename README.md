# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg"><img src="docs/logo-light.svg" alt="" width="36" height="36" align="absmiddle"></picture> sidenote

**Reply to the exact sentence Claude wrote, and get an answer to just that.**

Long Claude Code replies raise several questions at once, and the terminal gives you one prompt to
ask them in. Review tools for coding agents are built around a plan, a document or a diff. sidenote
works on the conversation itself: every reply appears in your browser with no command to run, you
note the lines you care about, and one click sends them to the session you're already in. Each note
gets its own answer in its own thread.

![Selecting text in a reply, writing a note beside it, clicking Send now, and opening the thread with Claude's answer](docs/demo.gif)

## Install

You need Claude Code, Node.js 22 or newer, and macOS or Linux. In a Claude Code session:

```text
/plugin install sidenote --marketplace sous17/sidenote
```

From your shell, that's `claude plugin install sidenote --marketplace sous17/sidenote`. On a Claude
Code older than 2.1.292, run these instead:

```sh
claude plugin marketplace add sous17/sidenote
claude plugin install sidenote@sidenote
```

To get new versions by themselves, run `/plugin`, open the **Marketplaces** tab, select `sidenote` and
choose **Enable auto-update**. Claude Code leaves that off for marketplaces like this one.

## Quick start

1. Run `/sidenote:on` in a session. Your browser opens, and every reply Claude finishes shows up there.
2. Select text in a reply and click **Add sidenote**, or hover a paragraph and click **+**.
3. Write your note and click **Send now**. Claude answers without you typing in the terminal.
4. Click the note to read its answer in its own thread, and reply there to keep going.

Prefer the terminal? Run `/sidenote:terminal` once, then `sidenote chat` in a folder you've trusted in
Claude Code, or `sidenote tui` beside a running session. Both are previews.

**[Read the documentation](https://sous17.github.io/sidenote/)** to learn how it works.

## Terminal app (work in progress)

sidenote in a terminal, with a note's thread open beside the conversation. This is a design mock,
not a finished app.

![Design mock of the terminal app: the conversation with Claude on the left, and a note's thread taking the right half of the screen](docs/tui-mock.png)

## License

[MIT](LICENSE)
