# 0129: An anonymous install count, on by default

- **Status:** Accepted
- **Date:** 2026-11-04
- **Shipped in:** pending
- **Supersedes:** [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (Collie
  collects nothing, and opt-in is the ceiling). Its update-check paragraph stands.
- **Relates to:** [ADR 0123](./0123-report-a-problem-three-failed-sends-offer-a-prefilled-issue.md)
  (a prefilled issue is a link the person opens, not a call Collie makes; unchanged),
  [ADR 0110](./0110-two-release-lines.md) (the ping names the release line),
  [ADR 0035](./0035-a-packaged-install-is-not-ours-to-update.md) (the ping names the install kind).
- **Trail:** Altan's decision of 2026-11-04 (milestone M86, GitHub download counts cannot tell an
  install from a fetch) · `bridge/telemetry.ts` · `bridge/index.ts` · `bridge/config-schema.ts` ·
  `cli/doctor.ts` (`telemetryFindings`) · `web/src/components/telemetry-settings-card.tsx` ·
  `web/src/components/telemetry-notice.tsx` · `docs/security.md` → "What leaves your machine" ·
  `telemetry/README.md` (the contract) · `collie-website` `src/lib/ping/` (the receiver)

## Context

ADR 0034 made a promise on 2026-09-01: Collie collects nothing, no flag turns collection on, and
opt-in is the ceiling if it is ever needed. It accepted one cost, written down in its own words:
nobody knows how many people run Collie. Reach is read from GitHub's release download totals.

Those totals do not measure active bridges, the running Collie instances. A download counts the same whether it ran, was fetched by a
mirror, or was fetched again by a self-update. On 2026-11-04 the best reading of them was about 700
active bridges, anywhere between 500 and 1,000. That is too wide to plan a release, a platform
or a package around. Peers count in the plain way: herdr-app sends a daily ping with a random ID and
lets the person turn it off, and so do Ovis, Wave and pi in their own forms. None of them uses a
tracking pixel.

Opt-in is the road ADR 0034 named as the ceiling. An opt-in count would measure the few people who
find a switch, which is not the number the project is missing.

## Decision

**From 1.27.0 a Collie bridge sends one anonymous ping a day to Collie's own endpoint. It is on by
default, and any one of four switches turns it off.** Until 1.26.x Collie sent nothing. This ADR
reverses ADR 0034 openly, and the notice says so in plain words in the CHANGELOG, the README,
`docs/security.md` and a one-time card on the phone.

1. **The ping carries nine fields and nothing else.** `v` (the schema, `1`), `id` (a random
   128-bit install ID made on this machine, 32 hex characters), `day` (the UTC date), `version`
   (without the build tail), `os`, `arch`, `install` (`binary`, `linked-clone`, `detached-checkout`,
   `packaged` or `unknown`) `line` (`stable` or `edge`) and `role` (`solo`, `lead` or `member`: whether this bridge runs alone,
   leads a crew or is a member; a peer that is not the lead is a `member`, and the role is read at ping
   time; added 2026-11-05 so the count can tell setups from machines, with `v` still `1` because the
   receiver had not run in production). No host name, no path, no user name, no
   harness or multiplexer name, no pane, no count of anything, no content. A test pins the key set,
   so a tenth field breaks a test on purpose.
2. **One request a day, at most.** The first ping waits 24 hours after the first start of a build
   that has the feature, so a person has a day to read the notice and say no. After that, at most
   one per UTC day. The day is written before the request goes out. A failed send is dropped, never
   queued, never retried.
3. **Four switches, and any one of them wins.** `DO_NOT_TRACK` set to anything but `0`;
   `COLLIE_TELEMETRY=0`; `telemetry = false` in the `[bridge]` section of the config file; the
   switch in Settings on the phone. The words `0 false off no` are off and `1 true on yes` are on, in
   any case; an empty value is no vote; any other value is off, and the bridge log and `collie
   doctor` warn about it. The switch fails closed. An off word beats every on word: `COLLIE_TELEMETRY=1` does not
   beat `DO_NOT_TRACK` or the phone's off. The phone can turn a bridge off that is on by default,
   or by `COLLIE_TELEMETRY=1`, but it cannot turn on a bridge that the machine itself turned off.
