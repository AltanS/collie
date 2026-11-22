# Collie session label for pi

A [pi](https://github.com/badlogic/pi-mono) extension that names the session file on its herdr-core terminal, so Collie can tell two pi panes in one folder apart (#809, based on ibrmora's port of `omp-extension/` from #675 in #780).

What it does:

- It sets the terminal label `pi.session_file` to the absolute path of the session's `.jsonl`, and Collie's pi journal reads that label first when resolving the pane's conversation.
- It writes on `session_start` (`startup`, `reload`, `new`, `resume`, `fork`) and again at the end of every turn (`agent_end`), which retries a write that failed and catches any file change that arrived without an event.
- Because pi replaces its extension runtime across `/new`, `/resume`, `/fork` and `/reload`, write state is shared across runtimes in the same process and the label is cleared when `session_shutdown` runs with `reason: "quit"` or when an interactive session update has no usable absolute session file (such as `--no-session`).
- It writes through `hc label`, one write at a time, always the newest value. A value counts as written only once `hc` succeeded.

The label is a best-effort lookup hint, not proof of which session a pane runs:

- A brand-new session stays empty until pi writes its `.jsonl` file on disk after the first reply.
- During a switch, the old path can show until the new write lands.
- A process killed outright leaves its last label behind.
- The reader confines the path to pi's own log folder for that working directory and checks it like any other session ref.

The value is an absolute path, so it shows your home folder and project names to anything that reads the terminal's labels.

It does nothing outside herdr-core (no `HC_TERMINAL_ID`), in a nested pi started from another pi's bash tool (`PI_SESSION_ID`), and outside TUI mode (`print`, `json`, `rpc`).

## Install

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-extension/collie-session-label.ts ~/.pi/agent/extensions/
```

Start pi again to load it, and copy it again after each Collie upgrade. To check that it works, run this in another terminal while pi is open:

```sh
hc get <terminal> --json | jq '.labels["pi.session_file"]'
```

If `hc` is not on the PATH of the shell that starts pi, set `COLLIE_HC_BIN` to the absolute path of the `hc` executable.

To remove it, delete `~/.pi/agent/extensions/collie-session-label.ts`. If a previous process was killed abruptly and left a stale label on the terminal, clear it with `hc label "$HC_TERMINAL_ID" pi.session_file=`.
