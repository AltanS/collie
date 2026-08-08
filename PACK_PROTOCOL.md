# Pack protocol v1 — the lead↔peer contract

The wire contract for **pack federation**: several machines each running a full Collie, one of them
holding the phone-facing front door. Sibling to [`HERDR_API.md`](./HERDR_API.md), which documents the
contract *below* Collie (the Herdr socket); this documents the contract *between* Collies.

**Provenance convention**, mirroring `HERDR_API.md`:

- **Verified** — read first-hand out of this repo at the cited `file:line`. Existing behaviour.
- **Specified** — normative for v1, **not implemented yet**. Nothing federation-shaped exists in
  `bridge/` today (searched for `peer`, `pack`, `federat`, `remote`: no hits). Every requirement
  below is a promise this document makes to M3–M6, not a property you can probe.

Unmarked prose is Specified. Where a rule extends existing behaviour, the existing behaviour is
cited so a reviewer can check the extension is faithful.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **collie** | One Collie instance — one bridge process on one machine. Every pack member runs a full one. |
| **lead** | The one collie that holds the managed front door. The phone talks to the lead and to nothing else. |
| **peer** | A collie with no front door, reached only by the lead over an authenticated pack link. |
| **pack** | The lead plus its enrolled peers. One lead per pack, always. |
| **member** | A collie enrolled in a pack — lead or peer. Identified by a **member id**. |
| **solo** | A pack of one: a lead with zero enrolled peers. Today's Collie, exactly. |

These are the shipped words. Earlier drafts said *alpha* for *lead* and *bridge* for *collie*; both
are dead. The vocabulary decision and the rename rules for operator-visible surfaces are
[ADR 0012](./.adr/0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md).

## 2. Shape of the thing

```
  phone ──HTTPS──▶ lead ── /api/*  (unchanged, today's handlers)
                    │
                    ├── pinned mTLS + pack secret ──▶ peer A  /pack/v1/*
                    └── pinned mTLS + pack secret ──▶ peer B  /pack/v1/*
```

Three rules generate most of this document:

1. **The lead consumes a peer's *Collie* HTTP API.** The lead **never dials a peer's Herdr socket**,
   and no Herdr method name ever crosses a pack link. This is the mux-driver seam — a peer fronting
   something other than Herdr is invisible to this protocol. Argument:
   [ADR 0011](./.adr/0011-the-pack-protocol-is-the-mux-driver-seam.md).
2. **A peer publishes nothing.** No `tailscale serve`, never `tailscale funnel`, no PWA, no browser
   gates. A peer's pack listener is not a front door.
3. **Solo pays zero tax.** With zero peers enrolled, every observable byte is what it is today (§11).

### Why peers run a full Collie

The cheaper design is obvious and will be re-proposed: let the lead dial a *remote Herdr socket* over
a forwarded connection and skip the second Collie entirely. It does not work, for reasons that are
structural rather than aesthetic:

- **The journal is host-local by rule.** `bridge/journal/` reads the agent's own session log off the
  disk it was written to, and every path goes through `containedRealpath()`
  (`bridge/journal/files.ts:39`). A forwarded socket moves the terminal and strands the transcript.
- **Uploads are host-local by necessity.** `uploadPane()` writes into `<stateDir>/uploads` and returns
  the **absolute local path** to be typed at the agent (`bridge/server.ts:1075-1090`). Herdr on *that*
  machine must be able to open it. A file on the lead's disk is useless to an agent on the peer.
- **Audit is host-local by design.** `<stateDir>/audit.log` is the record of what happened on *these*
  terminals (`bridge/audit.ts:64-67`). A forwarded socket writes every peer's history into the lead's
  log and leaves the peer's own operator with nothing.
- **It welds Collie to Herdr.** The wire format would become Herdr method names, and the seam in rule
  1 would not exist.

---

## 3. Roles and modes

A collie runs in exactly one mode, decided by its enrollment state, not by a flag the operator
maintains by hand.

| Mode | Front door | Serves the PWA | Browser gates (`checkAccess`) | Pack listener |
|---|---|---|---|---|
| **solo** (lead, 0 peers) | yes | yes | yes | none — nothing is opened |
| **lead** (≥1 peer) | yes | yes | yes | none inbound; dials outbound |
| **peer** | none | **no** | n/a (no browser reaches it) | `/pack/v1/*` only |

In **peer mode the browser-facing surface is disabled**: `serveStatic()` (the SPA fallback,
`bridge/server.ts:386`), the `/auth` reserved placeholder (`:383`, `isReservedAuthPath()` `:1347`) and
the `/api/*` routes are not served to the pack listener. A peer answers `/pack/v1/*` and nothing else.

**There is no second port.** The pack surface is a path prefix on the collie's existing listener, with
its own admission path.

**The bind is `COLLIE_HOST`, and the operator owns it** *(amended 2026-08-08 — see below)*. The pack
listener answers on the one address `COLLIE_HOST` names (`bridge/config.ts` `host`, default
`127.0.0.1`); `Bun.serve` takes a single `hostname`, so there is exactly one bind, not a pair.
`join` does not touch it — reachability is the operator's to own here exactly as it is at §8.2 and
everywhere else in this design. The bind bounds only **which interface the listener answers on**; it
is **pinned mutual TLS + the pack-secret admission that actually gates** every request (§8.1). A
wider bind therefore widens *who can attempt* the gate, never *who passes* it.

