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
   three codes in an order fixed per request. Exactly one is the code on the new device's screen; the
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
   `enrolInQueue` with a code claim: the same token form, the hash only on disk, no expiry (as
   `collie pair` without `--expires`). The label is the approver's, checked like a `collie pair` label;
   a label in use gets a number instead of replacing a device. The token goes to the new device on its
   next poll, once; the entry is gone after that read.
5. **Bounds.** A request lives two minutes. At most three are open at once, and one source (the
   `/api/pair` source key) may ask six times in ten minutes; past either, `429` with `Retry-After`. With
   no paired device, the request is refused with `409 no-approver` before it counts, and the browser
   says to run `collie pair`. A wrong or missing poll secret reads as an unknown id, compared in
   constant time against a stand-in hash when the id is unknown. A token nobody collected within its
   window is revoked (`device.revoke`, reason `never-collected`). Everything lives in memory; a restart
   drops every request.
6. **Audit.** `pair-request` (route), `pair-approve` (approver, new label, both routes) and
   `pair-request-refused` (`wrong-code`, `refused`, `expired`, `rate`). No line holds a code, an id, the
   secret or the token.
7. **No crew, no CLI, no WalkyTalky.** A crew member serves no browser door and answers `404`. There is
   no CLI verb, no walky op, and no Settings entry on the approving side: the QR is the one way in.

## Consequences

- An unpaired browser can make a request, which costs it nothing: a request holds no credential, and
  only a paired device's tap turns it into one. The three-open cap means a busy asker can keep a
  second one waiting for up to two minutes; the source cap keeps one source from doing it for long.
- Cancel on the new device forgets the secret in that tab; the bridge keeps the request until it runs
  out, since there is no cancel route. Three cancels in two minutes reach the open cap.
- The QR encoder is the app's own (`web/src/lib/qr.ts`), because the CLI's (`qrcode-terminal`) is a
  CommonJS root dependency. `scripts/qr-web.test.ts` holds it to that encoder module for module and to
  jsQR.
- A program that runs as the user and drives a paired browser can tap the code as the user does. That is
  the same reach the paired browser's profile already gives ([What a program running as you can still
  do](../docs/security.md#what-a-program-running-as-you-can-still-do)), so the table gains no row.
