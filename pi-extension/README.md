# Collie session label for pi

A [pi](https://github.com/badlogic/pi-mono) extension for people who run pi on the experimental Herdr core backend (`COLLIE_MUX=herdr-core`) with two or more pi panes in the same folder. In that case Collie cannot tell the panes' logs apart, and both panes show the empty card where Chat should be. This extension fixes that (#809, based on @ibrmora's port of `omp-extension/` from #675 in #780).

On tmux, zellij and the normal Herdr you do not need it. It does nothing there.

## What it does

- It writes the terminal label `pi.session_file`, set to the absolute path of the pane's session file (a `.jsonl` file), when pi starts and after each turn. It removes the label when pi quits.
- Collie's pi journal reads that label first, and opens that file for that pane.
- The label is a hint, not proof. Collie checks that the file is in pi's own log folder for that working directory before it opens it.

It does nothing outside a Herdr core terminal, in a pi started from another pi's shell, and outside the pi TUI (`print`, `json` and `rpc` modes). Windows is not checked. Checked with pi 1.3.0.

## Install

With a checkout of Collie:

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-extension/collie-session-label.ts ~/.pi/agent/extensions/
```

A packaged install (the release tarball or an OS package) does not ship this folder. Download the file from https://github.com/AltanS/collie/blob/main/pi-extension/collie-session-label.ts and put it in `~/.pi/agent/extensions/`.

Start pi again to load it. Copy the file again after each Collie upgrade, because the file can change with a release. An old copy keeps working until then.

If `hc` is not on the PATH of the shell that starts pi, set `COLLIE_HC_BIN` to the absolute path of the `hc` executable.

To remove it, delete `~/.pi/agent/extensions/collie-session-label.ts` and start pi again.

## Check that it works

In the pane's own shell, the terminal id is in `$HC_TERMINAL_ID`. Print it before you start pi (`echo "$HC_TERMINAL_ID"`). While pi is open, run this in another terminal, with that id in place of `<terminal>`:

```sh
hc get <terminal> --json | jq '.labels["pi.session_file"]'
```

`jq` is optional. Without it, run `hc get <terminal> --json` and look for `pi.session_file` under `labels`.

A good result is a path that ends in `.jsonl`. Chat shows the conversation after pi's first reply.

## If it does not work

- No label at all: the file is not in `~/.pi/agent/extensions/`, pi was not started again, pi does not run in a Herdr core terminal, or `hc` is not on the PATH (set `COLLIE_HC_BIN`).
- An empty card on a brand-new session is normal until pi's first reply. Pi writes its session file only then.
- Chat shows another conversation after pi crashed or was killed: the old label stayed behind. Clear it with `hc label "$HC_TERMINAL_ID" pi.session_file=`.
- A pi started from another pi's shell is skipped on purpose. `PI_SESSION_ID` is set there.
- pi may take up to 1.5 seconds longer to quit when `hc` does not answer. This is the time limit for `hc`.

## Privacy

The value is an absolute path, so it holds your home folder and project name. Anything that can read the terminals of your Herdr core on this machine can read it, for example `hc get`. Collie reads the label to find the log. It does not put the label in what it sends to the phone or to other machines of a crew.