Concretely: a peer reachable only over an overlay or a LAN must set `COLLIE_HOST` to that interface
— a loopback-only bind refuses the lead's dial. `COLLIE_HOST=0.0.0.0` (or `::`, or empty) binds all
interfaces; that is not a hole — the two factors still gate — but it is worth stating, so a peer on a
wildcard bind emits a loud one-line startup warning naming the effective bind, and `collie pack
status` shows the resolved bind so an operator can see it rather than infer it. Collie **warns, it
does not refuse to start** (ADR 0013's posture: a startup refusal it cannot justify is paternalism).

> **Amendment (2026-08-08, F3).** Earlier drafts of this section claimed a peer "binds loopback plus
> exactly the address the operator supplied at `join` time — nothing wildcard, no `0.0.0.0`". That
> dual-bind was never implemented and is not expressible (`Bun.serve` takes one `hostname`); the real
> bind is `COLLIE_HOST` alone, and nothing warned on a wildcard. The claim overstated a control — the
> exact failure ADR 0013 names — so it is corrected here to match the code, and the guardrail its
> intent wanted (the wildcard-bind warning + the `pack status` bind line) is now built.

The posture argument (front door vs. pack listener, and what an off-loopback bind costs) is
[ADR 0013](./.adr/0013-a-peer-listens-without-becoming-a-front-door.md), which amends ADR 0001 to
*one managed front door **per pack***; this document takes its conclusion as given.

---

## 4. Addressing — the host dimension

**Verified today:** session selection is one line. The bridge reads `?session=<name>` off the URL
(`bridge/server.ts:172`) and resolves it through the registry — absent or blank selects the primary,
unknown returns `undefined` and the caller 404s (`bridge/sessions.ts:154-157`). In the browser the
same value travels as the short `?s=` (`web/src/lib/session.ts:10,28-31`) and `withSession()` renames
it to `session=` on the wire (`web/src/lib/api.ts:70-77`).

**Specified:** a pane is addressed by the triple **`(host, session, paneId)`**.

- Browser URL: **`?h=<member-id>`**, alongside the existing `?s=<session>`.
- Wire (phone → lead): **`host=<member-id>`**, alongside `session=<name>`, exactly as `?s=`→`session=`.
- **Absent or blank `h` means the lead itself.** This is the whole backward-compatibility story: every
  URL, every bookmark, every link and every cache key that exists today keeps resolving unchanged, and
  a solo instance never emits the parameter (mirroring `sessionSearch()` returning `""` for the
  primary session, `web/src/lib/session.ts:28-31`).
- A **member id** is `[a-z0-9][a-z0-9-]{0,62}`, minted by the lead at enrollment. It is not a
  hostname, not an address, and carries no routing information.
- **A client-supplied host is only ever a registry key.** It selects among members the trust store
  already holds; it never builds a filesystem path and it never becomes an address the lead dials.
  This is the identical rule the session name has carried since multi-session shipped, and for the
  identical reason (`bridge/sessions.ts:17-20`). An unknown host is a **404**, matching
  `unknownSession()` (`bridge/server.ts:174-175`).
- `?h=` composes with `?s=`: the session named is a session **on that host**. A pack link never
  forwards its own `host=` — a peer has no peers.

The `(host, session, paneId)` triple is also the cache-key shape. Today's pane ETag cache is keyed by
the NUL-joined `(session, paneId)` pair precisely because pane ids collide across servers
(`web/src/lib/api.ts:201-203`); a second Collie is another such server, so the key widens by one
component and the reasoning is unchanged.

---

## 5. The peer surface — `/pack/v1/*`

A peer's pack routes are a **1:1 re-exposure of the routes the phone already calls**, dispatched into
the same handlers. There is no second handler set, no second semantic, and no Herdr vocabulary.

| Method | Path | Backs onto (Verified) | Lead treatment |
|---|---|---|---|
| `GET` | `/pack/v1/snapshot` | `GET /api/snapshot` (`bridge/server.ts:177`) | **merged** — the only merged route |
| `GET` | `/pack/v1/pane/:id` | `GET /api/pane/:id` (`:276`) | proxied byte-for-byte |
| `GET` | `/pack/v1/pane/:id/history` | `GET …/history` (`:277`) | proxied byte-for-byte |
| `POST` | `/pack/v1/pane/:id/reply` | `POST …/reply` (`:279`) | forwarded |
| `POST` | `/pack/v1/pane/:id/keys` | `POST …/keys` (`:280`) | forwarded |
| `POST` | `/pack/v1/pane/:id/upload` | `POST …/upload` (`:281`) | forwarded (§13) |
| `POST` | `/pack/v1/pane/:id/close` | `POST …/close` (`:282`) | forwarded |
| `POST` | `/pack/v1/pane/:id/rename` | `POST …/rename` (`:283`) | forwarded |
| `POST` | `/pack/v1/tab` | `POST /api/tab` (`:218`) | forwarded |
| `POST` | `/pack/v1/tab/:id/rename\|close` | `TAB_ACTION_ROUTE` (`:102`, matched `:234`) | forwarded |
| `POST` | `/pack/v1/workspace` | `POST /api/workspace` (`:225`) | forwarded |
| `GET` | `/pack/v1/config` | `GET /api/config` (`:288`) | consumed by the lead, not proxied |
| `GET` | `/pack/v1/hello` | — (new) | consumed by the lead: liveness + version + member id |

`?session=` is accepted on every session-scoped pack route with today's exact semantics (absent →
primary). It is the peer's *own* session registry that resolves it.

**Deliberately not on the pack surface**, because they are properties of the collie the phone talks to
rather than of a herd: `POST /api/subscribe` (`:303`), `POST /api/notifications/snooze` (`:318`),
`GET|POST /api/notifications/prefs` (`:340`), `POST /api/update/check` (`:367`). Push subscriptions
live on the lead; notification policy is one pack-wide setting the lead owns; update checking is
per-machine and is the operator's business on each. A peer's own `/api/*` surface still has them for
its own operator, when that peer is being used directly.

**No upload-read route exists on either surface.** `POST …/upload` stores a file and returns its
absolute local path (`bridge/server.ts:1090`); nothing serves it back over HTTP today (verified: the
pane route family `bridge/server.ts:93` has no read action for uploads). If one is ever added, it is a
proxied byte-for-byte read like the mirror, and it reads from the **owning peer's** disk.

**The membership routes are a separate, smaller table.** They are not re-exposed phone routes and
never will be — they carry no pane data, take no `?session=`, and are addressed to the collie rather
than to anything it fronts. They exist because three operator verbs are otherwise undeliverable:

| Method | Path | Sent by | Meaning |
|---|---|---|---|
| `POST` | `/pack/v1/enroll` | a joining machine | The exchange of §8.2. Admitted by the **token**, not by the two factors — the joining peer holds neither yet. |
| `POST` | `/pack/v1/secret` | the lead | Hands a peer the rotated pack secret (§8.4). Refused unless the caller is *this collie's own lead*: the secret is pack-wide, so any other admitted member accepting one could lock the lead out of its own pack. Authenticated by the **outgoing** secret and carrying the incoming one — there is no instant in which both are accepted. |
| `POST` | `/pack/v1/lead` | the member being promoted | "The member calling you is the lead now" (§14). The old lead demotes itself and answers with its roster (the only way the new lead can pin members it has never spoken to); a peer re-pins and keeps its id and the pack secret. A member may only claim leadership **for itself**. |
| `POST` | `/pack/v1/leave` | any member | The caller removes **itself** from this collie's roster (§8.4). The member id is the admitted one, never a body field, and a second call is still `200` — the operator's question has the same answer either way. |

Everything except `enroll` sits behind the same two factors as the rest of the prefix, and each
carries a role check on top: *admitted* and *allowed to do this* are different questions.

