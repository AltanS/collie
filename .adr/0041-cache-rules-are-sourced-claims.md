# 0041 — Cache rules are sourced claims

Status: **Accepted** (2026-09-13)

Related: [ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) (the operator-file contract
this joins, and the replace-law it does not dilute) ·
[ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) (the last time the bridge was
asked to reach outside itself, and what it cost) ·
[ADR 0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md) (why a vendor's own
words are not translated) ·
[ADR 0031](./0031-freshness-is-a-declared-promise.md) (a promise about freshness is declared, never
measured, which is the shape of the `retrievedAt` rule below)

## Context

**A prompt cache is the most expensive thing an operator cannot see.** Every harness Collie fronts
keeps a cached prefix of the conversation, and every one of them charges a fraction of the input rate
while that prefix is warm and the full rate once it is gone. The operator's only signal today is the
bill. The question they actually have is small and has an answer: *have I got time to finish this
thought before the cache dies.*

**A cache lifetime is vendor behaviour, not a standard.** It is changed without announcement, it
differs between a subscription and an API key, it differs between two model generations from one
vendor, and roughly half of what is written about it online is somebody's guess repeated. A number in
this tree with no page behind it is therefore not a number, it is a rumour with a font.

**The feature is a port, not a design.** `AltanS/herdr-cache-alert` already solved this as a Herdr
plugin and its claim contract is the part worth taking. Four of its decisions carry over untouched: a
TTL is a sourced claim, rules live in code, the verdict is read from the harness's own transcript, and
the clock runs from the last outbound request. Two of its mechanisms cannot come across at all,
because Collie's bridge is not where cache-alert runs.

**The bridge cannot see the agent's environment, and that is load-bearing.** cache-alert reads
`ENABLE_PROMPT_CACHING_1H` and `FORCE_PROMPT_CACHING_5M` straight out of `process.env`, because it
runs inside Herdr's plugin host in the operator's own shell. Collie's bridge is a `systemd --user`
unit started by the launcher, which passes `HERDR_PLUGIN_CONFIG_DIR` in precisely so the bridge never
shells out (`bridge/config.ts`). Its `process.env` belongs to the unit, not to the terminal the agent
is running in, so every one of those reads would answer a question about the wrong process.

## Decision

**Four rules, and they bind anything that later wants to put a cache number on a screen.**

**1. Every TTL carries a dated source.** `Sourced<T>` holds the value, a confidence word and a
`Source` with a url, a title, a publisher, an ISO `retrievedAt` and, for a `documented` claim, the
verbatim sentence it was read from. A claim below `documented` carries a note saying what could not be
confirmed. No bare number exists anywhere under `bridge/cache/`, and the tests are the enforcement
rather than this paragraph.

**2. The precedence is measured, then remembered, then the operator, then the model, then the tier.**
In order: a TTL this session's own transcript stated; a TTL measured on an earlier turn of this
session; the operator's `cache-rules.toml`; the rule for the model actually in use; the rule for the
tier or provider. When none of those answers, nothing is shown. When the answer is in doubt the
shorter number wins: a wrong early warning costs a glance, and a wrong "still warm" sends somebody
back to a cache that expired ten minutes ago.

**3. The operator file may move a number and may never remove its provenance.** A `cache-rules.toml`
row without `source_url` and `retrieved` is dropped, with the row named in `collie doctor`. It is the
sixth file on ADR 0018's contract and rides the same reader; it does not dilute that ADR's
replace-law, because a TTL is one value and there is nothing to replace a catalog of.

**4. Nothing is shown before it is measured.** A pane with no probe carries no `cache` key at all.
There is no placeholder, no "measuring", and no guess. For Claude the question answers itself: the
same assistant entry that gives the last request time also says whether the window written was an
hour or five minutes, so the first reading is already measured.

**Two mechanisms guard a number going stale, and each uses the clock its question needs.**

`collie doctor`'s `cache-claims` warns on any claim over 180 days, against the **wall clock**, because
`doctor` is a live check of a live machine and "nobody has re-read this page in six months" is a fact
about today.

A unit test fails the build on any claim more than 365 days older than the newest numbered
`## [x.y.z] - YYYY-MM-DD` heading in `CHANGELOG.md`, against **that date and never `Date.now()`**. Two
properties follow, and both are the reason. Every checkout of a tag passes or fails identically
forever, so a bisect and the VM lab are safe. And the release commit is the only thing that writes
that date (`scripts/check-version.sh`), so the gate bites at exactly the moment a release would ship a
year-old number, which is the moment it should.

**The agent's environment is not read, and `/proc/<pid>/environ` is out of scope.** The bridge makes
no read into another process. `collie doctor` may read its own shell, because it IS the operator's
shell, and it may do exactly one thing with what it finds: say that the shell and the config file
disagree. It never changes a TTL and it never writes a rule.

**A peer's number is computed on the peer, and the lead never cites its own catalog for it.** The
`cache` field is additive-optional on the pane wire (`CREW_PROTOCOL.md` §19) and is computed with the
peer's own rules and the peer's own overrides, so the chip is true where it is rendered. `GET
/api/cache-rules` is deliberately not forwarded: the peer may hold an override the lead has never
seen, so quoting the lead's page for the peer's number would be a citation that is simply false. The
pane sheet says where the number was read instead.

## Consequences

**The port starts at parity and ages honestly.** Every `retrievedAt` keeps cache-alert's own
2026-08-24, so day one is at parity and the 180-day warning starts ticking from the date somebody
really read the page. Re-dating to the port date would have been a lie about that.

**Two harnesses ship no rule, and their panes say nothing.** Neither grok nor hermes publishes a TTL
Collie could quote, and inventing one is precisely what rule 1 exists to prevent. Their panes read
`unknown`, which renders as an empty slot.

**A vendor quietly moving a number is still possible, and is now loud rather than silent.** The two
clocks above do not prevent it; they make the claim rot visibly. The operator's own escape is one
file, and it costs them a url and a date.

**A peer's sheet is shorter than a lead's, and shipping that gap is deliberate.** A reader on a crew
dashboard sees a peer's state, TTL, confidence and rule id, and one sentence where the source would
be. The alternatives were to refuse the sheet entirely on a peer's pane, which hides three true facts
to avoid one missing one, or to hold the whole feature until the catalog is forwarded. Forwarding it
is a route contract and a version negotiation, in a release already retiring wire v1, so it is a spec
of its own.

**There is no switch.** No per-device toggle hides the chip, and no UI edits a rule. If a crowded
dashboard proves the chip noisy the answer is one `localStorage` boolean in the shape
`collie:haptics:v1` already has, and that decision wants a real dashboard to look at first.
