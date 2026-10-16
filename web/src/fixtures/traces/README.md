# Golden traces

A golden trace is a recorded run of screen reads, hook edges and ticks. The expected Surface sits
beside each step. The format is in `web/src/lib/surface/trace.ts`. The replay runs the real fold.

Two kinds of trace feed one test, `web/src/lib/surface/traces.test.ts`.

- A file under `traces/<harness>/<name>.jsonl`. A person or the lab writes it.
- A one-read trace the loader builds from each labelled pane fixture and each incident screen.
  The loader copies no text. The read names the fixture.

## The marking rule

The set of a trace comes from a label. Nobody marks a fixture by hand.

| Source | Label | Set | Expectation |
| --- | --- | --- | --- |
| Pane fixture | `dialog` or `screen` | negative | never `free` |
| Pane fixture | `idle` | positive | `free`, on a harness that has a profile |
| Pane fixture | `draft`, `running`, `popup`, `other` | none | none |
| Incident screen | each of the eight in `surface-labels.json` | negative | never `free` |
| Trace file | the `set` key in its header | as written | its own `expect` lines |

The labels live in `web/src/fixtures/surface-labels.json`. Add a row there with every new pane
fixture. The fold test fails on a fixture with no row. The loader in
`web/src/test/surface-traces.ts` (`setOfState`) is the one place that turns a label into a set.

A harness with no profile never reads `free`. Its idle fixtures carry no `free` expectation.

## The corpus rule in CI

`traces.test.ts` replays every trace three ways: with the hook source present, removed and lying.
It fails on any negative trace that reads `free` in any of the three. It also fails when fewer
than 95 percent of the positive traces of a harness with a profile read `free`.

CI runs this test in its own named step, beside `bun scripts/surface-corpus.ts`. Both steps are in
the `check` job of `.github/workflows/ci.yml`.

## Add a trace

1. Capture the screen as a pane fixture. Add its label row. The loader does the rest.
2. For a run with edges (a hold, a lost Stop), write a `.jsonl` file. Copy the header of a nearby file.
3. Run `cd web && bunx vitest run src/lib/surface/traces.test.ts`.
