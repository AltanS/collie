# Codex folder-trust prompt — keystroke recipe

Captured 2026-08-22 on Codex v0.149.0: the first screen when Codex starts in a directory it has
not been told to trust. The card sits below the "Do you trust the contents of this directory?"
paragraph; there is no composer or status row yet. Herdr status: `blocked` (herdr may also read
it as idle briefly during startup).

```
> You are in /private/var/folders/…/T/tmp.7lFep9Bv68
  Do you trust the contents of this directory? Working with untrusted contents comes with …
  config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```

Live-probed, in this session:

| Key | Effect |
|---|---|
| `Enter` | Confirms the **highlighted** row (default: 1 — Codex continued into the session). |
| `2` | Confirmed **No, quit** immediately — Codex exited to the shell. Digits confirm directly. |
| `1` | Confirmed **Yes, continue** immediately — probed through the guarded send path on a second fresh directory; Codex continued into the session. |

What the adapter emits: `Yes, continue` → `["1"]`, `No, quit` → `["2"]`, only on the exact
captured layout (both labels, that order, the `Press enter to continue` tail row, and the trust
question on screen above).

## Codex 0.156.1 (captured 2026-09-26, keys probed the same day)

0.156.1 rewrote the prompt (`codex--v0156-trust.txt`):

```
  Folder access
  /tmp/collie-codex-debug
  Trust this folder? Codex can read, edit, and run files here, subject to your permission …
› 1. Trust and continue
  2. Quit
  enter continue · esc quit
```

The labels, the question and the footer are all new, so this is read as a second widget. The old
copy still reads with its probed digits. Nothing was pressed on the new one, so its buttons send
only what the screen names: the arrow walk the `›` pointer implies, then Enter (the footer's
`enter continue`). This is the recipe ADR 0055 set for Claude's pointed trust list. With the
pointer on row 1 (the default), `Trust and continue` is `Enter` and `Quit` is `Down, Enter`. No
digit is sent. The pointer row is in the signature, so a pointer moved at the desk refuses a
stale tap.

Probed live on 2026-09-26 in a fresh untrusted directory: `Down, Enter` quit Codex, and `Enter`
trusted the folder and opened the composer.
