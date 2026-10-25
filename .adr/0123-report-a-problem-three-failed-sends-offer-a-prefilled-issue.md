# 0123: Report a problem, three failed sends offer a prefilled issue

- **Status:** Accepted
- **Date:** 2026-10-25
- **Shipped in:** 1.24.1
- **Trail:** `web/src/lib/report/trouble.ts` (the rule) · `web/src/lib/report/store.ts` ·
  `web/src/lib/report/body.ts` (the issue text and the link) · `web/src/components/report-card.tsx` ·
  `web/src/components/report-sheet.tsx` · `web/src/components/report-control.tsx` ·
  `bridge/report.ts` · `GET /api/report/context` in `bridge/server.ts` ·
  `.github/ISSUE_TEMPLATE/from-app.yml` · the playground's "Report a problem" section ·
  [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) ·
  [ADR 0122](./0122-a-queued-message-is-a-card-until-the-journal-shows-it.md)

## Context

When an agent changes how it draws its screen, Collie's reader can stop finding the input box. The
person at the phone then sees sends fail, one after another, with a reason each time. Until now the
only way to tell us was the bug form, which asks for a `herdr pane read` file made at a desk. Most
people do not do that from a phone, so the reports came late or not at all, and the Send Protocol
already holds most of what a report needs: each send has a request id, an outcome, a reason, the
keys Collie pressed and the gaps between them.

ADR 0034 says Collie collects nothing. That stays true. This ADR adds a way for a person to send a
report themselves, through GitHub's own form, after reading every word of it.

## Decision

### The rule

The phone keeps one streak per pane, in memory. It reads only the receipt's outcome and reason, never
the harness name, so a new harness needs no change here.

- An outcome of `sent`, `effective` or `steered` ends the streak.
- `held`, `cancelled`, `discarded` and `expired` neither count nor end it.
- `refused`, `typed_not_submitted` and `unknown` count when their reason points at Collie:

| counts | why |
| --- | --- |
| `probe_failed`, `not_free`, `unconfirmed`, `stale_surface`, `bound`, `write_failed` | Collie could not read or write the box |
| `mismatch`, `changed`, `modal_cue`, `stale_token`, `submit_failed`, `unreadable` | the text went in and Enter did not follow |
| `crash`, `lost_lock`, `no_evidence` | Collie lost track of its own send |

| does not count | why |
| --- | --- |
| `id_reused`, `busy`, `draft_present`, `reserved_lead`, `pane_gone`, `multiline`, `turn_running`, `steer_unsupported`, `steer_not_allowed` | a guard did its job, or the state is the person's |
| `dialog_open`, `dialog_after_enter` | a dialog is on screen, and the phone shows it already |

The cap's `unconfirmed` (a confirm the person owes) does not count. A `typed_not_submitted` or
`unknown` with no reason counts; a `refused` with no reason does not. Both tables are typed as a
`Record` over `SEND_OUTCOMES` and `SEND_REASONS`, so a new outcome or reason fails `tsc` until
someone decides its row.

A request id counts once, so a retry that gets the stored receipt back is the same send. A counted
failure more than ten minutes after the one before it starts a new streak.

**Three counted failures in a row** float a card above the composer: "Sending failed 3 times. This
may be a bug." It sits in the floating column with the held and draft cards, so it takes no space. It
has Report and a cross. The cross keeps it closed on that pane until the streak ends. The card never
resends, retries or types. The phone also keeps the last 20 offered streaks for 7 days in
`collie:report-episodes:v1` (pane ids, request ids and codes, no text), so a report opened from
Settings can name earlier episodes.

### The sheet

One sheet, three doors: the card, "Report a problem" in the pane menu, and Settings, System. It
shows the exact text of the issue before anything leaves.

By default the report holds the Collie version and release line, the app's build, the operating
system, the multiplexer, the agent and its version from the newest receipt, the reader profile and
its status, and for each failing send its time, outcome, reason, request id, mode, keys, gaps and
detail. The last line is a signature such as `collie-sig: send/probe_failed/claude@2.1.291/herdr`,
which "Already reported?" searches for. It never holds what was typed or the screen.

Two switches add more. Both are off each time the sheet opens.

- **Include what I typed** adds, per send, the line Sent kept for it. The bridge already dropped a
  line that looks like a secret and masked the rest, so this adds no new filter. The switch shows only
  when a listed send kept a line.
- **Include the screen** reads the pane's last 40 rows. The switch shows only when the pane has a
  screen (a program session has none).

**Open on GitHub** is a plain link to `https://github.com/AltanS/collie/issues/new?template=from-app.yml`
with `title` and one parameter per form field id (`what-happened`, `sends`, `setup`, `screen`). It
opens in the person's own browser, where their own login and GitHub's form are the last check.
**Copy report** copies the same text, nothing cut. The form carries the `from-app` label itself,
because a `labels` URL parameter needs triage rights on the repository.

### The one route

`GET /api/report/context?pane=<id>[&screen=1]` is the only new bridge route. It sits behind the
paired-device read gate, answers the setup half without `pane`, 404s a pane the session does not
show, and 400s `screen=1` on a pane with no screen. The screen is the last 40 rows with SGR stripped
and **always** run through the bridge's secret mask, whatever `COLLIE_REDACT` says. The route changes
nothing, stores nothing and writes no audit line. The receipts the sheet lists come from the existing
`GET /api/send/receipts`, which now also returns the profile id and status.

### Settings

Settings, System has "Offer a report when sending fails", on by default and stored per device. It
turns off the card only; the pane menu and Settings still open the sheet.

## Consequences

- A report reaches us from the phone with the codes that explain it, and a duplicate is easy to find
  by its signature.
- Nothing leaves the phone without two taps (Report, then Open on GitHub or Copy report), and what
  leaves is what the sheet showed. Collie holds no GitHub token, and the page's `connect-src 'self'`
  stays as it is: the phone never calls GitHub, it opens a link.
- The sheet's code loads on its first open, so it does not ride the main bundle.

## Known limits

- **A crew member's pane gets no card and no menu row.** The route answers this machine's panes only
  and refuses a member (400). Member panes are the next slice.
- **A durable or program session's composer does not count sends.** Its pane menu still opens the
  sheet, with receipts and no screen.
- **A long report is cut to fit the link.** GitHub answers 414 above about 8 KB, so the link stays
  under 6,000 characters. The sheet cuts screen rows from the top first, then the oldest sends, then
  halves the note, and says what it cut. The signature line is never cut. Copy report keeps it all.
- **The words of the issue are English** in every locale, so a report reads the same to the
  maintainer whatever language the phone uses. The sheet's own words are translated.
- **The form must be on the default branch** before the link prefills it. Until then the link opens
  GitHub's new-issue page without the form.

## ADR 0034

ADR 0034 stands. This adds no outbound call from Collie and no collection: the person opens GitHub's
form in their own browser and submits it, the same channel as the bug form, made easier to fill.
0034 now points here.
