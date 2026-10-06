# 0086 — Reads need the pairing token

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** pending
- **Amends:** [ADR 0083](./0083-the-files-view-reads-the-changes-root.md), whose context named reads
  as open to every device past the front door. The Files view's `device-read` level stands; the
  read-side fact does not. Also [ADR 0028](./0028-the-standby-door-is-a-second-listener.md), in its
  reasoning only: the deputy still keeps the lead's registry apart from its own, for a new reason.
- **Trail:** M46 specs 03 and 06 (2026-10-07) · `bridge/pairing.ts` (`PairingStore.enforced`) ·
  `bridge/server.ts` (`guard`, `PairingGate`, `requestDevice`, `/api/snapshot`, the `/api/*`
  catch-all, `WORKTREE_LIST_ROUTE`, `/api/pair`, `pairingRefusal`) · `bridge/crew/forward.ts`
  (`forwardHeaders`) · `bridge/crew/router.ts` (`createCrewRouter`) · `bridge/crew/peer-gate.ts`
  (`crewGate`) · `bridge/crew/standby.ts` · `bridge/crew/standby-devices.ts` · `cli/doctor.ts`
  (`pairedDevices`) · `cli/lifecycle.ts` (`statusView`) · `cli/pairing.ts` · `scripts/install.sh` ·
  `scripts/install.ps1` · `web/src/lib/api.ts` (`isPairingRefusal`, `fetchAuthedBytes`) ·
  `web/src/lib/authed-url.ts` · `web/src/components/authed-image-card.tsx` ·
  `web/src/lib/operator-fonts.ts` · `web/src/lib/mux-capability.ts` (`useMuxLogoUrl`) ·
  `web/src/components/agent-list.tsx` (`notPaired`) · `web/src/components/connection-banner.tsx` ·
  `web/src/lib/operator-config.ts` · `web/e2e/live/pair.ts` · `docs/security.md` ·
  `CREW_PROTOCOL.md` §18 · `ARCHITECTURE.md` §6

## Context

Pairing was a write gate, and it was on only while the registry held a device. Both halves left the
same hole: anything that reached the port could read.

- **Reads were open.** A snapshot, a pane's text, a chat transcript, a journal picture and the
  Changes diff answered every request that passed the host and Origin checks. Pane text is where
  secrets show up: an `.env` an agent printed, a token in a command line, a key in a stack trace.
- **The port is shared on the host.** A different uid on the same machine reaches
  `127.0.0.1:$COLLIE_PORT` (ARCHITECTURE.md §6). The header gate and pairing made that uid
  read-only, and read-only still read everything.
- **A fresh install was open for writes too.** Until the first `collie pair`, nothing gated
  anything. The install printed no pair step, so an operator who never got to it ran an open shell
  on the tailnet. Revoking the last device switched the gate off again, by design, to avoid a
  lockout.
- **M46 caches session text on the phone.** Once a cold open renders a cached herd, the credential
  that unlocks it has to be the same one that unlocks the live reads, or the cache is the weaker
  door.

## Decision

**Reads need the pairing token, and pairing is always on.**

1. **Every `/api/*` route asks the pairing gate, reads included.** A request without a valid,
   unexpired bearer token gets `403 device not paired` (or `403 device expired`), the same bodies a
   write got. A route the bridge does not know answers the same 403 before its 404, so a probe
   learns nothing about the route table without a token.
2. **Two routes stay open.** `/api/health`, which monitors, load balancers and the updater ask,
   and `/api/pair`, which a device needs before it holds a token. `/api/pair` keeps its own gates:
   a same-origin `Origin`, the ten-attempts-per-minute limit and the five-tries-per-code rule.
3. **Pairing is always on.** `PairingStore.enforced()` answers true, with or without a device. An
   empty registry refuses every route but the two above. Revoking the last device does not open
   the bridge again; the recovery is `collie pair` on the host. The `/api/devices` wire field
   `enforced` stays, and is always true.
4. **The header gate does not change.** `COLLIE_DEVICE_HEADER` still gates writes and the Files
   view's `device-read`, and nothing else. The two gates still compose by AND. The write-side
   Origin rule does not change either.
5. **The crew link and the standby door keep their own credentials.** A lead forwards a phone's
   read to a member through `bridge/crew/forward.ts`, whose header allowlist never carries
   `Authorization`. The member's `/crew/v1/*` routes admit the call on pinned mutual TLS plus the
   crew secret, and `crewGate` decides the level with no pairing input. So a member whose own
   registry is empty still answers a forwarded read. The lead has already checked the phone's token
   at its own front door. The standby door checks the operator's token against
   `standby-devices.json` on its own listener, as before.
6. **The phone treats the refusal as a pair prompt, not an outage.** A `403 device not paired` on
   the first snapshot sets the pairing latch. The dashboard shows **Pair this device** with the
   command, the banner links to the pair form, and the connection strip stays quiet because the
   bridge answered. A proxy's own 401 or 403 still shows the proxy sign-in banner.
7. **Subresources carry the token too.** An `<img src>` or a CSS `url()` cannot send an
   `Authorization` header. A journal picture and the multiplexer's mark are fetched with the token
   and drawn from an object URL. An operator font is fetched with the token and added as a
   `FontFace` built from its bytes, so the CSP's `font-src` never has to admit `blob:`.
8. **The operator is told.** `collie doctor` warns "no device paired yet: run collie pair" (check
   `pairing`). `collie status` names the step while no device is paired, and both installers print
   it as a numbered step.

## Consequences

- **This is a break in a 1.x minor.** An operator who never paired loses the phone at the update
  until they run `collie pair`. A script that `curl`s `/api/snapshot` needs a token. The release
  must name the break, and the update band must say what to run.
- **Recovery needs the host.** A phone that lost its token, or a registry emptied by revocation,
  is fixed only from a terminal on the host. That is the point: the remedy for a lost credential is
  the operator, not the network.
- **Another uid on the host reads nothing without a token.** The token is now the boundary. A uid
  that can read the browser profile can read the token too, so an unshared port is still the only
  full answer to issue #33.
- **The live e2e tier pairs.** Tier 2 (`web/e2e/live/`) can no longer read as an anonymous
  browser. Its global setup takes a token or a code the operator gives it, once.
- **Header-injection checks by `curl` changed.** With a token, the snapshot's `device` field names
  the paired label, not the header's value, so the `docs/deployment.md` recipes that read the
  header back through `.device` need another probe.
- **Revisit if** a read must be shared without a device, for example a status badge. That would be
  a new route with its own named exception here, never a relaxed gate on an existing one.
