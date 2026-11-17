# The input invariants (M102 spec 15)

These suites prove, for generated screens and bridge answers, that a person on the phone is never
stuck and that no input vanishes in silence. They assert the invariants, never a reading:

- **I1**: a control is enabled, or words next to it say why.
- **I2**: every tap ends in a request, a visible change, or words a person can read.
- **I4**: the person's override is typed, or refused only for `stale_surface`, `menu_open` or `pane_gone`.
- **I5**: no send waits long on a reading alone.
- **I6**: one request id writes the text and Enter at most once, and Collie's own send never presses
  Enter on a screen that is not free.
- **I7**: no road writes Enter, a digit or a letter onto a menu the person did not answer.

## Where they live

| File | What it covers |
| ---- | -------------- |
| `bridge/surface/invariants.gates.test.ts` | every Surface on a screen with a box and with none, through the Send Protocol's gates (I4, I5, I6) |
| `bridge/surface/invariants.mutation.test.ts` | corpus captures with a row, a warning, a clock, ANSI noise, a rewrap or a cut top added, on four send roads (I4, I7) |
| `bridge/surface/invariants.one-writer.test.ts` | two bridges on one pane, and a crash between the text and Enter, with real pane lock files (I6, M102 spec 16) |
| `bridge/surface/invariants-rig.ts` | the pane that logs every write, and the protocol wired to it |
| `send-slot.invariants.test.ts` | the phone's Send slot over all 2880 Surfaces (I1, I4) |
| `composer.invariants.test.tsx` | the rendered composer: the key pad, offline words, the override button (I1, I4) |
| `answers.invariants.test.ts` | every bridge answer through send, ask, hold card, keys, Stop and Clear (I2) |
| `hold-card.invariants.test.tsx` | the hook hold card's taps (I1, I2) |
| `key-tap.invariants.test.ts` | the guarded key tap on real dialogs: a ticking row outside, a successor dialog (I2, I4, I7) |
| `stop-hold.invariants.test.tsx` | press sequences on the hold-to-stop button (I2) |
| `change-login.invariants.test.tsx` | the Change login page's buttons under every bridge answer (I2) |
| `calm-send.invariants.test.tsx` | a box send that let go of the box at the tap (M104): after every send outcome, a lost answer and an old bridge, the sent text stands in exactly one place, the chat, the box or the Put back card, and words typed meanwhile stay as typed (I2) |
| `known-red.ts` | the red list: every break the base still has, with its fixing spec |

The shared helpers are `seed.ts` (the PRNG, the seed list, sampling), `surfaces.ts` (the Surface
product) and `bridge-answers.ts` (the HTTP answers every route meets).

## Run them

```sh
bun test bridge/surface/invariants.gates.test.ts bridge/surface/invariants.mutation.test.ts
cd web && bunx vitest run src/test/invariants
```

Together they take under a minute. Each run uses the fixed seeds `1, 7, 42, 1729, 65537` plus one
fresh seed, so the sample moves from run to run.

## Replay a failure

Every failure line ends with `replay with INVARIANT_SEED=<n>`. Set that one seed:

```sh
INVARIANT_SEED=1729 bun test bridge/surface/invariants.mutation.test.ts
cd web && INVARIANT_SEED=1729 bunx vitest run src/test/invariants/key-tap.invariants.test.ts
```

With `INVARIANT_SEED` set, only that seed runs. A failure on a fresh seed is a real break: add its
seed to `FIXED_SEEDS` in `seed.ts` once the fix lands, so it stays covered.

## The red list

A break that the base still has stays in the suite as an expected failure (`test.failing` in bun,
`it.fails` in vitest). Its title carries `[RED <invariant> FIXED_BY <spec>: <id>]`, and `known-red.ts`
names the file and line and what the person meets. `known-red.test.ts` checks that every entry has
a test that carries its id.

```sh
bun scripts/invariant-red.ts          # the count per fixing spec, and each entry
bun scripts/invariant-red.ts --gate   # exit 1 while any entry is left
```

When a fix lands, its expected failure starts to pass, and the runner reports that as a failure.
Turn the test into a plain test and delete the entry from `known-red.ts`.

## Add a road

A new input road (a button, a card, a gesture, a page that sends) lands with its invariant cases:

1. Generate the inputs, not single examples. Use a closed list from the product (outcomes,
   reasons, Surface fields), the real corpus under `web/src/fixtures/panes/`, or `commonAnswers()`
   for HTTP answers. Draw a seeded sample with `sample(list, n, rngOf(seed))` for each seed of
   `runSeeds()`.
2. Assert an invariant, never a reading: "ends in a request or words", not "says X".
3. Put the replay hint in each failure line: `replayHint(seed, caseName)`.
4. If the base breaks the invariant, add a `known-red.ts` entry and an expected failure that is red
   on every seed, with one named case that always runs, so the expected failure never depends on
   the sample.
5. Keep the file under a few seconds. Lower the sample size per seed before you drop a seed.

## Release rule

No tag while any invariant test is red or still marked expected-to-fail: `bun scripts/invariant-red.ts
--gate` must exit 0. No tag while a chaos-leg case fails (`bunx playwright test -c
e2e/rig/chaos.config.ts` and `-c e2e/rig/chaos-crew.config.ts`). A case skipped for a missing seam
is a known gap, and the tag lists it.
