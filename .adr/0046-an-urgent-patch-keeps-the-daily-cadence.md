# 0046 — An urgent patch keeps the daily cadence

Status: **Accepted** (2026-09-15)

Related: [ADR 0020](./0020-a-major-upgrade-is-consented-by-flag.md) (the crossing the update check never folds in) ·
[ADR 0035](./0035-a-packaged-install-is-not-ours-to-update.md) (the host that cannot take the tap) ·
`bridge/update.ts` (`shouldNotify`, the window) · `docs/upgrading.md` → *How often you are told*

## Context

**The weekly fold delays exactly the fixes that must not wait.** A delta that is only patch releases
rides a weekly digest window (`DIGEST_PATCH_WINDOW_MS`), so a patch train arrives as one push rather
than four. That is right nearly every time: a patch is "nothing to learn" by the versioning rule, and
four buzzes for four bug fixes is the app arguing with the operator. It is wrong in the one case that
matters. A fix for data loss, for a security hole, or for a broken update path is a patch on every
axis the version records, and the operator can sit six days behind it without being told.

**Raising the axis to hide the urgency is worse.** Cutting such a fix as a minor would get the daily
window, and it would also lie about what changed: nothing was added and nothing has to be learnt. The
number is the operator's map of what they must do, and bending it to move a notification makes the
map wrong forever to buy one push today. A fourth digit and a `-urgent` prerelease suffix were the
same trade in other clothes: both put a delivery decision inside the version string, where every
tool, tag rule and comparison has to learn it.

**The phone never reads a release body.** The update check is the tag list plus one small sidecar per
release, `collie-release.json`, published by `release.yml` beside the payloads. That document is the
one release-level record an install reads before it updates, and it already carries a fact of exactly
this shape: the crew wire version, read as a number so that the release after the next one says it
too with no code change. So a fact that has to reach an install before it updates has to be in the
sidecar or nowhere.

**And the record it should come from already exists.** `CHANGELOG.md` is the one place a release's
changes are written, the release page is built from it, and the person cutting the release is the one
person who knows whether the fix can wait. Anything else would be a second record to keep in step.

## Decision

**A release may declare itself urgent in one line of its changelog, and an urgent release anywhere in
the delta puts the whole delta on the DAILY digest window. The version is untouched.**

- **One line, one position.** Directly under the release heading, above the first `###` group, in the
  same bold-lead style as a bullet: `**Urgent.** <one sentence, present tense, why this must reach
  operators today.>` That position and no other; a line inside a group is prose, as it always was. An
  absent line is the ordinary release, which is nearly every release.
- **The sidecar carries it.** `scripts/release-reading.ts` builds `collie-release.json` from the
  changelog and from `CREW_PROTOCOL_VERSION`, so the marker and the protocol number are read out of
  the tree rather than transcribed into the workflow's shell. The field is `urgent: { reason }`, and
  it is ABSENT on an ordinary release. The release page keeps the line as it was written, first on
  the body.
- **A malformed field is ignored, never an error.** `parseReleaseReading` drops anything that is not
  an object with a non-empty `reason` and keeps the rest of the reading. Urgency is a courtesy on the
  cadence; a document that wrote it badly is an ordinary release, not an unreadable one.
- **Urgency is evaluated over the whole delta, not over its newest release.** An urgent 1.9.1 with a
  quiet 1.9.2 above it is still an urgent train: the operator has to take the fix either way. The
  monitor asks the newest ten releases in the delta for their sidecars, through one in-memory cache
  per version, and the newest marked one is what the snapshot carries.
- **It breaks the once-a-day cap exactly once, and never the 09:00 floor.** While the urgent version
  has not been announced on this install, `shouldNotify` does not consult the window at all, so a fix
  published at 11:00 goes out at 11:00 even though an ordinary digest went out at 09:00. Once that
  version has been announced the interruption is spent: the delta falls back to the daily window, and
  the marker then only keeps it off the weekly patch one. `DIGEST_EARLIEST_HOUR` is never skipped.
  **The guarantee in numbers: the operator is told at the release, or at the next 09:00 host-local
  after it, whichever is later.** Worst case is a release cut at 09:05, which reaches the phone the
  following morning, just under 24 hours. The payload is the same folded list, the confirm is the same
  act, and the button's wording does not move.
