# 0139: A paired phone lets a browser in by picking its code

- **Status:** Accepted
- **Date:** 2026-11-11
- **Shipped in:** pending
- **Trail:** Altan, 2026-11-11, on a desktop browser that showed "Access refused. This is not a
  connection problem.": "would it be possible to show a qr code here that i scan with my phone to give
  the desktop app access somehow?" · ADR 0086 (reads need the pairing token) · `bridge/pair-request.ts`
  · `bridge/pairing.ts` (`enrolApproved`, `uniqueLabel`, `hasLiveDevice`) · `bridge/pair-audit.ts` ·
  `web/src/components/pair-with-phone.tsx` · `web/src/routes/pair-approve.tsx` · `web/src/lib/qr.ts`

## Context

Until now a device paired in one way: `collie pair` in a terminal on the bridge's machine, then the code
typed (or its QR scanned) on the device. A person at a second computer, with a phone that is already
paired in their pocket, had to find a terminal on the host first. The phone is the device they trust,
and it can already do everything a new device could; it only had no way to say "let that one in".

The risk in a phone-side approval is the link. Whatever the new device shows, a QR or a URL, is a
string. Anyone who can reach Collie can ask for a request and send its link to the owner ("tap this to
fix Collie"). A screen with a Yes on it would then pair the stranger's browser on one careless tap.

## Decision

1. **The new device asks, the paired device answers.** `POST /api/pair/request` is open to an unpaired
   browser under the same `Origin` rule as `/api/pair`. It answers a public id, a poll secret, a
   6-character code from the pairing alphabet and the expiry. The browser shows a QR to
   `<origin><mount>/pair/approve?r=<public id>`, the code in large type and a two-minute countdown, and
   polls `GET /api/pair/request/<id>` with the secret in the `x-collie-pair-poll` header.
2. **The approver picks the code; there is no Yes.** The approver page shows the asker's browser and
   system family (from a fixed list, never the raw User-Agent), the network class it asked from, and
   three codes in an order fixed per request, under "Only if you started this on a screen in front of
   you." The network line states the socket's class only. A loopback socket with an `X-Forwarded-For`
   reads "through a front door on this computer", and the class the door passed on is shown as its
   word, which Collie cannot check; `tailnet` is never stated as a guarantee. An `internet` or `unknown`
   class, socket or claim, adds a warning line. Exactly one is the code on the new device's screen; the
   two decoys differ from it, and from each other, in at least three of six places. A stranger who sent
   the link cannot make the owner see the right code, so a tap on it proves that the person holding the
   paired phone sees the other screen. A wrong tap ends the request for good, as does "Not my device".
   Without the other screen, a tap is a one-in-three guess on one request, and the asker cannot try
   again on the same request.
3. **Only a device with full access answers.** `GET /api/pair/approve/<id>` and `POST` take the same gate
   as a trick's switch: a paired token, and the device header's allowlist when one is set. The GET runs
   at `device-read` because a same-origin GET carries no `Origin`; the POST at `write`. The CLI's local
   read credential, an unpaired browser, a header-only device and a crew forward are refused.
4. **The right code enrols through the claim's own code.** `PairingStore.enrolApproved` shares
   `enrolInQueue` with a code claim: the same token form, the hash only on disk. The new device takes
   the approver's `expiresAt` when the approver has one, so a device never outlives the one that let it
   in, and the approver page says so ("This device's access ends with yours, on <date>."). An approver
   with no expiry gives none, as `collie pair` without `--expires`. The label is the approver's, checked like a `collie pair` label;
   a label in use gets a number instead of replacing a device. The token goes to the new device on its
   next poll, once; the entry is gone after that read.
5. **Bounds.** A request lives two minutes. At most three are open at once, and one source (the
   `/api/pair` source key, an IPv6 address cut to its /64) may ask six times in ten minutes. Every try
   counts, one refused with `409 no-approver` too (the browser then says to run `collie pair`). The
   bridge makes at most 30 requests in ten minutes whatever the source: five sources at their own cap,
   enough for any person pairing a few browsers, and a spray of sources then costs three small entries
   and three audit lines a minute, not an unbounded stream. Past any cap, `429` with `Retry-After`. One
   source has one open request: a new one replaces its waiting one (and revokes a device approved for
   it and not collected). `DELETE /api/pair/request/<id>` with the poll secret ends a request, under the
   same open-route rules and the same `404` for a wrong secret; the browser sends it on Cancel and when
   the block goes away. A request stuck `answering` (an enrol that hangs) ends 30 seconds after its
   expiry, and an enrol that finishes after its request ended is revoked at once. A wrong or missing poll secret reads as an unknown id, compared in
   constant time against a stand-in hash when the id is unknown. A token nobody collected within its
   window is revoked by its token's hash, never by label, through the device list's own revoke path
   (one `device.revoke` line with reason `never-collected`, one `device-revoked` effect). Everything
   lives in memory; a restart drops every request. A restart between the tap and the collect therefore
   leaves a listed device whose token nobody holds; the person removes it in the device list.
6. **Audit.** `pair-request` (route), `pair-approve` (approver, new label, both routes) and
   `pair-request-refused` (`wrong-code`, `refused`, `expired`, `cancelled`, `replaced`, `rate`). A run of
   `rate` refusals writes one line: per burst for one source, per window for the global caps. No line
   holds a code, an id, the secret or the token.
7. **No crew, no CLI, no WalkyTalky.** A crew member serves no browser door and answers `404`. The
   standby door serves its three `/standby/*` routes and no `/api/*`, so no request reaches it there.
   A device made here is an ordinary registry entry, so the lead's sync to the deputy
   (`syncedDevicesOf` over the whole registry) carries it, with its expiry, like any other. There is
   no CLI verb, no walky op, and no Settings entry on the approving side: the QR is the one way in.

## Consequences

- An unpaired browser can make a request, which costs it nothing: a request holds no credential, and
  only a paired device's tap turns it into one. The three-open cap means a busy asker can keep a
  second one waiting for up to two minutes; the source cap keeps one source from doing it for long.
- Cancel on the new device ends the request on the bridge and forgets the secret in that tab. A cancel
  that does not arrive (a closed tab offline) leaves the request to run out; the one-per-source rule
  keeps it from filling the open cap.
- The QR encoder is the app's own (`web/src/lib/qr.ts`), because the CLI's (`qrcode-terminal`) is a
  CommonJS root dependency. `scripts/qr-web.test.ts` holds it to that encoder module for module and to
  jsQR.
- A program that runs as the user and drives a paired browser can tap the code as the user does. That is
  the same reach the paired browser's profile already gives. A local program can also ask for a request,
  show its code in a pane and write the front door's header to choose the network line; it still needs
  the tap on a paired device. That row is in [What a program running as you can still
  do](../docs/security.md#what-a-program-running-as-you-can-still-do).
- The code proves someone sees the other screen, not who. A stranger who can reach Collie can start a
  request and read the owner its code over a call; the approver line and the docs say to tap only for a
  request started on a screen in front of you.
