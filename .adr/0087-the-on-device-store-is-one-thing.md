# 0087: The on-device store is one thing

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** 1.18.0
- **Relates to:** [ADR 0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) (a
  password prompt drops that pane's records; nothing in it is retracted),
  [ADR 0052](./0052-one-build-serves-any-mount.md) (the mount is the instance a record belongs to),
  [ADR 0086](./0086-reads-need-the-pairing-token.md) (reads need the token, so a write to the store
  only follows a paired read).
- **Trail:** the 1.17 header of `web/src/lib/last-seen.ts`, which argued for sessionStorage on
  purpose ("a mirror of someone else's terminal ... misleading a day later"), against the operator's
  ask on 2026-10-06 that a cold open shows what the phone last saw · the M46 audit at 3d562ae5 and
  the six advisors of 2026-10-06 (the cache must sit on a hardened device first: specs 01 to 07) ·
  `web/src/lib/store.ts` · `web/src/lib/last-seen.ts` · `web/src/lib/wipe.ts` (`onWipe`) ·
  `web/src/lib/loaders.ts` (`staleHome`, `stalePane`) · `web/src/lib/storage-keys.test.ts` ·
  `docs/security.md` → *What the phone keeps*

## Context

A phone kills a PWA all the time. Until 1.18.0 the last snapshot and four pane mirrors lived in
sessionStorage, which survives a discarded tab and dies with the process, so a cold open with no
bridge in reach showed nothing. sessionStorage was chosen on purpose: a mirror is someone else's
terminal, and a copy kept on disk is a copy that can be read later. That argument was right for a
phone whose token never expired, whose unpair left most data behind, and whose text carried secrets
in the clear. Specs 01 to 07 of M46 closed those three holes, so the argument no longer holds.

Two other roads were open. localStorage is synchronous and already holds the token, the drafts and
the preferences, but it is about 5 MB per origin and already strained, and a 600-line mirror per
pane eats it fast. Cache Storage is meant for responses, and a service-worker cache of API answers is
a non-goal of this milestone. IndexedDB is asynchronous, large, and the only store with transactions,
so a write can weigh the whole cache and evict in one step.

The risk this ADR answers is drift: a second feature adding its own little store, with its own
lifetime and no wipe. So the decision is less "use IndexedDB" than "there is one store".

## Decision

**Session content the phone keeps past a page's life lives in one IndexedDB database,
`collie-store`, behind one module, `web/src/lib/store.ts`. Nothing else stores session content.**

### What the phone persists

| What | Where | Owner | Bound | Lifetime | At unpair |
| --- | --- | --- | --- | --- | --- |
| Device token | localStorage `collie:device-token` | `lib/pairing.ts` | one value | until unpair, revoke or expiry (spec 01) | wiped |
| Preferences (theme, face, locale, pins, display) | localStorage `collie:*:v1` | each pref module | one value each | forever | kept: no session content |
| Drafts | localStorage `collie:draft:*` | `lib/drafts.ts` | 8 Ki characters each on disk | 48 h (`MAX_AGE_MS`) | wiped |
| Push endpoint | localStorage `collie:push-endpoint` | `lib/push-endpoint.ts` | one value | until it changes | wiped, and the subscription is dropped |
| App shell | Cache Storage `workbox-precache-*` | `sw.ts` | the build | until the next build | kept: the pair form must open offline |
| Fonts, push titles | Cache Storage `collie-fonts`, `collie-push-titles` | `sw.ts`, `lib/push-title-store.ts` | the files | until replaced | wiped, refilled on use |
| Navigation and reload guards | sessionStorage `collie.nav.*`, `collie:auto-reloaded-for=*` and others | their modules | one value each | the tab | kept: app paths and build ids only |
| **The store** | **IndexedDB `collie-store`** | **`lib/store.ts`** | **256 KiB per pane, 10 MiB in all** | **24 h by default, per record** | **the whole database is deleted** |

`web/src/lib/storage-keys.test.ts` holds the full key list and fails on a key or a database that has
no fate in it.

### What the store holds

Session content only, as the bridge sent it to be drawn, after redaction (spec 07):

- `snapshot`: the pane-list snapshot, one per scope and breadth (the herd a cold open draws, spec 10).
- `pane-text`: the last-seen mirror of a pane. It replaces the 1.17 sessionStorage mirror.
- `chat-tail`: the rendered Chat blocks of a pane (spec 09). The raw mirror never goes in.

Drafts stay in localStorage, because a draft must restore synchronously on mount.

### The rules

1. **Every record carries `fetchedAt`** (epoch ms, when the bridge answered with it) **and its
   instance**: the mount the app was served under. IndexedDB is per origin and two bridges can share
   an origin under two mounts, so a read sees only its own mount's records. Age is always computed
   from `fetchedAt`, never from the time of a later write.
2. **A lifetime per record**, 24 hours unless the caller names one (spec 09's setting narrows or
   widens it for the Chat tail). An expired record reads as a miss and is deleted.
3. **Two caps, measured as the UTF-8 bytes of the record's JSON.** The records of one pane share
   256 KiB; the database holds 10 MiB. A write past either evicts the least recently fetched records
   first, inside the same transaction. A record that cannot fit is refused, and the older record under
   its key is deleted with it: older text than the phone was last handed is worse than none.
   `last-seen.ts` keeps the newest lines of a mirror past the pane cap, cut at a line start.
4. **A purge on open** deletes every expired record, every record from another schema version, and
   whatever the total cap no longer allows. The schema version is the database version too: an upgrade
   that cannot migrate drops the contents, and a database from a newer build is deleted and reopened.
5. **`navigator.storage.persist()` is asked once a page session, on the first write**, after
   `persisted()` says no. A write only follows a paired read (ADR 0086), so this is after pairing.
   The answer is kept in `storeStatus()` and never shown. Safari 17+ grants it to a home-screen app
   without a prompt, and a refusal only lets the browser evict the cache under pressure.
6. **One wipe.** The store registers one cleaner with `lib/wipe.ts`, `onWipe("store", …)`. A
   pairing that ends (unpair, revoked, expired) deletes the whole database, every mount's records with
   it, as the Cache Storage cleaner already does for sibling mounts. Nothing else clears it.
7. **A password prompt (ADR 0017) drops that pane's records**, of every kind, through the same
   cleaner (`wipeDevice("password", pane)`). The pane's text is not written while the prompt is up.
8. **Nothing in the store may trigger an action** (spec 11). The store hands out dated values to
   draw; it never interprets them, and no send, reply or key may be built from a stored record.
9. **Failure is silent and safe.** Every call is async and never rejects. With IndexedDB missing,
   blocked (private mode) or hung past 3 s, the store runs on a memory map for the rest of the page
   session, with the same bounds, and `storeStatus().mode` reads `memory`. A full database refuses the
   write that does not fit and keeps the rest. The app then works as 1.17 did, with no cache across a
   restart, and says nothing about it.
10. **One queue.** Operations run in the order they were called, so a write followed by a wipe of the
    same pane leaves nothing behind, whatever the transactions' timing.

### Purge triggers, and what each clears

| Trigger | Clears |
| --- | --- |
| A page opens the store | expired records, other-schema records, the oldest past 10 MiB |
| A write | the oldest of its pane past 256 KiB, then the oldest anywhere past 10 MiB |
| A read finds an expired record | that record |
| Unpair, `device not paired`, `device expired` | the whole database |
| A password prompt on a pane | that pane's records |
| A schema bump | every record, in the upgrade |
| The 1.17 sessionStorage mirror at boot | `collie:last-snapshot:*` and `collie:last-pane:*`, deleted once |

## Consequences

- A cold open can draw what the phone last saw, dated, for up to a day by default. Spec 10 draws it;
  spec 09 adds the Chat tail. Both build on this module and add no store of their own.
- The read of the last-seen cache is now async. `loaders.ts` awaits it in `staleHome` and
  `stalePane`, which only run on a failed or skipped fetch.
- Session text now outlives the process on disk. The hardening of specs 01 to 07 is what makes that
  acceptable: an expiry the operator chose, one wipe, and redaction before text leaves the machine.
- In a browser with no working IndexedDB the cache is per page session, which is less than 1.17's
  per-tab sessionStorage in one case: a discarded tab restored in private mode. That case was rare
  and the app still works.
- A poll that brings the same value as the last write makes no IndexedDB write. The store keeps a
  signature per record and writes an unchanged value again only after `REWRITE_AFTER_MS` (5 minutes).
  So a skipped record's `fetchedAt` reads at most 5 minutes older than the truth, never younger, and
  a live, unchanged pane never runs out its lifetime. Every delete, eviction, purge and wipe forgets
  the signature, so a skip never stands in for a record that is gone. A changed value is one
  transaction with one small `getAll` over the record index. If that ever shows on a phone's
  battery, widen the window; do not move the cache back to a synchronous store.

## Open questions

Each one has a device test. Neither has run yet; record the result here when it does.

- **Does iOS back up WebKit site data?** A 2022 WebKit change hints that localStorage is excluded
  from backups. If IndexedDB is included, a phone backup carries a day of session text to wherever
  the backup goes. *Test:* pair an iPhone, open a few panes so the store holds records, make an
  encrypted and an unencrypted backup, restore each to a second device, open the home-screen app
  with the bridge unreachable, and note what draws. Check the token, a draft and the store.
  *Result:* not run.
- **Does a non-extractable `CryptoKey` survive a backup?** It matters only if the token or the store
  is ever encrypted at rest (a follow-up, out of scope here). *Test:* the same backup and restore,
  with a non-extractable AES-GCM key stored in IndexedDB beside a value it encrypted; after the
  restore, try to decrypt. *Result:* not run.