4. **Four cases are off with no switch.** `CI` is set. The update mirror variable is set (a
   rehearsal). The build is a development build. `COLLIE_TELEMETRY_URL` is set to something that is
   not `https` (or `http` to `127.0.0.1` or `localhost`, for a test server). Labs and the browser
   leg therefore never ping.
5. **Opt-outs are not counted.** Turning the count off sends no message and deletes the install ID
   from `telemetry.json`. There is no "goodbye" event. The share of bridges that opted out is
   estimated offline: pings per release against GitHub binary updates.
6. **Each bridge is one count, crew members too.** A bridge is one Collie instance with its own
   state folder. The phone's switch writes the machine the phone talks to, the lead, and says so;
   when the lead has members, the card lists their names and says they are not covered. A member is
   switched by its own environment or config file. Forwarding the phone's switch over the crew
   link is later, if someone asks.
7. **Every start says so in the log.** A bridge logs one `install count:` line at each start: on or
   off, which switch decided, when the first ping may go and how to turn it off. A headless machine
   has no phone, and this line is its notice. A service reads `COLLIE_TELEMETRY` from its own
   `.env`, not from a shell profile.
8. **The receiver is Collie's own.** A small receiver on the colliepwa.dev app server with one Postgres table, at
   `https://ping.colliepwa.dev/v1/ping`, with its source public in the `collie-website` repository
   under `src/lib/ping/` and the contract in `telemetry/README.md`. It is built to store no IP
   address. The ping has one fixed user agent, `collie-ping`.
9. **The update check, Whistle, Walky talky and Report a problem are unchanged.** They send no
   install data. ADR 0034's paragraph on the update check stands.

## What this reverses

ADR 0034 held three things, and this ADR drops all three.

- **"Collects nothing", by default and by policy.** From 1.27.0 it collects the nine fields above.
- **"Opt-in is the ceiling."** The count is opt-out. The ceiling bound the mechanism as well as the
  default, and an opt-out is above it.
- **"Removing this promise is worth a major version on its own."** The count ships in 1.27.0, a
  minor release (the milestone's target; Altan, 2026-11-04). ADR 0034 wanted a moment in which the
  operator can act. Here that moment is the notice in four places and the 24 hours before the first
  ping, and not a major version that asks every operator to change something.

`docs/security.md` no longer says "Nothing, by default and by policy", and the README no longer
says "No telemetry". ADR 0034 is marked superseded and its body is not edited.

## Consequences

- **Reach is a count.** Active bridges per version, OS, architecture, install kind, release line and crew role,
  from a SQL query against the Postgres table. No dashboard is built for it.
- **The count is a floor.** A bridge behind a firewall, a bridge with a switch off, and a
  bridge that runs less than a day send nothing. The opt-out share is an estimate, not a
  measurement.
- **A person who trusted the old promise is told, not surprised.** The notice names the old promise,
  the date and the four switches. The first ping comes a day after the first start.
- **The operator can see the exact next message.** Settings shows it as JSON on request, and
  `collie doctor` prints one line with the state and the switch that decided.
- **A random ID is still an ID.** It is made on the machine, never derived from one, and deleted the
  moment the count is off. It cannot be tied to a person by anything Collie sends. The receiver's
  log is the one place an address could appear, and the receiver is built to keep none.
- **Usage analytics, crash reports and feature counts stay out.** This ADR opens one narrow count,
  not the road ADR 0034 closed. A tenth field, or a second kind of message, needs its own ADR.
- **Any new field, or a second kind of message, needs a new ADR and the same visible notice again.
  Review in six months (May 2027): publish what the count changed.**
- **Revisiting.** If the receiver cannot be run without keeping addresses, or the count stops
  informing a decision, the answer is to remove the ping and say so in the CHANGELOG, not to widen
  it.
