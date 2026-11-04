# Collie session label for Oh My Pi

An [Oh My Pi](https://omp.sh) extension that names the live session on its herdr-core terminal, so Collie can
tell two omp panes in one folder apart (#675).

**This extension is experimental.** Collie's herdr-core adapter reads the label once its reader lands (#675).
Until then, the label is written and nothing reads it.

What it does:

- On every session start and switch (`/new`, `/resume`, a fork), it sets the terminal label
  `omp.session_file` to the absolute path of the session's `.jsonl`.
- When the session ends, or has no file (an in-memory session), it removes the label, so a shell left in the
  terminal never carries it.
- It writes through `hc label`, once per change and in order. A failed `hc` is dropped, and the next session
  change writes the label again.

It does nothing outside herdr-core (no `HC_TERMINAL_ID`), in an omp started from another omp's shell
(`OMPCODE=1`), and in a session with no UI (a subagent, a print run).

## Install

```sh
mkdir -p ~/.omp/agent/extensions
cp omp-extension/collie-session-label.ts ~/.omp/agent/extensions/
```

A running omp picks it up on its next start or `/reload`. To check that it works, run this in another
terminal while the omp is open:

```sh
hc get <terminal> --json | jq '.labels["omp.session_file"]'
```

If `hc` is not on the PATH of the shell that starts omp, set `COLLIE_HC_BIN` to its absolute path.

To remove it, delete `~/.omp/agent/extensions/collie-session-label.ts`.
