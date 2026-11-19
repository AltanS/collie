# 0144: A crew has one lead and one door, and only the operator moves the crown

- **Status:** Accepted (2026-11-16); Superseded in part by [ADR 0161](./0161-a-members-gzip-is-inflated-by-the-runtime-under-the-leads-limits.md) (rule 10's second sentence)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0011, ADR 0012, ADR 0014, ADR 0015, ADR 0016, ADR 0023, ADR 0027, ADR 0028, ADR 0038, ADR 0039
- **Trail:** the other roads were argued in discussion #67 (a Collie with its own remote protocol,
  ADR 0011, 0015, 0016), in #248 (`crew add` from a lead with no commit, ADR 0015), in finding F2 of
  `CREW_PROTOCOL.md` §8.5 (a member's self-claim moved the crown, ADR 0014), in the owner's call of
  2026-09-09 to rename the wire too (ADR 0039 over 0038), and in the alternatives of
  `PACK_DEPUTY_RFC.md`. Files: `CREW_PROTOCOL.md`, `bridge/crew/`, `cli/crew.ts`, `cli/remote.ts`,
  `cli/crew-deputy.ts`, `docs/crew.md`

## Context

A crew is several machines and one phone. About fourteen records shaped it one road at a time, and this record states the rule of today in one place; the wire contract stays in `CREW_PROTOCOL.md`.
Records 0011 to 0028 say "pack" and `PACK_PROTOCOL.md`; read them as "crew" and `CREW_PROTOCOL.md`.

## Decision

1. **A crew is full Collie instances with one lead.** Each member keeps its own agents, journal,
   uploads and audit log. The lead talks to a member only through that member's Collie HTTP API under
   `/crew/v1/*`, never through its multiplexer socket. No multiplexer method name crosses the link,
   and a capability that Collie's API lacks is unreachable across it. A multiplexer reports one
   machine; the map of machines is the crew's (ADR 0036, which stays live).
2. **One managed front door per crew, on the lead.** A member publishes nothing: it takes down the
   mapping it recorded as its own and serves no PWA and no `/api/*` (a browser cannot pass its pinned
   handshake, so `COLLIE_PEER_BROWSER=1` only warns). Two factors admit a request on its `/crew/v1/*`
   prefix before any handler: pinned mutual TLS and the crew secret. The browser gate is never widened
   for it. The bind is `COLLIE_HOST`; a wildcard bind is warned, never refused.
3. **Code reaches a member over the operator's own SSH or from the public release, never over the
   crew link.** The link carries runtime data: no code of Collie, no update route, no restart, no
   command. The update rules are ADR 0143. Trick code may cross only as inert data, and it runs only
   after a person's tap on the machine that will run it.
4. **`crew add` is a courier.** It drives its own `ssh`, mints the same invite as `crew invite`, runs
   the same `collie join` on the far machine with the token on stdin, and adds no route. It never
   wraps `approve-promote` or `promote`. How the operator reaches a machine (`crew-ops.json`) never
   crosses the link.
5. **The operator is the quorum.** No election, no majority, no timer promotes a machine. Silence
   may arm a surface; it never authorises an act. A machine changes its own role without a person
   only on a proof the old lead signed, only downwards, and only with trust it already held.
6. **A promotion is a confirm on the machine being taken from.** The operator runs `collie crew
   approve-promote <member>` on the lead (ten minutes, single use, one live at a time), then
   `collie promote` on the member. The lead demotes only for that member and that pinned key.
   `promote --force` is for a lead that is gone, and every other member then re-joins.
7. **The operator names one deputy ahead of time.** The lead signs a warrant that binds the deputy's
   certificate fingerprint. A new generation replaces the old one; a revocation names nobody. The
   warrant lives 30 days from its last refresh. It arms in two phases: stored on a member, then
   anchored at that member's next restart, which `crew deputy` runs over SSH.
8. **A takeover asks before it acts.** It asks the lead, then the members, and one member that heard
   from the lead recently stops it. Only then does the deputy commit, and the warrant is spent. A
   returning old lead is deposed only by a warrant that verifies against its own key, and it heals
   to a member.
9. **The standby door is a second listener, bound and never published.** It exists only when
   `COLLIE_STANDBY_PORT` is set. It arms only while a verified warrant names this machine, the lead
   has been silent long enough, and the synced pairing list is not empty. The phone's pairing
   credential alone spends it; the device header is not a factor there.
10. **Each hop picks its own compression.** The lead asks a member for identity bytes and compresses
    the phone hop itself. An ETag names the identity bytes.
11. **The group is a crew, and the wire says crew.** Protocol version 2 is the only version. The
    typed spellings `collie pack`, `collie docs pack` and the web path `/pack` work until 2.0.0. The
    roles stay lead and deputy. The docs call the other machines members; the code still says peer.

## Today in the code

- Rule 1: `bridge/crew/forward.ts` maps a phone route onto the member's own API. `COLLIE_HERDR_DIAL`
  takes `auto`, `net` or `bun`, never a host (`bridge/config.ts`). `MuxTarget` takes no host and an
  adapter drops remote panes (`MUX_CONTRACT.md`, "Host locality"); `bridge/mux/host-candidates.ts`
  is the one seam where a multiplexer offers SSH targets to `crew add`.
- Rule 2: `releaseFrontDoor` (`bridge/index.ts`) and `releaseManagedFrontDoor` (`bridge/front-door.ts`)
  remove only the recorded mapping and never stop the boot; `bridge/index.ts` warns on
  `PEER_BROWSER_ENV` beside a pinned listener and on `warnsOnWildcardBind`. `CREW_PREFIX` is in
  `bridge/crew/router.ts`; `peerListenerTls` (`bridge/crew/transport.ts`) pins the lead and at most
  the deputy; `bridge/crew/admission.ts` is the two-factor gate, shares no code with `checkAccess`, and
  keeps the refusal reason in the member's own audit. No code path runs `tailscale funnel`.
- Rule 3: the `CREW_*_PATH` list in `bridge/crew/router.ts` has no update, install, exec or restart
  route. A trick proposal waits in a dot folder, files 0600 with no executable bit, until "Switch it
  on" (`bridge/tricks/proposals.ts`). The deputy's copy waits under `<stateDir>/standby-tricks/`,
  which no loader reads, and starts only from the takeover tap or `collie promote`
  (`bridge/crew/standby-tricks.ts`, `bridge/crew/carry-adopt.ts`).
- Rule 4: `cmdCrewAdd`, `sshOptions` (no host-key option) and `routeOf` in `cli/remote.ts`, which
  calls no promotion verb; `bridge/crew/ops-store.ts` holds `crew-ops.json`.
- Rule 5: `runBootGate` (`bridge/crew/boot-gate.ts`) asks once, at boot, and deposes only on a
  verified warrant. `armingReport` (`bridge/crew/standby.ts`) arms and grants nothing. `selfHeal` and
  `isDepositionProof` (`bridge/crew/deposed.ts`) only lower privilege and pin from the own roster.
- Rule 6: `approvePromotion`, `demoteSelf`, `HANDOVER_TTL_MS` (`bridge/crew/enrollment.ts`),
  `HANDOVER_NOT_APPROVED` (`bridge/crew/router.ts`), `cmdCrewApprovePromote` and `cmdPromote` in
  `cli/crew.ts`.
- Rule 7: `mintWarrant`, `refreshWarrant`, `WARRANT_TTL_MS` (`bridge/crew/warrant.ts`), `deputyAnchor`
  (`bridge/crew/transport.ts`), `cmdCrewDeputy` (`cli/crew-deputy.ts`).
- Rule 8: `runTakeover`, `probeAnswer` and `commitTakeover` in `bridge/crew/takeover.ts`.
- Rule 9: `armThresholdMs` and `STANDBY_PORT_ENV` in `bridge/crew/standby.ts`, the listener in
  `bridge/index.ts`. `standby-devices.json` joins the deputy's pairing list only at takeover commit
  (`bridge/crew/standby-devices.ts`). `/standby` is reserved on the front door (`bridge/index.ts`)
  and goes to the network in the service worker (`web/src/lib/sw-routes.ts`).
- Rule 10: the `accept-encoding: identity` request and the `vary` merge in `bridge/crew/forward.ts`.
- Rule 11: `CREW_PROTOCOL_VERSION = 2` (`bridge/crew/enrollment.ts`); `bridge/removal-schedule.test.ts`
  keeps the 1.8.0 overlap out. The `pack` entry and its TTY-only note (`cli/program.ts`), the `/pack`
  redirect (`web/src/router.tsx`), `DOC_PAGE_ALIASES` (`cli/docs-embed.ts`).

## Recorded, not found in the code

- "No multiplexer method name crosses the link" (ADR 0011) has no check. `scripts/check-crew-wire.sh`
  forces a recorded decision on a wire change, but it does not read vocabulary.

## Consequences

- Recovery waits for a person, and a two-machine crew has no witness; the standby page says so.
- A member the operator cannot reach over SSH gets no code from the lead; a stolen secret is no
  supply chain.

## What we tried before

- 0011: the lead talks to a member's Collie API, never its multiplexer socket.
- 0012, 0038, 0039: "pack" became "crew" for people, then on the wire; 1.9.0 removed the overlap.
- 0013, 0014: a member publishes no front door; a promotion needs the old lead's own confirm.
- 0015, 0016: `crew add` and `crew update` ride the operator's SSH; the crew link never carries code.
- 0023: compression is per hop; a pass-through shipped a blank pane in 0.32.0-beta.9.
- 0026 to 0028: the operator is the quorum, the deputy is named ahead, the standby door arms on
  silence. Raft, a majority, a cloud witness, a long timer and opt-in auto-promotion were turned down.
- 0084: each machine reports its load on the snapshot it already sends; the lead keeps the history.
