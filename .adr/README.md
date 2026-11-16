# Architecture decision records

Decisions with a **blast radius wider than the diff that made them** — the ones a future
contributor (or a future agent) would otherwise re-derive from scratch, or quietly reverse because
the reasoning lived only in a PR thread.

One file per decision, numbered in the order they were accepted:

```
.adr/NNNN-kebab-case-title.md
```

Format is [Michael Nygard's](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
**Context** (the forces, including what was actually measured), **Decision** (what we do, in the
imperative), **Consequences** (what this costs, and what would justify revisiting it).

To find the rule that stands today, start at [the map by topic](#the-map-by-topic) and not at the numbers: a topic is often held by several records, and some of them are history.

## When to write one

Write an ADR when a decision **closes off an option someone will reasonably propose again**. The
signal is that you find yourself explaining *why not* rather than *how*.

- ✅ "We manage exactly one front door" — a NetBird PR, then a Cloudflare Tunnel PR, then a ZeroTier PR
- ✅ "Polling, not an event stream" — perennial, and the reasoning isn't obvious from the code
- ❌ "Use Vitest for the web suite" — that's just what the repo does; `CLAUDE.md` covers it
- ❌ Anything already legible from the code, a test name, or a commit message

**The bar is high, and it is meant to be.** These are for the handful of decisions that shape the
system, not a record of work done. A merged PR is not an occasion for an ADR; neither is a decision
that merely took some thought, nor one you'd like on the record because it was hard-won. If a
directory of ADRs reads like a changelog, it has stopped being useful — the signal drowns, and the
few entries that genuinely close off a road get skimmed past with the rest.

Before adding one, both of these must be true:

1. **Someone has actually argued for the other road, or demonstrably will.** A real PR, a real issue,
   a proposal you had to talk someone out of. "A future contributor might wonder" is not enough — that
   is what a comment is for.
2. **The argument has nowhere better to live.** If it fits at the line that would change, put it
   there: whoever reopens the question is reading that code, not this directory. An ADR is for
   reasoning that spans files, or that argues against a road with no single line to attach to.

**Write the `Trail:` line first, and make it name the opponent.** Every ADR opens with a `Trail:`
header naming the PR, the issue or the thread where somebody argued for the other road, beside the
files the decision reaches. Write that line before the body. If you cannot fill it, condition 1 has
not been met and what you have is a header comment — put it at the line and stop. This is the whole
bar above, reduced to something answerable in the moment: 0049 has issue #243; the two candidates
turned down below had nothing to put there, and neither did the update-screen write-up that became
0044, which is the one entry in this directory no source file cites.

When in doubt, don't. A comment at the point of change costs nothing and is read by exactly the
person who needs it; an ADR that didn't need writing dilutes the ones that did. Two candidates were
turned down on this basis in one day (bundled-font laziness, and the direct-typing lifecycle) — both
became file-header comments, and both are better for it.

## Relationship to the other docs

Nothing here restates what lives elsewhere; the point is the *reasoning*, once.

| Where | What belongs there |
| --- | --- |
| [`CLAUDE.md`](../CLAUDE.md) | The **rule** — short, normative, linking here for why |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | How the system is **built**, as it stands today |
| [`README.md`](../README.md) | How an operator **runs** it |
| `.adr/` | Why a road **wasn't** taken |

## Rules for the records

The old text of a record stays in git history. A reader who opens an old number must land on the live rule in one hop, so the rules below keep the directory short and every pointer two-way. `bun scripts/check-adr.ts` holds them, and `bun run test` runs it.

- **Numbers never change, and no file is moved, renamed or deleted.** Code comments cite records by number. A new record takes the highest number in use on any branch plus one: 0011 to 0016 were accepted on `v1` while `main` was still at 0010.
- **The header has three required lines: `Status`, `Date` and `Trail`.** `Status` says `Accepted` or `Proposed`, or one of the pointers below. `Date` is the day the decision was taken. `Trail` names the PR, issue or thread where somebody argued for the other road. There is no `Shipped in:` line: the changelog holds that fact, and the line rots. Records before 0142 keep the header shape they were written in, and the check reads all three shapes. Only records from 0142 on must carry a `Trail`.
- **A superseded record becomes a stub.** The file and the number stay and the body goes. A stub holds the `# NNNN — Title` line and three more lines, and it has no `Date` line, because the `Status` line carries the date:

  ```
  - **Status:** Superseded by [ADR NNNN](./NNNN-file.md) (2026-11-16)
  - **Decided:** One sentence of what it decided.
  - **Full text:** `git show <sha>:.adr/NNNN-file.md`
  ```

  where `<sha>` is the last commit that held the full text and the date in `Status` is the day of the supersession. The successor carries a short "what we tried before" list that points at the stubs, so the wrong turns stay findable. Until a record is converted, a superseded record keeps its full text and its `Status` line says `Superseded by`; the check lists those still waiting, and none waits today.
- **A record that is not a decision is retired.** Its status is `Retired: the rule lives in <path>`, with the same stub shape. The path is the code header or the doc that now holds the rule.
- **A record is at most 120 lines.** A spec belongs in the code header or in a doc, and the record links it.
- **A record has at most two addenda.** A third change, or any change of the decision itself, is a new record that supersedes the old one. Never rewrite the argument of an old record.
- **An amendment of scope is a pointer, not a rewrite.** A decision that is still correct but whose scope later changes is *amended*: the new record names what it amends in an `Amends in scope:` line, the old one gains an `Amended in scope by NNNN` line, and nothing in its body changes. Both pointers must exist. `Generalises:` and `Narrows:` count as `Amends`, and `Supersedes in part:` pairs with `Superseded in part by`.
- **The topic map below is updated in the same commit as any new record.** Every record appears in it exactly once.

## The map by topic

Find the topic, read "The rule today", then open the records it names. Where records disagree, the paragraph says which one is newer and wins. A topic marked "One live record for this topic is being written" has its rule spread over several records, and a single record that states it is coming; until then the paragraph is the summary and the table is the trail.

### Front door and security

The rule today: Collie manages one front door, `tailscale serve`, and every other tunnel is the operator's own (0001). When Cloudflare Access is configured the bridge verifies its signed token on every remote request (0081), and one build serves any mount path (0052). The idle lock is a pause, not an access control (0007). Collie sent no data until 1.26.x; since 1.27.0 it sends one anonymous daily ping, on by default and with four switches that turn it off (0129, which replaced 0034; 0134 adds one hashed field to the trouble tally).

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-one-managed-front-door.md) | Collie manages exactly one front door, `tailscale serve`; any other tunnel is the operator's own. | Accepted, amended in scope by 0013 |
| [0007](./0007-the-idle-lock-is-a-pause-not-a-gate.md) | The idle lock is a pause on an open, unattended Collie, not an access control. | Accepted |
| [0049](./0049-no-child-inherits-a-relocated-repository.md) | No child of Collie inherits a variable that relocates a git repository. | Accepted |
| [0052](./0052-one-build-serves-any-mount.md) | The mount path is a runtime setting; one build serves any mount. | Accepted |
| [0081](./0081-a-front-doors-signed-identity-is-verified-cloudflare-access-is-the-first-preset.md) | A front door's signed identity is verified; Cloudflare Access is the first preset. | Accepted |
| [0087](./0087-the-on-device-store-is-one-thing.md) | The phone keeps session content in one IndexedDB store, with caps and one wipe at unpair. | Accepted |
| [0129](./0129-an-anonymous-install-count-on-by-default.md) | One anonymous install ping a day, on by default, with four ways to turn it off. | Accepted, amended in scope by 0134 |
| [0134](./0134-the-trouble-tally-names-the-dialog-by-a-hash-of-its-key-hint-row.md) | The trouble tally may carry a hash of the dialog's key-hint row. | Accepted |
| [0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) | Collie collects nothing, and opt-in is the ceiling. | Superseded by 0129 |

### Pairing and devices

The rule today: Every `/api/*` route except `/api/health` and `/api/pair` needs the pairing token, reads included, and pairing is always on (0086). An unpaired browser can ask for access, and a paired phone approves by tapping the right code, with no plain Yes (0139).

| # | Decision | Status |
| --- | --- | --- |
| [0086](./0086-reads-need-the-pairing-token.md) | Every `/api/*` route needs the pairing token, reads included, and pairing is always on. | Accepted |
| [0139](./0139-a-paired-phone-lets-a-browser-in-by-picking-its-code.md) | An unpaired browser asks for access, and a paired phone approves by tapping the right code. | Accepted |

### Crew and deputy

The rule today: [0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) states it in one place. A crew is full Collie instances with one lead, and the lead talks to a member's Collie API, never its multiplexer socket. One front door per crew, on the lead; a member publishes nothing and admits only its pinned lead (and the deputy, for the takeover) with the crew secret. Code reaches a member over the operator's own SSH or from the public release, never over the crew link (update rules: 0143). Only the operator moves the crown: a confirm on the old lead (`approve-promote`), or a takeover by the one deputy named ahead, spent through the standby door that arms on silence. The wire says crew too; the live records 0013 and 0026 still write "pack" and `PACK_PROTOCOL.md`, which read as crew and `CREW_PROTOCOL.md`. Three records stay live beside it: 0013 (a peer listens without becoming a front door), 0026 (the operator is the quorum, with the roads it closes) and 0036 (a multiplexer reports one machine).

| # | Decision | Status |
| --- | --- | --- |
| [0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) | A crew has one lead and one door; code rides the operator's SSH; only the operator moves the crown. | Accepted |
| [0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) | The lead consumes a peer's Collie HTTP API, never its Herdr socket. | Superseded by 0144 |
| [0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) | Every machine runs a collie and the group has a lead (the word "pack" is replaced by 0038). | Superseded by 0144 |
| [0013](./0013-a-peer-listens-without-becoming-a-front-door.md) | A peer opens an unpublished crew listener and publishes no front door. | Accepted |
| [0014](./0014-promote-is-a-confirm-on-the-lead.md) | Promotion needs the old lead's own confirm on the receiver, never a claim alone. | Superseded by 0144 |
| [0015](./0015-pack-add-pushes-over-the-operators-ssh.md) | `crew add` pushes the lead's own commit over the operator's SSH. | Superseded by 0144 |
| [0016](./0016-updates-ride-the-operators-ssh.md) | Updates and installs reach a peer over the operator's SSH; the crew link carries data, never code. | Superseded by 0144 |
| [0023](./0023-compression-is-hop-local-on-the-pack-link.md) | Compression is negotiated per hop on the crew link; the ETag names the identity bytes. | Superseded by 0144 |
| [0026](./0026-the-operator-is-the-quorum.md) | The operator is the quorum: no election, no timer, no promotion from silence. | Accepted |
| [0027](./0027-the-deputy-is-named-ahead-of-time.md) | The operator names one deputy ahead of time; a takeover spends the lead's signed warrant. | Superseded by 0144 |
| [0028](./0028-the-standby-door-is-a-second-listener.md) | The deputy's standby door is a second unpublished listener that arms on silence. | Superseded by 0144 |
| [0036](./0036-the-map-of-machines-is-collies-a-mux-reports-one-machine.md) | A multiplexer reports one machine; the map of machines is Collie's. | Accepted |
| [0038](./0038-the-group-is-a-crew-the-wire-keeps-pack.md) | The group is a crew; the wire keeps "pack" (until 0039). | Superseded by 0144 |
| [0039](./0039-the-machine-says-crew-too.md) | The machine says crew too: protocol version 2, one release of overlap. | Superseded by 0144 |
| [0084](./0084-machines-report-their-load.md) | Each Collie samples its own load; the lead keeps 24 hours of history and judges alert rules. | Retired: the rule lives in `bridge/machines.ts`, `bridge/machine-history.ts` and `docs/crew.md` |

### Update, release and packaging

The rule today: 0143 is the live record, and it names the code that holds each rule. The install kind picks the path once; a Herdr-managed checkout advances in place and is never re-linked, and every other install stages a new version beside the live one and flips `current`, with one rollback at most. A routine update stays inside the installed major, and `--major` is the consent to cross one. Each machine is on one release line, Stable or Edge; switching installs nothing, and a machine goes down a version only by a rollback or a switch back to Stable. State files only grow. A crew member takes its lead's release from GitHub by its own decision, and a crew fault blocks the lead only when the update makes it worse. The phone shows a run in one update mode, decided by one reducer. Separate records stay live for the roads they close: a packaged install is not ours to update (0035), urgency rides one changelog line (0046), Windows is a supported host (0075), the math engines are a release asset fetched on a tap (0132).

| # | Decision | Status |
| --- | --- | --- |
| [0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) | How an install updates, and what a release offers it: the rule of today, with the code that holds it. | Accepted |
| [0006](./0006-update-advances-the-checkout-herdr-installed.md) | `update` advances the checkout Herdr installed and never re-links it. | Superseded by 0143 |
| [0020](./0020-a-major-upgrade-is-consented-by-flag.md) | `update` stays inside the installed major; crossing one needs `--major`. | Superseded by 0143 |
| [0021](./0021-the-path-name-is-a-pointer-never-a-copy.md) | The name on PATH is a symlink to the checkout's binary, never a copy. | Accepted |
| [0035](./0035-a-packaged-install-is-not-ours-to-update.md) | A packaged install is not ours to update. | Accepted |
| [0037](./0037-a-staged-update-confirms-its-runner-before-it-exits.md) | A staged update confirms its runner has left the cgroup before it exits. | Superseded by 0143 |
| [0044](./0044-the-update-screen-is-one-reducer-and-one-shared-poll.md) | The update screen is one reducer and one shared poll. | Superseded by 0143 |
| [0045](./0045-a-build-below-the-protocol-floor-is-a-red-preflight.md) | A build below the protocol floor is a red preflight, never a silent link. | Superseded by 0143 |
| [0046](./0046-an-urgent-patch-keeps-the-daily-cadence.md) | An urgent release moves the digest to daily and never touches the version. | Accepted |
| [0050](./0050-a-crew-fault-blocks-an-update-only-when-the-update-makes-it-worse.md) | A crew fault blocks an update only when the update would make it worse. | Superseded by 0143 |
| [0062](./0062-a-crew-run-levels-to-its-target-and-its-second-step-is-not-a-new-attempt.md) | A crew run levels to its target, and its second step is not a new attempt. | Superseded by 0143 |
| [0064](./0064-an-update-puts-the-phone-in-update-mode.md) | A run this device started puts the phone in update mode until Done, Rolled back or Stuck. | Superseded by 0143 |
| [0075](./0075-windows-is-a-supported-host.md) | Windows 11 x64 with Herdr is a supported host, held by CI and a VM rehearsal. | Accepted |
| [0110](./0110-two-release-lines.md) | Two release lines, Stable and Edge; the switch installs nothing; state files only grow. | Superseded by 0143 |
| [0132](./0132-the-math-engines-are-a-pack-the-host-downloads.md) | The math engines are one release asset that the host downloads only on a tap. | Accepted |

### Sends and the input box

The rule today: A send goes through the Send Protocol, which reads the screen before it types, after it types and after it submits; the protocol is described in the header of `bridge/surface/protocol.ts`. 0142 is the live record: when Collie is not sure, the person decides, every stop card carries its next step, and four hard stops stay. It names which of its rules the code follows today and which wait for their milestone. The Claude input box is found by its own frame (0048), a long send is verified through the paste placeholder and never chunked (0010), and recognising a password prompt changes what Collie says, never what it sends (0017). A plain Send always queues; a steer is the person's explicit choice (0142, which replaced 0117), a Stop is a person's tap with a receipt (0116), and a queued send stays a card until the journal shows it (0122). 0140, still Proposed, adds a second path: a part inside the agent dials the bridge.

| # | Decision | Status |
| --- | --- | --- |
| [0142](./0142-when-collie-is-not-sure-the-person-decides.md) | When Collie is not sure, the person decides: no block without an exit, and four hard stops stay. | Accepted |
| [0004](./0004-the-statusline-run-is-bounded.md) | The Claude statusline walk keeps a bound of 8 rows, which protects less than it looks. | Accepted, amended in scope by 0048 |
| [0005](./0005-a-composed-key-queue-never-outlives-its-dock.md) | Closing the Keys dock discards the composed key queue. | Accepted |
| [0010](./0010-long-sends-are-verified-via-the-paste-placeholder.md) | A long send to Claude is verified through its paste placeholder, never by chunking. | Accepted |
| [0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) | Recognising a password prompt changes what Collie says and stores, never what it sends. | Accepted |
| [0048](./0048-the-input-box-is-found-by-its-own-frame.md) | The Claude input box is found by its own frame, not by a bounded row walk. | Accepted |
| [0057](./0057-the-composer-is-one-box.md) | The composer is one bordered box, with no prompt-kit dependency and the send key unchanged. | Accepted |
| [0060](./0060-an-attachment-is-a-chip-not-a-path.md) | An upload is a chip above the field and a marker in the draft; Send swaps in the path. | Retired: the rule lives in `web/src/lib/attachments.ts` |
| [0061](./0061-the-terminal-draft-notice-floats.md) | The terminal-draft notice floats over the mirror's bottom edge and can be hidden. | Superseded by 0151 |
| [0092](./0092-the-keys-pad-is-a-board-you-arrange.md) | The Keys pad is a board the person arranges; the operator's Presets stay separate. | Accepted |
| [0107](./0107-sent-keeps-shell-lines-per-machine.md) | Each machine keeps its own record of the shell lines sent; agent prompts are never recorded. | Accepted |
| [0116](./0116-a-stop-is-a-persons-tap-with-a-receipt.md) | A Stop is a person's tap with a request id and a receipt. | Accepted |
| [0117](./0117-a-steer-is-the-persons-choice-never-the-default.md) | A plain Send always queues; a steer is the person's explicit per-send choice. | Superseded by 0142 |
| [0122](./0122-a-queued-message-is-a-card-until-the-journal-shows-it.md) | A queued send is a card until the journal shows its text as a prompt. | Accepted |
| [0123](./0123-report-a-problem-three-failed-sends-offer-a-prefilled-issue.md) | Three failed sends in a row offer a prefilled GitHub issue that the person opens. | Accepted |
| [0124](./0124-a-sends-bound-starts-after-its-profile.md) | A send's time bound starts after its profile is known. | Accepted |
| [0140](./0140-a-part-inside-the-agent-dials-the-bridge.md) | A part inside the agent program dials the bridge over a Unix socket. | Proposed |

### Dialogs, cards and screen readers

The rule today: [0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md) states it in one place. A dialog becomes a card only by its own words, and a tap sends only keys the screen printed, plus the arrows of a walk, plus seven named exceptions, each with its file (three unprinted Enters on Claude, the Antigravity artifact review, the sticky edge arrow of a clamped list, the unread card's declared cancel key, and the edit keys that clear a field). A tap on a pointed row is walked, verified by a fresh read, then confirmed (0080, which stays live and replaced the "one batch" wording of 0055, 0058, 0076 and 0078, now stubs), and an AskUserQuestion answer is typed into its field (0113, live). Every card renders in one dock above the belt and can be put down. A dialog Collie cannot read still gets a way out (0053); 0142 widens that card and changes 0009 in one point, and is not built yet.

| # | Decision | Status |
| --- | --- | --- |
| [0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md) | A dialog becomes a card by its own words; a tap sends what the screen printed, walked and verified. | Accepted |
| [0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) | A generic menu sends only keys the screen printed plus advertised arrows, never an inferred digit. | Accepted, amended in scope by 0142 |
| [0053](./0053-an-unread-dialog-still-has-a-way-out.md) | An unread dialog still has a way out: its adapter's declared cancel key, as a card. | Accepted, amended in scope by 0142 |
| [0054](./0054-a-printed-scale-is-tappable.md) | A printed scale is tappable: every value is a chip and a tap sends the arrow presses. | Superseded by 0151 |
| [0055](./0055-a-pointed-list-is-walked-then-confirmed.md) | A pointed list lifts as a prompt-select block; a tap is the arrow walk plus the commit key. | Superseded by 0151 |
| [0056](./0056-a-card-can-be-put-down.md) | Every lifted card carries a Terminal control that shows the rows it replaced. | Superseded by 0151 |
| [0058](./0058-the-resume-picker-commits-with-enter.md) | The Claude `/resume` picker has its own grammar and commits with an unprinted Enter. | Superseded by 0151 |
| [0059](./0059-a-card-docks-above-the-belt.md) | Every lifted card renders in one dock above the Keys belt. | Superseded by 0151 |
| [0072](./0072-a-two-pane-box-pans.md) | A frame row with a column junction anchors a table run, so a two-pane box pans. | Retired: the rule lives in `web/src/lib/table-run.ts` |
| [0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) | A tap on a pointed row is walked, verified by a fresh read, then confirmed. | Accepted |
| [0108](./0108-a-dialog-over-live-chrome-declares-its-tail.md) | A dialog over live chrome declares how many rows lie below it (`bindTail`). | Superseded by 0151 |
| [0109](./0109-an-above-prompt-notice-is-not-a-modal.md) | An above-prompt notice whose keys act on a one-character box is not a modal. | Accepted |
| [0113](./0113-an-askuserquestion-answer-is-typed-into-its-field.md) | An AskUserQuestion answer is typed into its field. | Accepted |

### Harness specifics and WalkyTalky

The rule today: A beacon, the hint an agent's own hook writes, sets what Collie shows and looks up, never an action (0024). [0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md) states the dialogs of omp and pi: an omp modal gets a card only when omp's own footer way out is on screen, otherwise an Escape card, the omp Ask, tool approval, model picker and plan review are each lifted as a card, and pi questions are read by shape and footer (0076 to 0079, 0098 and 0133 are stubs for it). After every update the new binary runs `collie skill sync` so the WalkyTalky skill follows the build (0111).

| # | Decision | Status |
| --- | --- | --- |
| [0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) | A beacon sets what Collie shows and looks up, and never causes an action. | Accepted |
| [0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md) | An omp modal gets a card only when its own footer way out is on screen, else an Escape card. | Superseded by 0151 |
| [0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md) | The omp Ask single-select is lifted as a pointed list; its multi-select stays raw. | Superseded by 0151 |
| [0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md) | The omp `bash` and `write` approval is lifted as a card; Deny never lands on Approve. | Superseded by 0151 |
| [0079](./0079-the-omp-model-picker-is-lifted-as-its-visible-window.md) | The omp model picker is lifted as its visible window. | Superseded by 0151 |
| [0098](./0098-pi-questions-are-read-by-shape-and-footer.md) | One reader serves every pi-family question screen, by shape and footer. | Superseded by 0151 |
| [0111](./0111-the-skill-follows-the-update.md) | After every update the new binary runs `collie skill sync`; an uninstall is respected. | Accepted |
| [0133](./0133-the-omp-plan-review-is-lifted-and-its-tier-is-named-not-moved.md) | The omp plan review is lifted as five option buttons; its tier is named, not moved. | Superseded by 0151 |

### Chat and journal

The rule today: Chat is the default view of an agent pane (0082). A live session is a bounded window answered on the existing poll with a cursor, with no WebSocket and no SSE (0073). A plan is a tool-call kind that folds into one card (0119, retired into `bridge/journal/tool-call.ts` and `bridge/journal/pi.ts`), a background job is a journal fact shown on the belt (0128), and a pinned message is a copy kept by the bridge that owns the pane (0130).

| # | Decision | Status |
| --- | --- | --- |
| [0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md) | A live session is a bounded window on the existing poll, with no WebSocket and no SSE. | Accepted |
| [0082](./0082-chat-is-the-default-view-of-an-agent-pane.md) | Chat is the default view of an agent pane. | Accepted |
| [0119](./0119-a-plan-is-a-tool-kind-and-its-updates-fold.md) | A plan is a tool-call kind, and its updates fold into one card. | Retired: the rule lives in `bridge/journal/tool-call.ts` and `bridge/journal/pi.ts` |
| [0128](./0128-background-jobs-are-journal-facts.md) | A background job is a journal fact, shown on the belt. | Accepted |
| [0130](./0130-pinned-messages-are-a-copy-kept-by-the-owning-bridge.md) | A pinned message is a copy kept by the bridge that owns the pane. | Accepted |

### Layout and navigation

The rule today: [0147](./0147-a-pane-list-keeps-its-place-and-the-footer-holds-views.md) states the pane lists and the dashboard's footer: no list is ordered by status, the operator may ask for Activity or Cache order with the clock read once, a pin is a place the operator chose, and the footer reads Crew, Dashboard, Files and the Hill, with Needs you a switch. It replaced 0063, 0066, 0068, 0070, 0071 and 0085, now stubs, and retired 0069: the rule of the glide lives in the header of `web/src/lib/glide.ts`. This section holds five topics, and the rest stay apart as they are. Back goes up one level (0067). On a large screen the pane screen is a sidebar beside a strip of panes, and two fingers move between panes (0120, 0121, which wait for one record of their own). "Seen" is one shared bridge-side fact (0003), and the app stays on React Router in library mode (0051).

| # | Decision | Status |
| --- | --- | --- |
| [0147](./0147-a-pane-list-keeps-its-place-and-the-footer-holds-views.md) | No pane list is ordered by status; Activity and Cache order read the clock once; pins lead; the footer holds Crew, Dashboard, Files and the Hill, and Needs you is a switch. | Accepted |
| [0003](./0003-one-shared-seen.md) | "Seen" is one shared bridge-side fact, and only reads inside Collie count. | Accepted |
| [0051](./0051-the-phone-app-runs-react-router-in-library-mode.md) | The phone app stays on React Router in library mode, and Collie owns its Vite build. | Accepted |
| [0063](./0063-a-pane-keeps-its-place-when-its-state-changes.md) | No pane list is ordered by status; a pane's place is machine, space, tab and position. | Superseded by 0147 |
| [0066](./0066-the-dashboard-has-a-footer-panes-needs-you-changes.md) | The dashboard has a footer of tabs, and its filter never sorts (the tab names have changed since). | Superseded by 0147 |
| [0067](./0067-back-goes-up-one-level.md) | Back goes up one level: the history stack is the level tree. | Accepted |
| [0068](./0068-the-second-tab-is-focus-not-attention.md) | The dashboard's second tab is renamed Focus and wears `CircleDot` (history, see 0085). | Superseded by 0147 |
| [0069](./0069-a-row-glides-into-its-header.md) | One hand-started view-transition engine drives every glide; the router flag stays off. | Retired: the rule lives in `web/src/lib/glide.ts` |
| [0070](./0070-a-pin-is-a-place-the-operator-chose.md) | A pin is a place the operator chose; pinned panes lead each list on this device. | Superseded by 0147 |
| [0071](./0071-the-operator-may-ask-for-activity-order.md) | The operator may ask for activity order; the clock is read once per opening. | Superseded by 0147 |
| [0085](./0085-the-dashboards-tabs-are-dashboard-crew-and-changes.md) | The footer tabs are Dashboard, Crew and Files (first Changes), Focus is a switch, and the Hill ends the row. | Superseded by 0147 |
| [0120](./0120-on-a-large-screen-the-pane-screen-is-a-strip.md) | On a large screen the pane screen is a sidebar beside a strip of panes. | Accepted |
| [0121](./0121-two-fingers-move-between-panes.md) | Pane navigation by gesture is a device setting, and text selection stays on. | Accepted |

### Themes, fonts, icons and the mark

The rule today: [0148](./0148-a-theme-names-words-never-drawings-and-the-device-choice-wins.md) states it in one place. A theme is one closed JSON file of colours and words from closed lists; an unknown key is refused with its name, never dropped, and the default theme applies nothing. A theme arrives by a file, a paste or the community list, and the page fetches nothing. A theme may name a character and a glyph set, never a drawing; the device's own pick of character wins on that device. The resting character drifts in steps while the page is visible, and "Character moves" or a theme's `characterMotion` stops it. The UI face is a device preference (default Atkinson Hyperlegible Next) that dresses chrome only, and an operator's fonts add to the list. The terminal mirror is dark space inverted in light, with Muse and a per-pane override as the exceptions; 0002 stays live for why it is not re-themed with a light palette, and 0047 for how Muse renders natively.

| # | Decision | Status |
| --- | --- | --- |
| [0148](./0148-a-theme-names-words-never-drawings-and-the-device-choice-wins.md) | A theme names words, never drawings, and the device's own choice wins: the look rule of today. | Accepted |
| [0002](./0002-invert-the-light-terminal-mirror.md) | The light terminal mirror is inverted by CSS, not re-themed with a light palette. | Accepted, amended in scope by 0047 |
| [0033](./0033-the-app-face-is-a-device-preference.md) | The app's typeface is a per-device preference, and an operator's fonts add to the list. | Superseded by 0148 |
| [0047](./0047-muse-panes-render-natively.md) | Muse panes render natively in light, with no inversion filter. | Accepted |
| [0106](./0106-a-theme-is-a-closed-file-of-named-tokens.md) | A theme is a closed JSON file of named tokens; unknown keys are refused. | Superseded by 0148 |
| [0136](./0136-a-theme-may-name-a-mark-and-every-mark-keeps-one-contract.md) | A theme may name a mark from a closed list, and every mark keeps one contract. | Superseded by 0148 |
| [0137](./0137-a-theme-may-name-a-glyph-set-from-a-closed-list.md) | A theme may name a glyph set from a closed list, and every icon is named by its meaning. | Superseded by 0148 |
| [0138](./0138-an-app-left-alone-draws-no-frame.md) | The mark moves while the page is visible (title and first rules reversed by amendments). | Superseded by 0148 |

### Launch, worktrees, files and changes

The rule today: [0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) states the launch half in one place. A start names a row, an agent id, a shell or a one-off line, and the bridge, never the phone, turns it into what is typed. One request id per intent, with one receipt, so a retry never starts a second pane; a create nobody can confirm stays unknown. Collie makes a worktree with git in the bridge and opens it as a space, in a folder it checks at every use, and a half-done create is only opened again. The lead's launcher rows are the crew's rows. Two records stay live beside it: 0126 (why the multiplexer no longer makes the worktree) and 0131 (the "+" opens the rows, with the roads it turned down). The files half is its own, and [0150](./0150-files-and-changes-read-under-a-root-the-bridge-picks.md) states it in one place. The bridge picks the root, and the client names only a path below it: Changes serves only what git listed, Files reads one relative path contained on real paths, both views keep one bound and deny `.git` and Collie's own folders and secrets, and a printed path is a link only inside the root once it exists. 0088 stays live beside it, for the absolute-path road it closed.

| # | Decision | Status |
| --- | --- | --- |
| [0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) | A start names what to run, never a line, and a retry lands on its receipt: the launch rule of today. | Accepted |
| [0150](./0150-files-and-changes-read-under-a-root-the-bridge-picks.md) | Files and Changes read under a root the bridge picks; the client names only a path below it. | Accepted |
| [0065](./0065-the-changes-view-reads-git-read-only.md) | The Changes view reads git read-only against HEAD, hardened and offline. | Superseded by 0150 |
| [0083](./0083-the-files-view-reads-the-changes-root.md) | Files reads one folder or file relative to the Changes root, contained on real paths. | Superseded by 0150 |
| [0088](./0088-paths-the-agent-prints-are-links.md) | A printed path is tappable only when it resolves inside the pane's Changes root. | Accepted |
| [0089](./0089-a-second-agent-on-a-branch.md) | A pane menu starts a second agent on a new branch; a request id and a receipt stop duplicates. | Superseded by 0145 |
| [0090](./0090-files-shows-images.md) | Files shows raster pictures typed by their own bytes; an SVG is never served. | Superseded by 0150 |
| [0091](./0091-launch-by-id-with-a-request-id.md) | The bridge owns the list of startable agents and starts one by id, with a request id and a receipt. | Superseded by 0145 |
| [0093](./0093-a-branch-folder-is-named-by-its-parent.md) | A branch's folder is named by its parent, and checked on every use. | Superseded by 0145 |
| [0094](./0094-launchers-added-from-a-phone.md) | Launchers added from a phone live on the machine, under the operator's switches. | Superseded by 0145 |
| [0095](./0095-one-off-commands-and-their-history.md) | A one-off command can start from a paired phone and is kept in a history of twelve lines. | Superseded by 0145 |
| [0112](./0112-a-pane-outside-its-workspace-folder-reads-its-own.md) | A pane outside its workspace folder reads its own folder. | Superseded by 0150 |
| [0126](./0126-collie-makes-a-worktree-with-git-and-opens-it-as-a-space.md) | Collie runs `git worktree add` in the bridge and opens the checkout as a space. | Accepted |
| [0127](./0127-the-leads-launcher-rows-are-the-crews-rows.md) | The lead's merged launcher rows are the crew's rows. | Superseded by 0145 |
| [0131](./0131-the-plus-offers-the-launcher-rows.md) | The "+" opens a sheet of the machine's launcher rows. | Accepted |
| [0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md) | A worktree is opened by the multiplexer, never by Git. | Superseded by 0126 |

### Durable agents and the wire

The rule today: [0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) states it in one place. A durable agent is a session with no screen of the Collie the person already runs, listed in `sources.json`, and Chat is its only view. The wire has two transports, a private socket of the same user or HTTPS with a bearer token, exactly one per agent. An ask is data, answered by its id with a receipt, and a send, a stop or a belt action names the turn the phone saw. The push guard caps pushes, never what is shown. The SDK is the npm package `@colliepwa/durable-sdk` under the dist-tag `experimental`, and a host with no process keeps every fact the phone sees in its log. The records it replaced, now stubs, disagreed in places (0099 points 3, 4, 5 and 10 against 0103, 0104 and 0105), and 0146 follows the code. People read "durable agent"; the code, the API value `program` and these records say "program".

| # | Decision | Status |
| --- | --- | --- |
| [0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) | A durable agent is a session with no screen; asks and controls act only by id, with a receipt. | Accepted |
| [0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) | A durable program is a mux adapter with no screen. | Superseded by 0146 |
| [0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) | An ask travels as pane data and is answered by its id, with a receipt. | Superseded by 0146 |
| [0101](./0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) | A send or an abort on a screenless pane names the turn it saw; a stale name gets 409. | Superseded by 0146 |
| [0102](./0102-starters-are-launcher-rows.md) | A durable program's starters are launcher rows. | Retired: the rule lives in `bridge/starter-launch.ts` |
| [0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md) | The wire has two transports: a private socket, or TLS with a bearer token. | Superseded by 0146 |
| [0104](./0104-a-program-is-a-session.md) | A durable program is a session of the Collie already running, listed in `sources.json`. | Superseded by 0146 |
| [0105](./0105-the-durable-sdk-is-an-npm-package.md) | The durable SDK is the npm package `@colliepwa/durable-sdk`. | Retired: the rule lives in `packages/durable-sdk/README.md` |
| [0114](./0114-a-host-with-no-process-keeps-its-state-in-the-log.md) | A host with no process keeps every phone-visible fact in the log. | Superseded by 0146 |

### Usage and accounts

The rule today: 0149 states the usage figures. The context and the cost are the session's and come from what the harness states: Claude's beacon hooks with the window size from the wrapped statusLine (the wrap is the default), the session logs and model catalogs for the other harnesses, and a token count where no window is stated. The account windows are the agent's own list, asked of the vendor with the login the harness keeps on this machine, read for one request and not stored, per account folder. 0115 and 0118 are stubs that point at it. An account is a label, a harness and a folder the agent already understands, and the person signs in inside the agent (0141, which stays live beside 0149 for the roads it closed). This section holds two topics, and the prompt cache and its alerts stay apart as they are: a cache rule shown on screen carries a dated source (0041), and a notification kind is a bridge-wide switch that defaults off (0042).

| # | Decision | Status |
| --- | --- | --- |
| [0149](./0149-usage-figures-are-what-the-agent-states-and-the-account-is-asked-with-its-own-login.md) | Usage figures are what the agent states; the account windows are asked with the harness's own login, per account folder. | Accepted |
| [0041](./0041-cache-rules-are-sourced-claims.md) | Every cache number shown carries a dated source. | Accepted |
| [0042](./0042-notification-kinds-and-the-cache-watch.md) | A notification kind is a bridge-wide switch that defaults off; a cache watch is per pane. | Accepted |
| [0115](./0115-usage-numbers-come-from-the-operators-own-statusline.md) | Usage context comes from the operator's own statusLine wrapper and the journal. | Superseded by 0149 |
| [0118](./0118-account-windows-come-from-the-vendors-usage-endpoint-with-the-operators-own-login.md) | Account windows come from the vendor's usage endpoint with the operator's own login. | Superseded by 0149 |
| [0141](./0141-an-account-is-a-folder-the-agent-already-understands.md) | An account is a label, a harness and a folder the agent already understands. | Accepted |

### Speech

The rule today: Speech to text is a provider seam Collie owns, off by default and set up by a CLI act (0029). Two newer records each name one exception: Whistle may be set up from Settings and runs on the phone or the host from one vendored engine (0096), and a write device may switch the host between Whistle, Codex and Off (0097).

| # | Decision | Status |
| --- | --- | --- |
| [0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) | Speech to text is a provider seam Collie owns, off by default and set up by a CLI act. | Accepted, amended in scope by 0096, 0097 |
| [0096](./0096-speech-can-stay-on-the-phone.md) | Speech can run on the phone or the host from one vendored, hash-pinned engine. | Accepted, amended in scope by 0097 |
| [0097](./0097-codex-speech-can-be-chosen-from-settings.md) | A write device may switch the host's speech between Whistle, Codex and Off from Settings. | Accepted |

### Tricks and the Hill

The rule today: No record decides tricks or the Hill on its own yet. Trick code may cross the crew link as inert data and runs only on a tap on the machine that runs it (0144 rule 3, which took the addendum of 2026-11-10 to 0016), and the footer's Hill item and trick items are in 0147 (rules 7 and 12).

### Process, lint and tests

The rule today: oxlint plus the vendored anti-slop rules is the lint gate, with one linter and one config (0019). A staged change to the crew wire must carry a recorded protocol decision (0025, retired into `scripts/check-crew-wire.sh`). The browser leg replays recorded model streams through a local stub (0125). `scripts/check-adr.ts` holds the rules of this directory.

| # | Decision | Status |
| --- | --- | --- |
| [0019](./0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md) | oxlint plus the vendored anti-slop rules is the lint gate; one linter, one config. | Accepted |
| [0025](./0025-the-wire-guard-forces-a-decision-never-a-bump.md) | A staged change to the crew wire must carry a recorded protocol decision. | Retired: the rule lives in `scripts/check-crew-wire.sh` |
| [0125](./0125-the-browser-leg-replays-recorded-model-streams.md) | The browser leg replays recorded model streams through a local stub. | Accepted |

### Other: the mirror, the mux port, configuration and translation

The rule today: Collie runs no terminal emulator (0008) and owns a multiplexer port in its own vocabulary, with Herdr as one adapter (0022); an adapter declares its freshness, focus and shape (0031). "Never write the operator's screen" is stated in three places, 0008 (geometry writes), 0031 (the phone moves the terminal only on a named tap) and 0126 (never send focus when a worktree opens as a space, which replaced 0032). The operator's command rows replace the catalog on the panes they address, per surface for the bar (0018, 0043), and configuration reads default, machine file, instance file, then the environment (0040). The UI is translated by a typed dictionary (0030), and a push title is a code the phone translates (0074).

One live record for this topic is being written.

| # | Decision | Status |
| --- | --- | --- |
| [0008](./0008-collie-does-not-run-a-terminal-emulator.md) | Collie runs no terminal emulator, in the browser or in the bridge. | Accepted |
| [0018](./0018-operator-command-rows-replace-the-catalog.md) | The operator's command rows replace the catalog on the panes they address. | Accepted |
| [0022](./0022-the-mux-seam-is-a-port-collie-owns.md) | Collie owns the multiplexer port in its own vocabulary; Herdr is one adapter. | Accepted |
| [0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md) | The UI is translated by a typed dictionary, not an i18n library. | Accepted, amended in scope by 0074 |
| [0031](./0031-freshness-is-a-declared-promise.md) | An adapter declares freshness, focus and shape; the phone moves the terminal only on a named tap. | Accepted |
| [0040](./0040-configuration-precedence-and-the-config-file.md) | Configuration precedence is default, machine file, instance file, then the environment. | Accepted |
| [0043](./0043-operator-bar-rows-replace-the-bar-not-the-palette.md) | Operator `bar = true` rows replace the bar, not the Agent palette. | Accepted |
| [0074](./0074-a-push-title-is-a-code-the-phone-translates.md) | A push title is a code the phone translates. | Accepted |