**Reserved paths.** `/pack/v1/` must never collide with `/auth`, `/auth/*` (reserved for a fronting
proxy, `bridge/server.ts:1347`, matched `:383`) or `/cdn-cgi/`. It is also **denylisted in the service
worker's route table** (`web/src/lib/sw-routes.ts`) — a browser never issues a pack request, so a
browser must never be able to cache one.

---

## 6. Headers

Every request on a pack link, and every response:

| Header | Direction | Meaning |
|---|---|---|
| `Authorization: Bearer <pack-secret>` | request | The pack-wide shared secret (§8). Required on every request including `hello`. |
| `X-Pack-Protocol: 1` | both | Protocol version. Required on every request **and** every response (§7). |
| `X-Pack-Member: <member-id>` | both | Who is speaking. On a request, the lead's id; on a response, the peer's. Informational — identity is proven by the pinned certificate, never by this header. |
| `X-Pack-Device: <device-id>` | request | The operator's device identity, forwarded for the peer's audit trail (§12). Absent when the lead's device gate is off. |
| `X-Pack-Received-At` | response | Omitted deliberately. **A peer's clock is never trusted for freshness** — the lead stamps its own receipt time (§10). |

The pack surface carries **no `Origin` and no `Host` expectation**: `checkAccess()`
(`bridge/server.ts:1113-1151`) is a browser gate — same-origin comparison, optional
`Tailscale-User-Login`, optional device header — and a pack request satisfies none of its
preconditions. The pack admission path is **separate from `checkAccess()`, never a widening of it**.
Consequences, stated so nobody has to infer them:

- A request arriving on `/pack/v1/*` is admitted **only** by the two pack factors (§8). Browser
  credentials never admit one.
- A request arriving on `/api/*` is admitted **only** by `checkAccess()` / `guard()`
  (`bridge/server.ts:1180-1187`). **The pack secret never admits an `/api/*` request** — it is not a
  bypass of a gate the same request would otherwise have faced.
