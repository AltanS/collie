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
