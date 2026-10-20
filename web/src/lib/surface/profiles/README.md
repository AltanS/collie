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