- A phone request for a peer-scoped resource passes the **lead's** gates first — `guard(req, cfg,
  "read"|"write")` exactly as today, including `deviceAuth()` (`:1216-1223`) — and *then* the pack
  link. **A pack link is never an authorisation upgrade.**

---

## 7. Version negotiation

`X-Pack-Protocol` is an **explicit integer on the wire, never inferred from the app version.** Lead
and peer are separately updated machines, so skew is the steady state, not an edge case.
`GET /api/config` reports a build id (`bridge/server.ts:288-300`) but that is a build, not a contract.

- **v1 window is exact: `1` talks to `1`.** There is no forward-compatible range until there is a
  version 2 to define one against; pretending otherwise ships an untested compatibility claim.
- A peer receiving an unknown or mismatched version **refuses with `409 Conflict`** and a body naming
  both sides — never a bare 4xx, never a partial answer:

  ```json
  { "error": "pack protocol mismatch",
    "code": "protocol_mismatch",
    "expected": 1,
    "received": 2 }
  ```

  (The `error`-string field matches today's `jsonError()` body, `bridge/server.ts:1244-1251`; `code`
  and the version fields are the pack additions.)
- The lead applies the same rule to a peer's **response** header: a reply with a version it cannot
  read is a mismatch, not a parse error.
- **An incompatible peer is a distinct state from an unreachable one** (§10). It is not retried on the
  poll cadence, its sessions are shown from last-good state marked incompatible, and the reason string
  is surfaced verbatim in the UI and in `collie pack status`.

---

## 8. Trust: enrollment, factors, rotation

Collie holds no TLS material and mints no credentials today (verified: searched `bridge/` for `tls`,
`cert`, `pem`, `secret` — nothing). Enrollment introduces the first private key Collie owns.

### 8.1 Two independent factors

Every pack request must satisfy **both**, on the pack listener, or it is refused:

1. **Pinned mutual TLS.** Each collie generates a self-signed certificate. Enrollment exchanges and
   pins the two fingerprints; thereafter, an unpinned certificate is simply **not** that member. No
   CA, no directory, no overlay network — the Syncthing model. Pinning is **pairwise**.
2. **The pack secret**, presented as `Authorization: Bearer`. The secret is **pack-wide** (one value
   every member holds), not pairwise.

Neither alone admits a request: pinning survives a leaked secret, and the secret survives an
unexpected certificate chain appearing in front of a peer. The asymmetry is deliberate — pairwise
pinning is what contains a single compromised member's ability to *impersonate* another; a pack-wide
secret is what makes rotation a single operation rather than N².

**Certificates are long-lived (10 years) and expiry is not a trust boundary** — the pin is. A pack
whose members are rarely all online cannot depend on a renewal handshake that may never get a window.

**A refusal is indistinguishable to the caller.** Absent secret, wrong secret, unpinned certificate
and unknown member all produce the identical response — `401` with body `{"error":"unauthorized"}`,
no `code`, no timing branch, no hint about which factor failed. An unauthenticated caller learns only
that something is listening.

> **Amended 2026-08-07 — where the certificate factor is *enforced*, and in what shape.**
>
> **On a peer's listener the TLS factor is enforced at the handshake.** The peer's `Bun.serve` is
> built with `ca: [<its lead's certificate>] · requestCert · rejectUnauthorized`, so BoringSSL
> verifies the presented chain before a byte of HTTP exists. **An unpinned certificate, or none, is a
> transport refusal — not the uniform 401.** That is a deliberate narrowing of the paragraph above,
> forced by a measured fact: Bun 1.3.14 can *enforce* a client certificate on `Bun.serve` but exposes
> no way to *read* one (no accessor on `Server`, on `Request`, or through `node:https`), so a
> fingerprint cannot be compared in the router. It reveals **less**, not more — §8.5's "learns only
> that something is listening and speaks TLS" survives intact, and the uniform 401 still covers the
> secret factor and everything above it.
>
> Two consequences follow, and both are load-bearing:
>
> - **A peer's `ca` list holds exactly one certificate.** A peer's roster holds exactly one member
>   (§8.2 step 4), so an admitted connection can only be its lead. Admission therefore takes the
>   transport's verdict as a **boolean attestation** (`transportPinned`) set by the code that built
>   the listener, never read from a header — and resolves it to the pinned lead. A peer that cannot
>   build its anchor sets it `false` and refuses **everything**: down, never single-factor.
> - **The lead's own listener pins nothing, and cannot.** Its pack surface rides the front door, and
>   `tailscale serve` — or any conforming reverse proxy (README Variant C) — terminates TLS before
>   the process sees the connection. No client certificate survives to a lead under any design. The
>   peer→lead direction re-establishes the second factor at the application layer instead: **§8.6**.
>
> **There is no live re-pin.** `server.reload({ tls })` does not swap a pinned `ca`; a membership
> change takes effect through the restart every membership verb already performs.
>
> **`COLLIE_PEER_BROWSER=1` and a pinned listener are mutually exclusive.** A browser cannot present
> the lead's client certificate, so on a pinned peer that flag's surface is unreachable. The bridge
> warns and pins anyway — the pack's factor is not weakened for an opt-in convenience.
>
> **Promotion is bounded by this.** A peer pins its *current* lead, so a newly promoted member's
> handshake is refused by every other peer until that peer re-joins. With two members promotion is
> unaffected (the claim goes to the old lead, over §8.6). With three or more, the peers that are not
> the old lead must be re-enrolled — which is the rule §14 and §8.4 already state for an unreachable
> member, now reached for a second reason.

### 8.2 Enrollment — `collie join <lead-address> <token>`

Run **on the peer**, once.

1. The operator mints a token on the lead (`collie pack invite`). The token is **single-use** and
   **short-lived** (10 minutes).
2. The peer dials `<lead-address>`, presenting the token. The token authenticates *the exchange*, and
   nothing after it.
3. The handshake transfers, and both sides persist:

   | Item | Direction | Persisted by |
   |---|---|---|
   | Peer's certificate **and** its fingerprint | peer → lead | lead (pinned) |
   | Lead's certificate **and** its fingerprint | lead → peer | peer (pinned) |
   | Pack secret | lead → peer | both |
   | Pack identity (pack id + human name) | lead → peer | both |
   | Peer's member id (minted by the lead) | lead → peer | both |
   | The address the lead will dial, and the address the peer will listen on | negotiated | both |

4. The lead's roster gains the peer; the peer's roster gains exactly one entry — its lead.

**`<lead-address>` is whatever the operator can reach.** Any network: tailnet, LAN, WireGuard,
someone else's overlay, an SSH tunnel. Collie owns authentication; **the operator owns reachability**.
There is no discovery, no enumeration, and no overlay-network integration — ever.

> **Amended 2026-08-07 — what actually authenticates an enrollment, stated rather than implied.**
>
> **The token and the payload. Not the transport. Trust-on-first-use, at the moment of `join`.**
>
> This was always true and used to read as though mutual TLS covered it. It cannot: enrollment is
> answered by the **lead**, whose surface sits behind a TLS-terminating front door, so no client
> certificate reaches the process (§8.1's amendment). And it could not be otherwise even in
> principle — at this instant the joiner is pinned by nobody, which is the entire reason an
> enrollment exchange exists.
>
> So the guarantees are exactly these, and no more:
> - the **single-use, ten-minute token** the operator carried out of band is what vouches for the
>   certificate in the payload;
> - the **certificate travels with its fingerprint**, and each side refuses a payload whose
>   certificate does not hash to the stated fingerprint — so what is pinned is provably what the
>   sender will present, and a pin can never be persisted in two disagreeing halves;
> - **the certificate itself is transferred**, not only its hash. A hash cannot be enforced: BoringSSL
>   anchors on certificates, and Bun offers no fingerprint-pinning hook. A member holding only a hash
>   could compare a pin it had no way to check.
>
> Everything *after* the exchange is two-factor (§8.1, §8.6). The exchange itself is one factor, on
> purpose, and it is the operator's ten-minute window that bounds it (§8.5).

> **Note, added 2026-08-07 — the lead must be restarted after an enrollment, and is told to be.**
>
> The enrollment lands in the **running** lead's trust store, through the lead's own
> `/pack/v1/enroll`. That store is read **once per process**, at boot: the mode, the roster the lead
> sweeps and the pinned `ca` a peer's listener enforces are all built from that one read. So a lead
> that answers its first `collie join` persists the peer and goes on merging nothing until it
> restarts. `collie pack invite` restarts the lead so it can *answer* the invite; the enrollment
> arrives afterwards, and no restart follows it.
>
> **v1 does not re-wire in place, and this is the decision, not an omission.** Re-reading the store
> into a live process would mean a second startup path running concurrently with the first — and
> `server.reload({tls})` does not swap a pinned `ca` at all (M4/08's transport investigation), so a
> peer's own listener could not be re-pinned without dropping the port. What v1 does instead is
> refuse to be silent about it:
>
> - the bridge records the roster it wired at boot in `<stateDir>/pack-runtime.json`
>   (`bridge/pack/staleness.ts`), and **logs** when a membership change lands under it;
> - `collie pack status` compares that marker to the store and prints **"enrolled but INACTIVE"**,
>   naming the members that are enrolled and not being served, and the `collie restart` that fixes it;
> - `collie join` ends by naming the same restart, **on the lead** — the joining machine restarts
>   itself, and it is the only party in a position to tell the operator about the other side.
>
> The marker is written only by an instance that **has** a trust store, so §11's zero-tax contract is
> untouched: solo still writes nothing.

> **Amended 2026-08-08 — the invite carries the lead's fingerprint, so the lead is authenticated to
> the joiner (closes F1).**
>
> The 2026-08-07 amendment above admitted the gap plainly: the exchange authenticates *the joiner to
> the lead* (the token) and pins the lead trust-on-first-use, with **nothing authenticating the lead
> to the joiner**. A man-in-the-middle on the enrollment path — or a mistyped/rebound `<lead-address>`
> — could capture the token, relay it to the real lead as its own enrollment, and answer the joiner
> with its *own* certificate as "the lead", pinned permanently in both directions.
>
> The fix is the Syncthing model: **the operator-carried token is now `<token>.<lead-fingerprint>`**,
> where the suffix is the lead's own certificate fingerprint (public material). The wire is unchanged —
> `EnrollRequest.token` is still exactly `<token>`, and the lead still stores only its hash — the
> fingerprint travels only in the operator's out-of-band paste. **`join` refuses a lead whose
> certificate does not hash to the invited fingerprint, before anything is pinned or persisted**, and
> **fails closed on an old-format token that names no lead**. It is the fingerprint, not the transport,
> that authenticates the lead — so `http://` remains allowed on a trusted network.

### 8.3 Secrets never touch argv

`ps -eo args` and `/proc/<pid>/cmdline` (mode 444) are world-readable — this is not theoretical; it is
the concrete failure recorded in [ADR 0001](./.adr/0001-one-managed-front-door.md). Therefore:

- Tokens and the pack secret are read from **stdin or a 0600 file**, never from a command line
  argument and never from a long-lived process's environment. `collie join <lead-address> <token>` is
  written that way for readability; the token argument accepts `-` (stdin) and `@<path>`, and the
  literal form warns.
- At rest, pack material follows the discipline `push-subscriptions.json` already uses: atomic
  temp-file-then-rename, **file 0600, directory 0700** (`bridge/push.ts:187-192`), under `stateDir`
  (`bridge/config.ts:200-203`: `HERDR_PLUGIN_STATE_DIR` ?? `COLLIE_STATE_DIR` ?? the user state dir).

### 8.4 Rotation — `collie pack rotate`

Run on the lead. Reissues the pack secret and distributes it to every **reachable** peer in one
operation.

- **There is no grace window and no rollback secret.** The old secret stops being accepted the moment
  rotation completes on a member. A rotation whose whole point is to invalidate a leaked value cannot
  keep honouring it for a stated period.
- **Order follows from that.** The rotation lands on the lead **first**, so the lead never hands out a
  value it does not itself hold; distribution then dials each peer with the *superseded* secret, which
  is the one that peer still checks. Between the two steps the lead's ordinary poll of an undelivered
  peer fails — one interval of `stale` (§10.2), which is the price of not keeping a leaked value alive.
- **A peer offline during rotation is dropped to `unenrolled`.** The lead marks it so; the peer, next
  time it is dialled, fails both factors and stays quiet. Recovery is deliberate and explicit: the
  operator runs `collie join` on that peer again with a **fresh token**.
- `collie pack status` shows, per member, whether it has picked up the current secret — rotation is
  not "done" as a fire-and-forget; it is a state you can read.
- **`collie leave`** (on a peer) drops its roster entry and its pinned material; on the lead,
  `collie pack remove <member>` unpins and forgets. Either side alone is sufficient to end the link —
  a lost disk on one end is handled by removing the member on the other.

### 8.5 Threat model

Stated plainly, because a pack link is remote shell access to a second machine.

- **A compromised peer** reaches: the pack secret (so it can authenticate to the lead as a member) and
  its own machine's terminals, journal, uploads and audit. It **cannot** impersonate another peer —
  pinning is pairwise, and the lead dials a pinned certificate, not a name. It can serve the lead
  arbitrary snapshot and pane content, which the lead renders; that content is already treated as
  attacker-influenceable and rendered as React text nodes under a strict CSP
  (`bridge/server.ts:77-80`, `ARCHITECTURE.md` §6).
- **A compromised lead** reaches **everything, on every member**. This is total, and it is inherent:
  the lead holds the pack secret and a pinned link to every peer, and its whole job is driving
  terminals. **The lead is a lateral-movement hub by construction.** Naming it is the mitigation
  available at this layer; the operator's mitigation is to make the lead the machine they most trust.
- **A stolen enrollment token** buys one enrollment, within 10 minutes, and only from someone who can
  reach the lead's address. It never buys steady-state traffic — the token authenticates the exchange
  only. It is single-use: a token spent by an attacker is a token that visibly fails for the operator.
- **Someone who reaches a peer's pack port with neither factor** learns that something is listening and
  speaks TLS. No PWA, no version banner, no member id, no distinction between refusal causes (§8.1).
- **Local uid reach.** `ARCHITECTURE.md` §6 already documents that every uid in the host's network
  namespace can reach `127.0.0.1:$COLLIE_PORT`. The pack prefix rides that same port; it adds no new
  port, and it is *harder* to use than the existing surface, because it requires two credentials that
  a local uid does not get for free. The `/api/*` surface remains the softer target on that machine,
  and the device gate remains its answer.
- **`tailscale whois` is an optional extra, never a factor.** A `COLLIE_TRUSTED_USER`-shaped narrowing
  on top of a gate that already holds without it (`bridge/server.ts:1144-1149` is the existing shape).
  It is never discovery and the model never depends on it.

### 8.6 Signed membership requests (added 2026-08-07)

The peer → lead direction cannot pin at the handshake (§8.1's amendment), and the two requests that
travel it are the most consequential in the protocol: `leave` removes a member from a roster, and
`lead` moves the crown (§14). The pack secret is **pack-wide**, so with it alone any member could
speak for any other. The second factor is therefore re-established over material both sides already
pinned — no new key, no new trust, the same guarantee the handshake gives the other way.

**`POST /pack/v1/leave` and `POST /pack/v1/lead` MUST carry a signature.** `GET /pack/v1/hello` MAY,
and does when a verb sends it, so `collie pack status` and `collie reconnect` can probe a lead at
all. Nothing else may: the proxy surface (§5) runs lead → peer over a pinned handshake, and hashing a
body to verify a signature there would pull a streamed upload (§13) into memory on the security path.
`/pack/v1/enroll` cannot — at that instant nobody has pinned the caller (§8.2).

- **`X-Pack-Signature`** — base64 ECDSA-P256-SHA256 over the canonical string, made with the private
  key behind the sender's **pinned** certificate and verified with that certificate's public key.
- **`X-Pack-Timestamp`** — epoch milliseconds, decimal.
- **The canonical string**, exactly:

  ```
  <METHOD>\n<path>\n<sha256(body) hex>\n<timestamp>
  ```

  Four fields, each closing one substitution: the **method** so a signed `POST` is not replayable as
  something else; the **path** so a body cannot be moved from `leave` to `lead`; the **body digest**
  because §14's claim lives *in* the body; the **timestamp** so a capture cannot be re-stamped
  forward. The **query string is deliberately absent** — no signable route takes one, and signing a
  value no route reads is a rule that silently stops holding the day one does. The **host is absent
  too**: an address is a hint the operator may re-point (§4), and binding a signature to it would
  make roaming a signature failure.

- **Skew: ±5 minutes**, both directions. A future timestamp is refused as firmly as a past one —
  parking a captured request for later is what a future stamp buys.
- **Replay: strictly monotonic per member.** A timestamp must be **greater than** the last one this
  collie admitted from that member; the floor is persisted (`TrustedMember.signedAt`), because a
  counter that resets on restart is no counter and every membership verb restarts the bridge. The
  floor moves **before** the request is handled. It is advanced only for the membership routes, which
  are the state-changing ones — a replayed `hello` changes nothing and is bounded by the skew window.
- **A failure at any step is the uniform 401** of §8.1 — indistinguishable from a wrong secret, an
  unpinned certificate, or an unknown member. The signature is checked **before** the timestamp, so a
  caller who cannot sign learns nothing about this collie's clock or about what it has already seen.

---

## 9. Reads — what is proxied, what is merged

**Exactly one route is merged. Everything else is proxied byte-for-byte.**

### 9.1 Proxied reads (pane mirror, history)

The lead forwards the request to the owning peer and returns the peer's response **unmodified**:
status, body bytes, `content-type`, `content-encoding`, and — critically — **`etag`**.

- `If-None-Match` from the phone is passed through to the peer.
- A peer's `304` is returned to the phone as a `304`, with the peer's `etag` echoed. RFC 7232 §4.1 is
  satisfied by the peer's own existing code path (`bridge/server.ts:467-478`).
- The ETag on a proxied read therefore means what it has always meant: *the peer's assertion about its
  own body*. The lead adds nothing to it and must not recompute it — `computeEtag()` is a hash over a
  body (`bridge/http-cache.ts:16-19`), so re-hashing an identical body would be a no-op at best and a
  silently-different value across a version skew at worst.
- The 304-skips-the-transfer win (`bridge/server.ts:460-462`) is preserved end to end, which is the
  entire reason proxying is byte-for-byte rather than parse-and-re-emit.

The phone's per-pane ETag/body cache is keyed by `(host, session, paneId)` (§4) so a `w1:p1` on one
host can never 304 into another host's mirror — the same failure the session component already
prevents (`web/src/lib/api.ts:201-203`).

### 9.2 The merged snapshot

`GET /api/snapshot` on the lead is assembled from the lead's own state plus each peer's
`GET /pack/v1/snapshot`. Two changes to `SnapshotResponse` (`bridge/types.ts:164-186`):

- **`servers?: ServerSummary[]`** — a new **optional** field, following the `update?` precedent
  (`bridge/types.ts:182-184`), **not** the always-present `sessions` precedent (`:175-179`). See §11
  for why the choice is forced.

  ```ts
  interface ServerSummary {
    id: string;            // member id (the `?h=` value); the lead's own entry is present too
    name: string;          // operator-chosen label
    isLead: boolean;
    reachable: boolean;    // last poll succeeded
    protocol: "ok" | "incompatible" | "unknown";
    protocolDetail?: string; // the peer's refusal reason, verbatim, when incompatible
    lastSeenAt: number;    // epoch ms, stamped by the LEAD on receipt — never the peer's clock
  }
  ```

  `reachable` is not an invention: `SessionSummary.reachable` already models an unreachable member as
  a rendered state with zeroed counts rather than a failed response
  (`bridge/types.ts:133-145`, set at `bridge/sessions.ts:171`). `ServerSummary` is that precedent one
  level up.
- **Every session and every pane is host-tagged.** `SessionSummary` gains `host: string` and the pane
  wire shape gains `host: string`, so the phone can address what it renders. Absent on a solo
  snapshot (§11).

Merging is the *only* place the lead re-serialises. Its ETag over the merged body is **the lead's
assertion about its own merged view**, not any peer's — it necessarily changes when any peer's
contribution changes, and it says nothing about whether a given peer's snapshot changed.

---

## 10. Freshness, partial failure and staleness

### 10.1 Polling (v1)

**v1 is polling. The lead polls each peer's `GET /pack/v1/snapshot` on its own adaptive interval** —
the cadence it already runs (`COLLIE_POLL_MS` 1500 / `COLLIE_POLL_IDLE_MS` 12000,
`bridge/config.ts:212-213`; `ARCHITECTURE.md` §5). There is no events endpoint on Collie's HTTP API
today and v1 does not add one; `events.subscribe` is a *Herdr socket* method (`HERDR_API.md`) and
never crosses a pack link.

- **Peer fetches are concurrent, not serial.** N peers must not add N round trips of latency.
- **Each peer gets a timeout budget strictly below the lead's poll interval** — default
  `COLLIE_PACK_TIMEOUT_MS = 1200` against a 1500 ms poll — so a slow peer can never stall the lead's
  own snapshot. A missed budget is an unreachable poll, not a delayed one.
- The peer sweep is a *part of* the existing poll, not a second timer. A solo lead runs no sweep at
  all (§11).

### 10.2 Three distinct states, never conflated

| State | Meaning | Retried on the poll? | Presented as |
|---|---|---|---|
| **reachable** | Last poll succeeded within budget | yes | live |
| **unreachable** | Timeout, connection refused, TLS failure, auth failure | yes | last-good state, **stale**, with `lastSeenAt` |
| **incompatible** | `X-Pack-Protocol` mismatch (§7) | no (probed on a slow backoff) | last-good state, **incompatible**, with the peer's reason |

- **Unreachable is a value, never an error.** A down, slow, skewed or unauthenticated peer **never**
  produces a 5xx for the whole pack and never produces a blank phone. The lead's snapshot always
  answers 200 with whatever it has.
- **A peer's sessions never vanish.** They are listed from the last-good snapshot, marked stale with
  an age derived from `lastSeenAt`. A triage list that flickers is worse than one that is honestly
  stale — panes must not disappear and reappear between polls.
- **Freshness is the lead's receipt time.** A peer's clock is never trusted; `lastSeenAt` is stamped
  when the response lands, which is also why no timestamp header rides the response (§6).
- **Presented-stale threshold:** a member is rendered stale once its `lastSeenAt` is older than
  `3 × pollMs` **or** 15 s, whichever comes first. Below that, a single missed poll is invisible —
  the same tolerance the herd link already gets.

### 10.3 Writes to a member that is not reachable

**A write to an unreachable or incompatible peer fails immediately and legibly. There is no queue and
no automatic retry.**

This is [ADR 0010](./.adr/0010-long-sends-are-verified-via-the-paste-placeholder.md)'s reasoning
carried across a lossier link. A send whose outcome is unknown must be *surfaced*, never re-sent: the
bytes may already be in the terminal, and a retry types them twice. Concretely:

- A write to a member the lead currently believes unreachable is refused **before** it is attempted,
  with a message naming the member and its `lastSeenAt`.
- A write that is attempted and then **times out** is reported as *unknown outcome* — explicitly not
  as a failure, and explicitly not retried. The operator re-reads the pane and decides.
- A write to an incompatible member is refused with the protocol-mismatch reason.
- Nothing is buffered for later delivery. A pack is not a message queue, and a pane that has moved on
  is exactly why (the same reasoning that forbids a key queue outliving its dock,
  [ADR 0005](./.adr/0005-a-composed-key-queue-never-outlives-its-dock.md)).

**On the wire** (what the phone renders on — `bridge/pack/forward.ts`): every lead-generated refusal
is JSON with `{ok: false, code, error, host}` and a distinct status — `host_unreachable` (503),
`host_incompatible` (503), `write_outcome_unknown` (504), `image_too_large` (413),
`route_not_federated` (501, for a route outside §5's table). Never a bare 500,
and never a silent success. A peer's *own* answer is never given one of these: it is passed through
as itself (§9.1), including its 403 when the peer's write gate refuses.

---

## 11. The solo zero-tax contract

**With zero peers enrolled, Collie's observable behaviour is byte-for-byte what it is today.** This is
a gate, not an aspiration — M2/05 lands the characterization tests that enforce it before any
federation code exists to break it.

| Surface | Solo behaviour | Decided at |
|---|---|---|
| Routes served to a browser | unchanged; **zero** routes added, zero status codes changed | `bridge/server.ts:165-390` |
| `/pack/v1/*` | **not routed at all** — no pack prefix is registered with zero peers | §5 |
| Snapshot bytes | unchanged — `servers` is **omitted**, and no `host` field is added to sessions or panes | `bridge/types.ts:164-186` |
| Snapshot ETag | **unchanged.** Follows from the row above: no added field, no shifted hash | `bridge/http-cache.ts:16-19` |
| `?session=` with no param | primary session, bit-identical | `bridge/sessions.ts:154-157` |
| `?h=` | never emitted by the client, never present in a URL | `web/src/lib/session.ts:28-31` |
| Notification tags | unchanged — the primary keeps the bare `collie:herd` | `bridge/sessions.ts:33-35` |
| Push payload | unchanged — no `host` field, mirroring how `session` is stamped only for non-primary | `bridge/push.ts:124-131` |
| Poll cadence | unchanged — **no second timer, no peer sweep**, same idle relaxation | `bridge/event-poker.ts`, `bridge/config.ts:212-213` |
| Audit line bytes | unchanged — `host` is omitted, not null, exactly as `session`/`device` are today | `bridge/audit.ts:55-61` |
| Files written | **exactly today's set**: `uploads/`, `audit.log`, `push-subscriptions.json`, `snooze.json`, `notify-prefs.json`, `activity.json`, `update-state.json`. **No key, no certificate, no trust store, no roster.** | `bridge/server.ts:1075`, `bridge/audit.ts:65`, `bridge/push.ts:86`, `bridge/snooze.ts:19`, `bridge/notify-prefs.ts:45`, `bridge/activity.ts:100`, `bridge/update.ts:147` |
| Ports opened | exactly one, loopback, as today | `bridge/config.ts:210-211` |

**Why `servers` is optional-and-absent rather than always-present.** An always-present field — even a
single-entry one, the shape `sessions` chose — changes every solo snapshot body, and therefore every
solo snapshot ETag, exactly once. That is a real cost (one forced refetch for every solo user on the
release) paid for a uniformity nothing needs, and it contradicts *byte-for-byte*. `update?` is the
precedent that fits: absent means "no pack", which is precisely true. **Solo mints nothing and emits
nothing.**

**Where the gate lives.** `bridge/solo-baseline.test.ts` (+ goldens under
`bridge/fixtures/solo-baseline/`) and `web/src/lib/solo-baseline.test.ts`. Both were landed in
1.0.0-alpha.1, *before* any federation code existed — written afterwards they would only re-record
whatever the new code does. They pin the table above in two layers: an exhaustive
`Record<keyof T, true>` per wire type (so adding `servers?:`/`host?:` fails `bun run typecheck` at the
line it was added, and `satisfies SnapshotResponse` in `server.ts` closes the loop), plus a
byte-compared golden body and its ETag. **A failure there is not a stale golden** — it is a solo
instance's behaviour moving. Regenerating is a deliberate act
(`COLLIE_REGEN_SOLO_BASELINE=1 bun test bridge/solo-baseline.test.ts`) and **must** be called out in
the PR description with the reason and the row it renegotiates.

**What the unit baseline cannot reach.** Collie deliberately unit-tests only pure/injectable modules —
anything needing `Bun.serve` is out of `bun test`'s reach (CLAUDE.md). So four claims above are pinned
only *indirectly* (route literals, config defaults and payload shapes read out of the source) and need
the M4 integration harness to be asserted for real: **status codes** unchanged per route, **the actual
bound port count**, **the absence of a second timer / peer sweep at runtime**, and the **live push
payload** for a primary-session alert. Those four are the integration harness's charter; everything
else in the table is covered by the unit baseline today.

> **Status 2026-08-07 — the harness landed (`bridge/pack/harness.test.ts`); three of the four rows
> are now measured.**
>
> - **Status codes per route** — measured on a live solo instance: `/api/snapshot`, `/api/config` and
>   a real pane read answer today's codes, and `/pack/v1/*` is **indistinguishable from an arbitrary
>   unknown path** (same status, no version banner). Asserted as indistinguishability rather than as a
>   literal `404`, because the code depends on whether a frontend build is present and the promise
>   does not.
> - **Bound port count** — measured: exactly one, and its neighbour is closed.
> - **No second timer** — measured indirectly, and the indirection is the honest form of the claim:
>   the lead's call rate to its *own* Herdr is recorded while solo and re-measured once it leads a
>   pack, and must not move. A lead that had armed a sweep timer of its own would poll on two clocks.
> - **Live push payload** — **still out of reach.** It needs VAPID keys, a real subscription and a web
>   push endpoint; the harness has none, and `web-push` is an optional dependency. Its shape stays
>   pinned by `push.test.ts` at the unit layer. Closing it properly is M5/M6's, and it needs a
>   loopback push receiver, not a bigger pack harness.

---

## 12. Writes and audit attribution

A write reaches a peer only through the lead, and the peer's own audit log is the record of what
happened on the peer's terminals.

- The lead forwards `X-Pack-Device: <device-id>` — the operator's device identity as the lead resolved
  it via `deviceAuth()` (`bridge/server.ts:1216-1223`). Absent when the lead's device gate is off,
  matching how the field is omitted rather than nulled today (`bridge/audit.ts:55-61`).
- **The header is trusted because the pack link authenticated it**, not because it was sent. It is
  meaningful only on an admitted pack request (§8.1) — exactly the trust basis `COLLIE_DEVICE_HEADER`
  already rests on for a co-located proxy (`bridge/server.ts:1216-1223`).
- The peer writes the entry to **its own** `<stateDir>/audit.log` (`bridge/audit.ts:64-67`), with the
  device carried through as `device` and a new `via: "pack"` marker plus the originating member id, so
  a pack-originated action is identifiable in the peer's log without ambiguity. The peer's operator,
  reading their own log, sees who did it and from where.
- **The lead also records the forward** in its own log — one line, `action` unchanged, plus the target
  `host`. The two logs are independent records of the same event, which is the point: neither machine
  depends on the other's disk to answer "what happened here".
- **A peer is never asked to trust the lead's authorisation decision in place of its own.** The peer
  applies its own write-level checks to a pack request; the lead's gate does not stand in for them.

---

## 13. Uploads

The path is **phone → lead → owning peer's disk**.

- The lead forwards the multipart body to `POST /pack/v1/pane/:id/upload`; the **peer** runs the
  existing handler and writes into **its own** `<stateDir>/uploads` with the existing 0700 discipline
  (`bridge/server.ts:1075-1090`).
- The returned `path` is **peer-local and absolute on the peer's filesystem**. That is the requirement,
  not a leak: the path is typed at an agent running on that machine, and Herdr **on that machine**
  must be able to open it. A path on the lead's disk would be dead on arrival.
- The lead never stores the file and never rewrites the path.
- Upload sweeping stays per-machine (`bridge/uploads.ts`, driven from `bridge/index.ts:195-202`) — the
  peer expires its own files.

---

## 14. Promotion

**`collie promote` is a deliberate operator action, run on the peer that is to become lead.
Transparent failover is a non-goal.**

- It **refuses if the current lead is unreachable, unless `--force`.** A clean handover has to reach
  the old lead to demote it and hand over the roster; promoting without that leaves the old lead still
  believing it is the lead. A pack with two leads has two front doors and two rosters, and `--force`
  is the operator explicitly accepting that risk for a machine they know is gone — after which the old
  lead must be `collie leave`-d or re-`join`-ed before it is ever powered back on into the pack.
- The pack identity, the pack secret and existing pinned certificates are **reused** — promotion is a
  role change, not a re-enrollment. What changes is which member holds the front door and which
  address the others dial.
- **The claim is signature-authenticated** (added 2026-08-07). `POST /pack/v1/lead` carries §8.6's
  signature, made with the key behind the claimant's pinned certificate, over a canonical string that
  includes the body — so the claim *and* the certificate travelling with it are under the signature.
  A member may still only claim leadership for itself (the claimed id must be the admitted one), and
  the two rules are complementary: the signature proves *who is speaking*, the id check stops them
  nominating a third party. Without this, a pack-wide secret plus a lead whose front door terminates
  TLS (§8.1) would let any member move the crown to any other.
- **Only the old lead is reachable by the promotion itself** (added 2026-08-07). Every other peer pins
  its *current* lead at the handshake, so the new lead's connection is refused until that peer
  re-joins. With two members this changes nothing. With three or more, the peers that are not the old
  lead fall under the re-enrollment rule below — for a second reason, on top of unreachability.
- Every remaining peer must be told the new lead's address. Reachable peers are updated by the
  promotion itself; **a peer that is unreachable during promotion must be re-enrolled** (`collie join`
  against the new lead, fresh token) — the same rule rotation uses (§8.4), for the same reason.
- **The phone re-points manually.** The front-door URL is bound to a node; nothing rewrites a
  bookmark. This is stated as an operator step, not hidden.
- **The old lead's front door is torn down by the old lead.** Collie tears down only a mapping its own
  ownership record matches ([ADR 0001](./.adr/0001-one-managed-front-door.md)), and that record lives
  beside the CLI on that machine — no process publishes or unpublishes a tunnel on another operator's
  say-so. `promote` prints the exact command (`collie unserve`) to run there; it cannot run it.
- **Nothing else follows the crown.** Push subscriptions, the audit log, outstanding notification tags
  and activity ledgers are host-local by rule (§2) and stay on the old lead. The phone re-subscribes
  against the new one. `promote` enumerates this in its own output.

> **Note, added 2026-08-07 — the demoted machine needs a restart, and `promote` says so first.**
>
> The old lead adopts its demotion **on disk**, in the request it answers. Its *process* does not
> change: it keeps the lead-mode listener it bound at boot — which, under §8.1's amendment, **pins
> nothing** — and its front door, until something restarts it. So `promote` now prints
> `collie restart`, **then** `collie unserve`, for that machine, in that order: `restart` runs `start`,
> which publishes, so tearing the front door down first would race the thing that re-publishes it (the
> same ordering `collie join` uses). Locally, the demoted machine says it too — in its own log, and in
> `collie pack status`, which reports it as a `peer` on disk and a `lead` in memory (§8.2's note).
>
> **The demoted bridge does not restart itself.** Exiting so a supervisor restarts it would work under
> systemd (`Restart=on-failure`) and launchd (`KeepAlive`/`SuccessfulExit=false`) — and would take the
> machine's Collie off the air entirely on the **unsupervised** tier, which nothing restarts and which
> is reached exactly where an operator is least present (a Mac whose `gui/<uid>` bootstrap refused).
> The bridge is launched identically on all three tiers and cannot tell which one it is under;
> supervision is the CLI's knowledge. A demotion is not a licence to end a process that may not come
> back, so the honest v1 answer is the operator's restart, named in three places.

---

## 15. Non-goals

- **Overlay-network integration of any kind.** No Tailscale / NetBird / ZeroTier enumeration,
  discovery or membership sync — ever. An address and a token is the whole contract. This extends
  [ADR 0001](./.adr/0001-one-managed-front-door.md): Collie manages one front door **per pack**, the
  lead's, and peers manage none.
- **A second managed front door.** A peer never runs `tailscale serve` and **never `tailscale
  funnel`** — the prohibition generalises to any tunnel offering a public URL.
- **Transparent failover / leader election.** §14.
- **Write queuing or automatic retry.** §10.3.
- **A pack-wide filesystem, transcript store or audit log.** Journal, uploads and audit are host-local
  by rule (§2).
- **Streaming events in v1.** §16.
- **Standalone-from-Herdr graduation.** This document constrains the protocol's vocabulary so
  graduation stays *possible* ([RFC #67](https://github.com/AltanS/collie/discussions/67)); it does
  not commit to it and adds no driver abstraction.

## 16. Reserved for a future version — explicitly unbuilt

Named here so v1's shape does not foreclose them, and so nobody mistakes a reservation for a plan:

- **Streaming freshness.** A peer→lead push or long-lived stream replacing the poll of §10.1. The
  version header (§7) is what makes adding it a negotiation rather than a flag day. **Nothing in v1
  implements or half-implements this.**
- **An upload-read route** (§5), if a use case ever needs the lead to serve a peer-stored image.
- **A non-Herdr peer.** The seam exists (§2, [ADR 0011](./.adr/0011-the-pack-protocol-is-the-mux-driver-seam.md))
  but **nothing in v1 exercises it** — no peer fronts anything but Herdr, so the seam is a promise,
  not a verified property.

---

## 17. Open items this document does not close

- The **final product vocabulary** for operator-visible surfaces (env keys, action ids, CLI verbs).
  Settled by [ADR 0012](./.adr/0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md);
  `collie` / `lead` / `peer` / `pack` are the words *this* document
  uses and they must stay greppable.
- **Concrete default values** marked as defaults above (`COLLIE_PACK_TIMEOUT_MS = 1200`, the 10-minute
  token lifetime, the 10-year certificate lifetime, the `3 × pollMs` / 15 s staleness threshold) are
  starting points chosen to be consistent with today's cadence, not measured ones. M4 may move them;
  the *shapes* — a budget below the poll interval, a short single-use token, pinning-not-expiry, a
  threshold above one missed poll — are the contract.