- **The push says why, and the title does not move.** The digest body opens with the release's own
  sentence, ahead of the version line and the crew-link sentence, because that sentence is the reason
  the phone buzzed. The notification's title stays "Collie update available": the notification is the
  same kind of thing it always was.
- **A near miss stops the release.** A line above the first group that looks like the marker and is
  not it, `**urgent**`, `Urgent:`, or a bold lead with no sentence, throws and names the right form.
  Reading one of those as prose would publish a fix on the weekly window while its author believed it
  was on the daily one, which is the exact failure this record exists to prevent. The sentence itself
  is checked too: one to 140 characters, ending in a period, with no backticks, no markdown links and
  no newline, because a push body and a phone card render none of that.
- **The surfaces say so quietly.** The update card prints a short **Urgent** label and the release's
  own sentence beside the versions; the band prints the label alone, because the sentence is prose of
  unbounded length and the row is forty characters. The reason is a QUOTATION and is never translated;
  only the label is.

## Consequences

- **One line in the changelog is the whole cost.** No new tag rule, no fourth digit, no prerelease
  suffix, no second record to keep in step, and nothing to do for the releases that are not urgent.
- **The check spends up to ten small GETs instead of one.** They are bounded by the same three-second
  timeout the sidecar read always had, and they run together. Each published release is asked about
  once per process: a reading and a definite ABSENCE, which is the 404 every release before 1.8.0
  answers, are both facts that cannot change, so both are remembered. A FAILURE is a fact about this
  minute, so it is not remembered and the next check asks again. A read that failed is never urgent,
  and no read can fail the check itself: the answer is the tag list, and this is a footnote on it.
- **An install older than this release keeps the weekly window.** The sidecar is additive by
  construction, so an older install reads the field as an unknown key and ignores it, which is the
  behaviour it has today. It starts honouring the marker after it has updated once. **So this
  mechanism does not serve a broken update path**: an install that cannot update cannot be reached
  faster by a field it does not read, and that case is still an announcement made outside Collie.
- **The marker is a decision somebody is seen making.** The release job prints one line to the log and
  the job summary for every release, `urgent: <reason>` or `urgent: none, ordinary release`, so an
  urgent release is never a thing that happened quietly and an ordinary one is never "nobody looked".
- **The rarity rule is one urgent release a quarter.** In normal operation the marker is for data
  loss, a security fix, or a broken update path, and those are rare. More than one in a quarter is a
  signal about the release process, not about the fixes.
- **The marker is honest only as long as it is rare.** Nothing enforces the quarter, and nothing can:
  the person cutting the release decides, exactly as they decide the axis. A tree that marks every
  patch urgent has deleted the weekly window by hand, and the remedy is editorial, not technical.

### What would justify revisiting

- **A second grade of urgency.** If "today" ever has to be told apart from "now", the 09:00 rule is
  what a new record argues with, and this one is reopened rather than amended.
- **A marker that has to reach an install that is not updating.** The sidecar is read by the update
  check. A fact that must arrive without one is a different transport and a different decision.

### Declined (2026-09-15)

- **Marking a release urgent after the fact.** The sidecar is written once, at the tag, and a
  published release's document never changes. A fault found in a release a week later does not need
  a mutable advisory document read on its own schedule, which would be a second record with a second
  set of failure modes. The cheap answer is an empty re-cut patch that carries the `**Urgent.**` line,
  and that is the answer.
- **A translated category word next to the reason.** The label is translated; the reason is the
  release's own English sentence, quoted. That sentence is the source of truth, exactly as every
  other Collie string is, and it is not translated.
