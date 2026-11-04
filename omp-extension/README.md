# Collie session label for Oh My Pi

An [Oh My Pi](https://omp.sh) extension that names the session file on its herdr-core terminal, so Collie
can tell two omp panes in one folder apart (#675).

**This extension is experimental.** Collie's herdr-core adapter reads the label once its reader lands (#675).
Until then, the label is written and nothing reads it.

What it does:

- It sets the terminal label `omp.session_file` to the absolute path of the session's `.jsonl`. It does so
  on every event after which Oh My Pi says the session file may change (`session_start`, `session_switch`,
  `session_branch`: `/new`, `/resume`, a fork, a branch), and again at the end of every turn, which catches
  a file that moved without an event (`/move`).
- It removes the label when the session ends or has no file (an in-memory session).
- It writes through `hc label`, one write at a time, always the newest value. A value counts as written
  only once `hc` succeeded, so a failed write is tried again at the next event.

The label is a best-effort lookup hint, not proof of which session a pane runs:

- During a switch, the old path can show until the new write lands.
- A process killed outright leaves its last label behind.
- The reader confines the path to the harness's log folder and checks it like any other session ref.

The value is an absolute path, so it shows your home folder and project names to anything that reads the
terminal's labels.

It does nothing outside herdr-core (no `HC_TERMINAL_ID`), in an omp started from another omp's shell
(`OMPCODE=1`), and in a session with no UI (a subagent, a print run).

## Install

```sh
mkdir -p ~/.omp/agent/extensions
cp omp-extension/collie-session-label.ts ~/.omp/agent/extensions/
```

Start omp again to load it. To check that it works, run this in another terminal while the omp is open:

```sh
hc get <terminal> --json | jq '.labels["omp.session_file"]'
```

If `hc` is not on the PATH of the shell that starts omp, set `COLLIE_HC_BIN` to the absolute path of the
`hc` executable.

To remove it, delete `~/.omp/agent/extensions/collie-session-label.ts`.
