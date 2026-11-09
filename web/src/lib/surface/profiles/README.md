# Input profiles

One JSON file per harness. The file name is the profile id. `profile.ts` parses and checks each file.
The schema is the `Profile` type and the doc comments in `profile.ts`. This page lists the fields that
need a rule to be read right.

## Keys

- `keys.submit` is the list of keys that send a text on an idle box.
- Some harnesses send with a key that also queues in a turn, so a send there presses that key.
- `keys.commandSubmit` is the list of keys that send a command, when they differ from `submit`.
- `keys.enterWhileRunning` says what Enter does in a turn. The Send Protocol presses Enter into a turn only on `queues`.
- `keys.queueKey` is the one key that queues a message in a turn. It is never Enter and never Escape.
- `keys.commandsRunInTurn` lists the command words the harness runs at once during a turn, as a lab run measured them. Collie sends such a command in a turn with the command keys and never holds it. Each entry is one word that starts with a reserved lead, never a word in `keys.neverHeld`. `keys.commandsRunInTurnNote` says which version and commands the lab ran.
- A command matches an entry when its first word is the entry: `/goal` matches `/goal pause`, never `/goals`.
- The list applies only where the profile is trusted with a turn: a version the binary reported, on a range that is not revoked. On an unread version or a revoked range the command is held as before.

- `keys.clearAll` is the one key that empties a box where `keys.clear` (a Backspace per character) cannot, such as OMP's Ctrl+C on a draft that starts with `->` or `=>`. A clear presses it at most once per request, only after a fresh read showed a draft and the clear key left the box unchanged, and never on an empty box: the same key may quit the program there. Never Escape.
- `reservedLeads` lists the leads a plain send may not start with. `reservedLeadNotes` gives a lead that has no command route either (OMP's `->` and `=>`) its refusal sentence; such a lead is refused in every writing mode.
- `collapse.refuseLiteral` says the harness expands a typed chip label (`📄 #1`) into a body it still holds. A send whose text matches `collapse.pattern` is refused `reserved_lead` before any key.

### Keys that differ by platform

`keys.submit` may be an object instead of a list.

```json
"submit": { "default": ["alt+Enter"], "win32": ["ctrl+q"] }
```

`keys.queueKey` takes the same form with one key per platform.

```json
"queueKey": { "default": "alt+Enter", "win32": "ctrl+q" }
```

- `default` is required. The other keys are platform names: `win32`, `darwin` or `linux`.
- The parser keeps the default in `keys.submit` and `keys.queueKey`, and the rest in `submitByPlatform` and `queueKeyByPlatform`.
- The bridge resolves them with `forPlatform` from `process.platform`. `profileForPlatform` does both steps.

## Command list

- `idle.volatile.below.commandList.pointerFill` says the highlighted entry has no glyph and stands on a fill of its own. The box's fill is what the top edge row paints in the column where the command starts.
- A read without colour finds no pointer there, so a command is not entered over that list.
- `commandList.inEdgeRun` says the list stands in the box's own edge run, right over the top edge. The interior walk ends at the list's lowest entry.
- A list in that run that is not the typed command's own reads as holding Enter, like a dialog over the box.

## Paste

- `paste.block` says the harness takes one bracketed paste of a whole text and folds a long one into `collapse.pattern`.
- `paste.foldLines` says what the fold's `lines` group counts: `breaks` (the default, Claude Code) or `lines` (opencode). It needs `paste.block`.

## Identity

- `identity.agentNames` lists other names a multiplexer reports for the harness.
- The bridge files a pane under the profile id, whichever name the multiplexer used.
- A name may not be the id of a profile or the name of another profile.

## Probe

- `probe.status` is `verified` only where a live probed send passed on a version inside the range.
- A profile with `probe.status: "provisional"` sends every text through the probed path.
- The note says where the evidence comes from. A harness with no live send says so.

## Versions

- A range is `verified` through the ledger row in `web/src/lib/harness/verified-versions.json`, or through a version where a live send passed. The probe note names those versions.
- A range with no evidence is `provisional`, and its version fields are null.
- A version above every range is read as `provisional`, with the nearest older range.
