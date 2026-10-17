# Install the walky talky skill

Walky talky lets one agent session send a short message to another. An agent only uses it when it
knows how. The skill is a short text that teaches the agent the `collie walky` verbs, how to read
the header of a message it receives, and when not to send.

Collie writes the skill into your agents' own instruction files, and only when you ask. No other
command and no bridge start touches those files.

## Install it

```bash
collie skill install all
```

You can also name one harness: `claude`, `codex`, `opencode`, `pi` or `gemini`.

```bash
collie skill install claude
```

`install all` skips a harness whose config folder does not exist on this machine. Name that
harness to create the file anyway. A running agent reads its instructions at start, so restart it
after an install.

## Where the skill goes

| Harness | File | How Collie writes it |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/collie-walky-talky/SKILL.md` | The whole file. Collie owns it. Every `CLAUDE_CONFIG_DIR` profile that Collie reads gets the same folder. |
| Codex | `$CODEX_HOME/AGENTS.md`, else `~/.codex/AGENTS.md` | A block inside the file. |
| opencode | `~/.config/opencode/AGENTS.md` | A block inside the file. |
| pi | `$PI_CODING_AGENT_DIR/AGENTS.md`, else `~/.pi/agent/AGENTS.md` | A block inside the file. |
| Gemini CLI | `~/.gemini/GEMINI.md` | A block inside the file. |
| Any other | none | `collie skill print generic` prints the block. Paste it by hand. |

In a shared instruction file, Collie owns only the text between these two lines. Every other line
stays as you wrote it.

```
<!-- collie:walky-talky v1 begin -->
<!-- collie:walky-talky v1 end -->
```

If the file is absent, Collie creates it. If the block is present, Collie replaces it in place.
Codex and pi read `AGENTS.override.md` instead of `AGENTS.md` when that file exists. Collie tells
you when it sees one, because the block would then be ignored.

Collie keeps a copy of a file as `<file>.collie-backup` before its first change. It refuses a
symlinked file, a file it cannot read and a block whose markers are damaged. It writes nothing in
those cases. A second install changes no bytes.

## Check it

```bash
collie skill status
```

Each target is one of these.

- `installed`: the file or block matches this build.
- `stale`: it differs from this build. Run `collie skill install all` to bring it up to date.
- `absent`: you did not install it there. This is your choice and is never a problem.
- `refused`: Collie will not touch it, for example because it is a symlink.

`collie skill status --check` prints nothing and exits with code 3 when any installed copy is
stale. A new Collie version alone does not make a copy stale. Only a change to the skill text, or
to the path of the `collie` binary it names, does. `collie doctor` shows the same answer as the
`skill-walky-talky` check, and `collie update` prints one note when the new build carries a newer
skill.

## Take it out again

```bash
collie skill uninstall all
```

This removes the Claude file and cuts out the block. It leaves the rest of each file untouched.
