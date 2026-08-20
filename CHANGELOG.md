# Changelog

All notable changes to Collie are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml`, `package.json`, and `web/package.json` (enforced by
`scripts/check-version.sh`). See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [1.0.0-beta.9] - 2026-08-20

### Fixed

- **Peer panes rendered "(no recent output)" in the app** — the lead re-emitted the peer's `Content-Encoding: gzip` over a body Bun had already decompressed, so the browser failed every peer body read (curl ignored the header, which is why shell checks stayed green); the peer hop is now explicitly identity and the header left the proxied list, with a harness test pinning "the headers describe the bytes" (bc718fb)

## [1.0.0-beta.8] - 2026-08-20

### Fixed

- **A cold pack link now bootstraps on a relayed path** — the first data request per link dials on the patient budget (one credit, spent at issue), so a DERP-relayed TLS handshake no longer aborts at the strict per-poll budget and strands the link cold forever; warm requests stay strict ([PACK_PROTOCOL.md §10.5](./PACK_PROTOCOL.md), 8360d08)
- `collie doctor` / `pack status` / `reconnect` send one real snapshot after `hello` and name an answered-but-starved link instead of reporting green (8360d08)
- The `COLLIE_PACK_TIMEOUT_MS` clamp warns at boot, naming the `COLLIE_POLL_MS` value that would honour the requested budget (8360d08)

## [1.0.0-beta.7] - 2026-08-20

### Added

- **The mux contract** — one Collie-owned port for everything a multiplexer must answer (`bridge/mux/`), capabilities declared per adapter and never inferred from a name, the evidence matrix in [`MUX_CONTRACT.md`](./MUX_CONTRACT.md) ([ADR 0022](./.adr/0022-the-mux-seam-is-a-port-collie-owns.md), c516cfd)
- **A conformance suite every mux adapter must pass** — 7 read-only + 10 world checks run against every registered adapter by iterating the registry; live layer in `scripts/mux-probe.ts`; contributor doc [`MUX_CONTRIBUTING.md`](./MUX_CONTRIBUTING.md) (b184767)
- **The tmux adapter** — `COLLIE_MUX=tmux` lists, reads (colour preserved) and types into a tmux server; session→space, window→tab; events via read-only control mode with a bounded census backstop (74bb86c)
- **The zellij adapter** — `COLLIE_MUX=zellij` drives one zellij session; content streams over `zellij subscribe`, topology polls a bounded 3s→12s census; scrollback via `dump-screen --full`, never called history (8bf0951)
- **The UI reads capabilities, never a multiplexer name** — the active adapter's declaration rides `GET /api/config`; absent capabilities hide the meaningless and explain the expected in the adapter's own words; `scripts/check-mux-names.sh` keeps mux-name literals out of `web/src` (e9f7c83)

### Changed

- **Herdr is now the reference mux adapter** behind the port — every bridge consumer depends on `MuxAdapter`, construction goes through the registry with Herdr the default, no operator-visible change (1ef399c)

## [1.0.0-beta.6] - 2026-08-19

### Added

- **A routine `update` now stays inside its installed major and follows release tags** — a managed checkout resolves the newest `vX.Y.Z` inside its major and detaches onto it; a linked clone keeps its ff-only pull, gated by a pre-flight read of the manifest. Crossing a major needs `update --major`, also wired as the `update-major` plugin action, because a Herdr action has no TTY to prompt on ([ADR 0020](./.adr/0020-a-major-upgrade-is-consented-by-flag.md), fcb48a9)
- The update banner distinguishes a routine release from a pending major, ranked below it so the operator takes what a plain tap can actually deliver first (76b2813)
- **`collie link` / `collie unlink` publish the binary on PATH as a symlink, never a copy** — the pointer is never stale because it is never refreshed, and `link`/`unlink` only ever touch a name Collie itself published; `doctor` gains a `path-link` line ([ADR 0021](./.adr/0021-the-path-name-is-a-pointer-never-a-copy.md), 3287194)

### Fixed

- **The linked-clone major gate judged the wrong commit** — it read the manifest at the remote's default branch while `--ff-only` advances the current branch from its own upstream, so a clone on a maintenance branch judged a major it would never actually pull; it now fetches the configured refspec and reads the manifest at `@{u}` (f8ad03d)

## [1.0.0-beta.5] - 2026-08-18

Adds a lint gate; changes no operator workflow. Reasoning:
[ADR 0019](./.adr/0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md).

### Added

- **oxlint + the vendored [anti-slop](./tools/oxlint/README.md) plugin are the lint gate** — one root `.oxlintrc.json`, all 15 anti-slop rules plus oxlint's correctness/suspicious/perf catalog at `error`, run with `bun run lint` (92b8fff)
- The gate runs on five surfaces: the editor (`.vscode/`), the agent edit loop (`.claude/hooks/lint-edited-file.sh`, PostToolUse), pre-commit over staged files (`SKIP_LINT_CHECK=1`), `collie build` full-tree (`SKIP_LINT=1`), and CI before typecheck/test — every one shelling out to the same config with no flags of its own (ae0e1d0, 5299ece, 864a90c, 0f05edf)
- `.adr/0019` records the decision, the one triage pass's rule-by-rule rationale table, and the fix-shapes for the rules you'll trip most; CLAUDE.md gains the rule and lists every `SKIP_*` escape hatch in one place
- The pre-commit hook's version and lint guards are independently skippable — `SKIP_VERSION_CHECK=1` used to exit 0 out of the whole hook (ae0e1d0)

### Changed

- **TypeScript 7.0.2 on both sides** — zero new diagnostics, no source or tsconfig edits; typecheck drops to ~0.3s root / ~0.6s web. TS7 ships no `tsserver` bin, only `tsc` (3935eaa)
- **2,851 lint findings paid down to zero by fixing code** — no suppressions, no rule downgrades outside the one triage pass. Boundaries now parse instead of assert: new `bridge/json.ts` / `web/src/lib/json.ts` (`JsonValue`), `web/src/lib/env.ts` (capability probes), `web/src/test/stub.ts` (1373a02..a3159fd)

### Fixed

- **A journal line that is literally `null` threw a `TypeError` out of all four parsers** instead of being skipped like any other unusable line (242e49d)
- **Three bridge write routes answered on a body they only declared** — a non-string `text` reached `pane.send_text`, `submit: 0` meant "type but don't send", and a non-string `workspaceId` threw a `TypeError` out of the handler; each is a 400 now (b19fc35)
- **An unrecognised pairing refusal rendered a blank card** — the failure name was asserted into a union whose exhaustive switch then returned `undefined`; it falls back to the bridge's own copy (a6a91bb)

## [1.0.0-beta.4] - 2026-08-18

### Fixed

- **The audit log is size-capped** — a pack refusal is audited before any factor authenticates, so a caller who can reach the listener could grow it without bound; the appender now rotates to `audit.log.1` at 5 MiB, keeping one generation, and a failed rotation still appends (3e1c286)

## [1.0.0-beta.3] - 2026-08-18

Merges `main` 0.31.0 + 0.31.1 into v1 (entries below). v1-specific on top of them:

### Added

- **`push-keys` is a `bin/collie` verb** (`cli/push-keys.ts`, also spelled `collie push keys`) rather than shell in the bootstrap shim — main implemented it in `collie-ctl.sh` because it has no `cli/`; on v1 every verb is implemented once in `cli/` and the shim only delegates (ADR 0006). Behaviour is main's, unchanged: `--force`, subject-only update, symlink refusal, no placeholder subject, mode 600, `wx` temp file
- **`collie push list|forget`** — the orphaned subscriptions already on disk get a surface: one line per row (service host, first-subscribed day, user agent, enough endpoint to retype) and `forget <substring>` / `--all` to drop them; neither goes through `init()`, so both answer with no VAPID keys configured (b62e7e7)
- `scripts/collie-cli.test.sh` drives `push-keys` through the compiled binary — resolved `.env`, mode, the refusal to replace live keys, the subject-only update, `--force`, and the symlinked-`.env` refusal

### Changed

- `AuditLog`'s options object carries v1's pack `defaults` alongside main's `content`, so scoped pack logs and `COLLIE_AUDIT_CONTENT` redaction compose; every call site passes `{ now }` instead of a positional clock
- `/api/config` reports `operatorCommands` through `bridgeConfigBody()`, so the pack `mode` key and the operator's palette rows share one omit-when-empty body
- Drafts' two tiers key off the `(host, session, paneId)` scope, so the memory tier cannot disagree with disk about which pane is which

### Fixed

- **Re-adding an enrolled peer restarts it there** — `pack add` on a member whose checkout is behind replaced the build and then reported the process it had superseded; a run that changed something on the far machine now runs that machine's own `collie restart` and states what the member reports over the pack link afterwards (4574af5)

## [1.0.0-beta.2] - 2026-08-15

### Added

- **`collie pack update <member>… | --all`** — level peers to the lead's build from the lead: read-only probe of every target, ONE consent question for the whole batch, then per member push the commit, restart, and verify the new version over the pack link; a failure is recorded and the run continues, ending in a table and a non-zero exit. A bare `pack update` is a usage error listing members and versions, a member with no ssh record is skipped with its remedy, a dirty remote checkout is refused, and there is no `--yes` (c5a1815)
- The update rides the operator's own SSH and never the pack wire — over-the-wire updating would add the inbound admission surface ADR 0013 rejects and make a compromised lead a human-free code-execution credential on every peer (ADR 0016, 770140c)
- **`pack-ops.json`** beside the trust store — member id → the ssh host, remote checkout and port the operator last used, so `pack update` need not be retaught what `pack add` already knew; operator-local convenience data, never a wire field and never a trust-store field, fails closed on a partial read (3d7f645). `pack add` banks the route on a finished run and `pack remove` forgets it (ffde078)

### Changed

- Version-skew warnings in `pack status` and `collie doctor` name `collie pack update <member>` with the member ids already in it, instead of "update the older machine"; `PACK_PROTOCOL.md` §7.1's remedy sentence and the README follow (770140c)
- `cli/remote.ts`'s legs are three emit-free step runners plus the failure-family helpers, so a second verb can drive them — `pack add` prints exactly what it printed before, in the same order (ffde078)

## [1.0.0-beta.1] - 2026-08-15

### Added

- **`COLLIE_PUBLIC_URL` is the front-door address source** — set the real ingress once and every `pack invite` / `pack add` derives it, instead of handing joiners a derived tailnet name a one-way ACL makes undialable; origin only, a bad value warns and falls through, the peer's `pack-listener` address is untouched (cdeab7e)
- **`doctor`, `status`, `pack status` and `pack add` render with ink on a TTY** — findings table, boxed banner, roster coloured by reachability, a spinner per `pack add` leg; every verb keeps its plain branch, selected by `isTTY && !CI && !--plain` (24dc52f, 62e2ba5, 7c9958b)
- `collie promote` prints the demoted lead's repair steps and lists every remaining member for re-join — the peer sweep could never land through a peer that pins only its current lead (c9a7373, b02d4a8)
- README: the 0.x → 1.0 migration path — one action, one must-do, a rehearsed way back (893c511)

### Changed

- **Commander owns parsing and dispatch**, built from the existing `COMMANDS` table so the usage line cannot drift from the verb list; it never exits or prints on its own — usage errors stay in this CLI's words and the pack exit codes survive (309c15e)
- Herdr action titles say "Collie", not "web bridge" — titles only; action ids and command strings stay frozen (ADR 0006, ADR 0012) (9a2015a)

### Fixed

- **A non-minimal DER serial made 1 certificate mint in 512 unparseable** — the cert minted and fingerprinted but could never be re-parsed, so every pin re-derived from its PEM failed: in a pack that is a member that cannot be pinned, verified or served. Any member enrolled by an affected run must be re-enrolled (`collie pack remove` + a fresh join); `derInteger` now emits the shortest form and the rule is pinned deterministically (4037601)
- **`COLLIE_INSTANCE` discovers its own conventional config dir and refuses another instance's** — a second instance's pack verb silently read the default instance's trust store and minted a fresh identity into the live one; an injected `HERDR_PLUGIN_CONFIG_DIR` still wins (73a2853)
- `collie join`'s enrollment dial gets a 15s budget — an unreachable lead used to hang on the OS's TCP patience (5+ minutes observed); the peer's UNREACHABLE branch now names `--address` as the escape hatch (1177b57)
- `pack add`'s git-bundle legs: `create` bundles HEAD rather than a bare sha it refuses, and `verify` runs in a scratch repo under `$WORK` (27ee624, 80b996f)
- The `status` banner probes the bridge's actual bind instead of assuming loopback (2941300)
- `collie build` runs on a bare checkout again — commander is lazy-loaded (fa6ecfa); `pack add` renders plain where ink would not fit (18a7b98) and surfaces the install leg's own error line (683ce68)
- The lead's own roster entry is a machine label, not the pack name (43173a2); the standalone machine chip above the composer input is gone (4efb152)
- A composer test's stall no longer outlives its test and lands in the next one (df879dd)

## [1.0.0-alpha.16] - 2026-08-13

### Added

- **Device pairing** — `collie pair` mints a one-time code, the phone spends it in Settings for a bearer token, and from then on every write needs it; enforced exactly while at least one device is paired, so an install that pairs nothing is unchanged (1b4d502)
- `collie devices list` / `collie devices revoke <label>` — revocation lands on the running service without a restart (1b4d502)
- `POST /api/pair`, `GET /api/devices`, `POST /api/devices/revoke`, and a paired-devices section in Settings (1b4d502)

### Changed

- A write refused for want of pairing answers `403 device not paired`, distinct from the header gate's `device not authorised`; the two gates stay independent and compose by AND (1b4d502)
- Audit lines and the snapshot's `device` field prefer the pairing label over the proxy-asserted header name (1b4d502)

## [1.0.0-alpha.15] - 2026-08-12

### Fixed

- A hand-typed `collie join` on a default-configured peer no longer records a portless callback address the lead would dial forever at :443 — a derived pack-listener address now always carries this instance's own port; lead/front-door addresses and explicit `--address` values are untouched, and records minted before the fix are repaired with `collie reconnect` (3459297)

### Changed

- Docs retire "bridge" as vocabulary for the instance — "a collie" is the participant, "bridge" stays the component (ADR 0012's landing rule) (2122f08)

## [1.0.0-alpha.14] - 2026-08-12

### Added

- **`collie pack add <ssh-host>`** — probe, install, configure, enroll a peer over one multiplexed SSH connection (ADR 0015): pushes the lead's own commit as a `git bundle`, writes the peer's bind from a value read off that machine, and pipes the invite token over stdin only; the last line reports whether the member is non-provisional after first contact (42114c0)

## [1.0.0-alpha.13] - 2026-08-12

### Added

- **`collie doctor`** — one read-only pass over the traps that fail silently: bind/ACL/front-door/web-dist/herdr-socket/clock locally, drift/rotation/reachability/version-skew in a pack; every finding names the fixing verb, warnings exit 0, `--json` for scripts (27e756b)
- A member probe's success now carries the far side's HTTP `Date` (transport metadata, not a wire field) — doctor's clock check reads it against §8.6's ±5m signature window (1dc6c72)

## [1.0.0-alpha.12] - 2026-08-12

### Added

- **Version-skew policy (§7.1, closes §17's last open item)** — `hello`'s response carries the answering build's version (optional, additive; absent = pre-amendment, rendered honestly); `pack status` shows each member's version and warns on skew naming both versions and the remedy; the protocol integer alone refuses — build skew never does (0119635, 453a323)
- `bridge/version.ts` — one version resolver shared by CLI and bridge (bare string on the wire, printed form for humans), threaded into the pack router once at boot (453a323)

### Changed

- Docs teach `bin/collie <verb>` as the operator spelling; `collie-ctl.sh` survives as the bootstrap shim it now is, explained once (c08f8f9)
- ADR 0015 — `pack add` will push the lead's own commit over the operator's SSH (own transport, git bundle, no new wire surface); spec groundwork, no behavior yet (d4a1ad4)

## [1.0.0-alpha.11] - 2026-08-11

### Added

- `collie qr` — the QR verb is now in the binary, with the tailnet-ACL probe it needs; `collie-ctl.sh qr` keeps working via delegation (15c559e)

### Changed

- **M6/01** — `scripts/collie-ctl.sh` is now a 106-line bootstrap shim: it resolves Bun, builds `bin/collie` from source when absent, and execs it — the CLI is the single implementation of every lifecycle verb. Manifest command strings, action ids and every `collie-ctl.sh <verb>` spelling are byte-identical (frozen per ADR 0006), so nothing operator-facing changes; the script's ignorance of `COLLIE_INSTANCE` goes away with the duplicated logic (9bb86b8, 8268659)
- The shim no longer sources `.env` for Bun resolution — a `BUN_INSTALL` set only there must move to the environment; the CLI still reads `.env` for everything else (9bb86b8)

## [1.0.0-alpha.10] - 2026-08-11

### Security

- **F2 closed** — the lead demotes only against a live operator approval minted on itself: `collie pack approve-promote <member>` (ten minutes, single-use, `--cancel`, restarts the bridge so the running process holds it); an unapproved `POST /pack/v1/lead` gets an honest 403 (`handover_not_approved`), byte-identical whoever is approved, and the demotion additionally requires the claim's fingerprint to match the pinned member's so consent binds the certificate, not just the id (a5f043c)
- **F2** — `collie promote` now surfaces the lead's refusal verbatim and exits without suggesting `--force`; a refusal is proof the lead is reachable, and `--force` stays reserved for a machine known gone (a5f043c)
- **F2 spec** — ADR 0014 + `PACK_PROTOCOL.md` §14 rewrite (promotion is a confirm on the receiver); the peer-side signed handover is relocated to §16 reserved — a peer pins exactly its lead, so the branch it would guard is transport-unreachable in v1 (6d770f1)

### Added

- `pendingHandover` trust-store field (optional, absent = no live approval, fail-closed; `TRUST_STORE_VERSION` stays 1) and a `pack status` line showing a live approval and its remaining window (f232b1f, a5f043c)

## [1.0.0-alpha.9] - 2026-08-10

### Security

- **F5** — `collie join` refuses an `http://` lead address unless `--insecure` is passed: over a plaintext hop the token and pack secret cross in the clear, and an on-path attacker who reads the token can self-enroll its own certificate before the honest joiner (the lead admits on the token alone). **Breaking:** an http:// join that used to work now needs `--insecure` to own the trusted-hop assumption (13a4198)
- **F5** — `PACK_PROTOCOL.md` §8.2/§8.5 corrected: F1's fingerprint pin authenticates the lead to the joiner but does not defend the lead against a token-thief on a plaintext hop (13a4198)

### Added

- `pack status` flags a never-contacted (provisional) member — an enrolled member the lead has never once reached looks exactly like a half-finished join; it says so and points at `pack remove`, cleared on first successful contact (1f43c4c)

### Changed

- `pack rotate` warns it has no grace window — a peer offline at rotation misses the pickup and drops to an `unenrolled` tombstone that must re-join; `pack rotate` is the leaked-secret remedy, at that cost (13a4198)

## [1.0.0-alpha.8] - 2026-08-08

### Security

- **F2** — `PACK_PROTOCOL.md` §8.5 threat model corrected: a compromised peer can issue a consent-free `POST /pack/v1/lead` self-claim that denies the pack and, after the old lead's next restart, drives the *former lead's* terminals — beyond the "its own machine's terminals" the doc claimed; containment (per-member pinning) and the deferred mitigation (promote-as-confirm) stated honestly; no behavior change (6ba66a3)
- **F2** — added a `bun test` canary (`bridge/pack/harness.test.ts`) that asserts Bun 1.3.14 still cannot read a presented client certificate per request and that `server.reload({tls})` cannot re-pin live — it fails loudly when either premise breaks, cueing dismantling of `transportPinned` / signing.ts / §8.6 (6ba66a3)
- **F2** — cross-referenced the "roster of one → boolean attestation" assumption from ADR 0012 into `transport.ts`/§8.6, and noted two inert v2 hazards in comments: the signed string binds neither receiver nor pack id (signing.ts), and the signedAt admission-read vs floor-commit TOCTOU (router.ts) (6ba66a3)

## [1.0.0-alpha.7] - 2026-08-08

### Fixed

- **F3** — `PACK_PROTOCOL.md` §3 no longer claims a peer binds "loopback plus exactly the join address, no `0.0.0.0`" (never implemented, not expressible — `Bun.serve` takes one hostname): the pack listener binds `COLLIE_HOST` and the operator owns that bind; a peer on a wildcard bind (`0.0.0.0`/`::`/empty) now emits a loud startup warning, and `collie pack status` shows the resolved bind — the two-factor gate is unchanged, only who may attempt it (ADR 0013 amended) (813c09d)

## [1.0.0-alpha.6] - 2026-08-08

### Security

- **F1** — the enrollment invite now carries the lead's certificate fingerprint (`<token>.<lead-fingerprint>`); `join` sends only the token on the wire but refuses a lead whose certificate does not match the invited fingerprint, and fails closed on an old-format token — closing the MITM/relay on the enrollment path where nothing authenticated the lead to the joiner (3ab1998)

## [1.0.0-alpha.5] - 2026-08-08

### Security

- **F4** — an unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store (private key + pack secret) or appends a spend audit line when the token spends nothing; a no-op `consumeInvite` now returns `null`, while an expiry sweep still persists, and both refuse identically (2dc6995)

## [1.0.0-alpha.4] - 2026-08-07

> v1 integration line. M5 complete: the phone knows about servers. First real pack live (bluefin lead + minibuch peer).

### Added

- **Prerelease bar** — ALPHA/BETA/RC badge on the header, auto from the build version, sky-toned (82657ac, 35a5fbb)
- **COLLIE_INSTANCE side-by-side knob** + enrollment/demotion staleness surfaced in pack status (e5b0e6b)
- **Host dimension in the web app** — ?h= addressing, (host,session,paneId) cache keys, widened draft keys (8883491)
- **Server view** — switcher, host chips on rows/pane/Send, packed dashboard, honest staleness (df82da4)
- **Two-tier connection health** — per-host live/stale/unknown against the lead's clock; stale panes keep last-good mirror, writes gate with the host named (72991c0)
- **Host-scoped notification taps + /pack/v1 SW denylist**; unreachable servers navigate to last-good instead of disabled rows (97de117)

### Fixed

- cli/pack.test.ts flake: test harness raced a real pack timeout against synchronous fakes (72991c0)

### Known gaps (bridge follow-ups tracked)

- Peer listener binds COLLIE_HOST only (ADR 0013 loopback+join-address bind unimplemented; workaround: COLLIE_HOST=<tailnet IP>)
- A join exiting unreachable can half-enroll (spent token + ghost member on the lead); scheme-less lead addresses fail to dial

## [1.0.0-alpha.3] - 2026-08-07

> v1 integration line. M4 complete: the pack federation engine, end to end.

### Added

- **Instance modes + pack config** — solo/lead/peer derived from enrollment alone; conflict fails toward peer (adf0b8c)
- **Trust store, enrollment, two-factor admission** — hashed spend-once invites, uniform 401, version negotiation behind the gate (79a8552)
- **Lead-side peer client + registry** — verdict classification, clamped timeout budget, last-good state that never vanishes (d00d9cd)
- **Merged snapshot + peer sweep on the existing poll** — host-tagged sessions, no second timer, host addressing mounted (67a0682, 58a5c7d)
- **Byte-for-byte per-pane proxy + forwarded writes** — ETag/304 fidelity, refuse-before-attempt, unknown-outcome discipline, dual-sided audit (eb7c51c)
- **Push convergence** — the lead notifies for the whole pack; peers mute, alerts resume on leave (d953dc9)
- **Pack operator verbs** — invite/join/leave/status/rotate/remove/promote/reconnect with role checks and stdin-only secrets (e5d28fd)
- **Real mTLS pinning + signed membership + two-instance e2e harness** — in-repo certificate minting, handshake-enforced pins, ECDSA-signed membership routes, 32 live assertions (409a410)

### Known gaps (tracked for the next spec)

- The lead needs a restart after its first enrollment before it starts merging; promote does not restart the demoted machine (409a410)

## [1.0.0-alpha.2] - 2026-08-07

> v1 integration line. M3 complete: the `collie` CLI fully absorbs `collie-ctl.sh`.

### Added

- **`collie` CLI skeleton** — compiled binary (`bun run build:cli`), verb table, env-stripped context/tool resolution; compile-safe root anchoring replaces `import.meta.dir` (66baccc)
- **Native lifecycle verbs** — start/stop/restart/status/url/logs, `_exec-bridge` as the unit's ExecStart, COLLIE_SUPERVISOR test seam (c3b819d)
- **Native front door + uninstall** — serve/unserve with the managed-handler ownership record (ADR 0001), uninstall (13399b9)
- **Native build/update/push-test** — dual atomic swap (binary + dist), ADR 0006 two-shape update re-execing the fetched source, in-process push-test (0a898d1)

### Changed

- Root `bun run build` now runs the version gate; `collie-ctl.sh` remains intact as fallback (shim-vs-delete deferred to M6) (0a898d1)

## [1.0.0-alpha.1] - 2026-08-07

> **`1.0.0-alpha.x` is the v1 integration line, not a shipping release.** `0.24.2` remains the
> released line for operators; nothing here changes a running deployment's behaviour.

### Added

- **Pack federation protocol contract** — `PACK_PROTOCOL.md` (wire contract, trust model, solo
  zero-tax §11) plus ADRs 0011–0013 (9bd9301)
- **Solo zero-tax characterization baseline** — `bridge/solo-baseline.test.ts` + committed goldens
  pin today's snapshot bytes, ETag, routes, config/env keys, `<stateDir>` file set, notification tags
  and audit lines before any federation code exists (407aada)
- **Client half of the baseline** — `web/src/lib/solo-baseline.test.ts` pins the mirrored wire types (407aada)
  and that a solo client emits no host param

### Fixed

- **`PACK_PROTOCOL.md` §11's files-written row omitted `update-state.json`** — the baseline found it;
  the row now lists the real set

## [0.32.0] - 2026-08-19

### Added

- **F1–F12 in the Keys tray, behind an "F keys" disclosure** — chords with armed modifiers included (#119 by @martin-tahli) (09b0571)
- **`keys.toml`: your own Keys-tray preset rows** (label + chords + optional `danger`), live-reloaded, replacing the shipped presets on the panes they address per ADR 0018 (c02ab19)
- **The update gate (ADR 0020)**: a routine `update` follows release tags within the installed major; crossing a major takes explicit consent — `update --major`, wired as the `update-major` plugin action (633b2a1)
- **The update banner says which kind of behind you are** — an in-major release, or a pending new major with the consent command (a38df8c)

### Fixed

- **A cold boot with no network renders the cached last screen**, dated "last seen HH:MM" — never a false "No agents" (0f4c651, c473aa0)
- **A stale pane mirror is dated by its own stamp, not the herd's** (1042fe0)
- **The linked-clone major gate judges the branch's own upstream (`@{u}`), not the remote default branch** (99910cf)

## [0.31.1] - 2026-08-18

### Fixed

- **A long request survives socket backpressure** — Bun's socket accepts fewer bytes than it is handed under pressure and queues nothing; the dialer now parks the tail and resumes from `drain`, so a big request can no longer silently truncate and die on the timeout (cc810c9). Probed while fixing: herdr drops any request line of 1 MiB or more — now in `HERDR_API.md`

### Changed

- In-code pointers name `DEPLOYMENT.md` now that variants B–E live there (cd2f1f8); `COLLIE_MULTI_SESSION` spelled `on`/`off` everywhere; `push-keys`/`push-test` listed in the Commands table (ee64069)

## [0.31.0] - 2026-08-18

### Added

- **`push-keys` generates the VAPID keypair and writes it into the right `.env`** — Web Push setup is now three plugin actions (`push-keys` → `restart` → subscribe), no manual key wrangling (85f0454)
- **"Tap to type" can be turned off** — a display setting stops the mirror volunteering the keyboard on a tap; on by default (357b86f)
- **`COLLIE_AUDIT_CONTENT=none` keeps the audit trail and drops the bodies** — a fail-closed allowlist keeps action parameters legible while anything operator- or screen-originated redacts (#107, 5dda876, cdad445) — thanks @shuangwangnyc
- **Your own slash commands in the palette, declared in `commands.toml`** — on a pane your rows address they replace the shipped catalog (ADR 0018); `confirm = true` adds a two-tap; edits are live, no restart (#109, 35da673, 28bdf5a) — thanks @enieuwy

### Fixed

- **⚠ A paste too big to persist no longer restores an older, shorter draft after a remount** — oversize drafts now ride an in-memory tier whole, never truncated and never swapped for stale text; they survive pane switches but not closing the app, and the composer says so (7965674)
- **A half-arrived long send is no longer accepted as send evidence** — when the input box ends in literal text it must be the end of what was sent, or the guard refuses to press Enter (#110, 27f4cdf)
- **Direct typing no longer owes a "mode stopped" notice to the next pane**, and the blur it schedules is settled by cancellation instead of racing a re-arm (#108, 452da20, 1a2ca49) — thanks @enieuwy

### Changed

- **README cut to ~60% of its length, how-first** — deployment variants B–E now live in `DEPLOYMENT.md`, and troubleshooting entries are findable by the words you'd actually search (9464c14, c52d4af)

## [0.30.0] - 2026-08-16

### Added

- **A password prompt says what it is and offers the control that works.** `sudo`, an SSH passphrase and `gpg` echo nothing, so Send's verification can never arrive — the refusal now names that and hands off to **Type** in one tap, instead of "a menu or dialog is probably up" (#103, 1334540)

### Fixed

- **A password typed into the composer is no longer kept for 48 hours** — recognising the prompt drops the stored draft and stops persisting keystrokes; the write-through had stored it before any send was attempted (#103, 1334540)

## [0.29.0] - 2026-08-16

### Added

- **The plan dialog's feedback row has a route from the phone.** Row 3/4 is a text input, not an option: Collie now models it, locks the other buttons while the terminal owns it, and sends feedback through the guarded choreography — digit, verified paste, bound Enter (#95, c0ce09e, 967e94d, 64de1d4) — thanks @navidkashani
- **A pane is named by what its process says it is doing** — its OSC title, glyph-stripped and dropped when it only repeats the agent or project — so a project's herd stops reading as N identical rows (#100, 9dbc0fe) — thanks @praneetrohida

### Fixed

- **A long plan-feedback value re-flows across lines instead of windowing** — the value is rebuilt from continuation lines and the footer gap widened, so a 355-char value no longer makes the whole dialog vanish (#95, 64de1d4)
- **A shell's `user@host:cwd` title is a locator, not a name** — it no longer replaces the row's cwd with a longer restatement of it (#100, 982b8e1)
- **A push re-subscribe replaces the row it supersedes**, and each row records when and from which browser it was made — Apple keeps answering 201 for an orphaned endpoint, so this is what stops `push-subscriptions.json` growing forever (#104, 0021300)

## [0.28.0] - 2026-08-12

### Added

- **omp gets a harness adapter (Tier 1)** — read-only blocks by construction, its own composer chrome stripped, a slash palette sourced from its captures — a reply stops confirming its pickers (#93, b98b90d) — thanks @qaz74107410
- **Every `COLLIE_*_ROOT` (including `COLLIE_TRANSCRIPT_ROOT`) takes a comma-separated list**, so pane history works across multiple `CLAUDE_CONFIG_DIR` profiles (#92, b549101)
- **`contrib/windows/`** — a community-maintained Task Scheduler lifecycle for Windows (#71, 8572e49) — thanks @Pimpmuckl

### Fixed

- **Update-available pushes to Apple devices never arrived — broken since 0.11.0.** The Web Push topic was an impossible base64 length and APNs refused it; herd alerts were unaffected (#90, 19572d7) — thanks @ojulean
- **The destructive pre-clear sweep now fires only after a live read positively sees the composer**, bound to the prompt it saw — a dialog opening in the gap can no longer eat the burst (#93, 6c8332f)

## [0.27.0] - 2026-08-10

### Added

- **`collie-ctl.sh qr` prints the tailnet URL as a scannable code**, so a phone doesn't have to type a MagicDNS name — opt-in as its own subcommand, since a PWA only needs the URL once. Corrects two defects in the renderer it uses: its filled glyph is a *light* module, so the compact output inverts on a light terminal, and its quiet zone is 1–2 modules where the spec asks 4 (#88, ff84538) — thanks @adrgarcha
- **`start` and `status` say when this node's packet filter admits no peer**, instead of printing the tailnet URL under a green ✓ that no other device can open — the local probe only ever sees loopback, which never touches the filter. Best-effort and deliberately unsure: it speaks up only on a total deny, and stays silent whenever it can't tell (#87, 82bbe0e) — thanks @adrgarcha

### Fixed

- **Idle Claude panes no longer scroll up and snap back on every poll** — the session-name sniffer read `recent`, which on a pane shorter than the read makes Herdr scroll a full-screen agent to reach the rows above it; it reads the visible grid now (#85, dab122e) — thanks @OowhitecatoO
- **A lapsed session behind a redirecting identity proxy shows the Sign-in banner** rather than "can't reach Collie" — API requests now carry `X-Requested-With`, so a proxy answers 401 instead of a 302 that `fetch` follows into an opaque CORS failure with no status to classify (#86, 0dc852e) — thanks @ojulean

## [0.26.0] - 2026-08-10

### Added

- **Type into terminal** — a toggle beside Keys in the Controls row sends what you type straight to the pane as keystrokes, no trailing Enter, so a TUI that wants bare letters (`b`, `q`) can be driven from a phone. Ordered and batched, so a slow tailnet grows the next batch instead of scrambling characters; it never survives a pane switch, a lock, a hidden page or a failed batch (#74, 7dea503) — thanks @aspiers
- **GFM tables render as tables** in Conversation history instead of collapsing into one run-on paragraph — recognised by their delimiter row, alignment and ragged rows included. A table nested in a list or blockquote still collapses: the block parser is flat, and agents put tables at the top level (#72, d82ef1b)
- **Nerd Font symbol glyphs stop rendering as tofu** — two subset woff2 faces ship with the app, fetched only when a pane actually paints a private-use glyph (`unicode-range`) and deliberately kept out of the precache (#70, d31d97d)
- **A quick Ctrl+C in the nav tray's Esc/Up gap** — one tap, without opening Presets (#75, d139b1b) — thanks @Jarva

### Changed

- **A long terminal rule clips at the mirror edge** instead of wrapping into several rows; its full text stays in the DOM, and ordinary output keeps wrapping normally (#79, 4480019) — thanks @en-ver
- **The composer row reads its own state** — an open dock or an armed mode carries a light-sky tint instead of a grey surface, the attach button moves inside the text field, and the "Controls" tag floats above the row so four labelled toggles fit a 390px phone unclipped (57080f5)

### Fixed

- **Sends stalled on a narrow pane with "Message didn't reach the input box"** — the guard located Claude's input box by a run of 20 rule glyphs, which is a hidden assumption that the pane is at least 20 columns wide; it now measures display cells, and the wrapped-draft scan reaches past a long CJK draft (#76, de88b38) — thanks @tyamanak
- **The ctl test suite re-initialised the repository it was run from** — git exports `GIT_DIR` into hooks, which overrides discovery for every git command including `-C`, so the sandbox's `git init` landed on the developer's own checkout (51fce21)
- **The ctl suite failed on a Homebrew Mac** — `resolve_bun`'s absolute-path fallback escaped the sandbox PATH and brought the real `tailscale` back with it, defeating the missing-CLI case (5c48721) — thanks @tyamanak

## [0.25.0] - 2026-08-07

### Added

- **A subscription that keeps failing is retired** after 5 consecutive failures, so stale duplicates (PWA reinstalls) stop accumulating and re-logging every cycle — counted only when a sibling on the same push service succeeded that round, so a service-wide rejection never costs a live device (#68, 2ea3e61) — thanks @alshedivat

### Fixed

- **Push failures log the status and the service's reason** instead of web-push's constant "Received unexpected response code", which named neither (2ea3e61)

## [0.24.2] - 2026-08-06

### Fixed

- **A wrapped CJK reply stalled unsubmitted** — the input box folds its wrapped lines with a space, fabricating one the send never had (CJK has no spaces to wrap at), so the guard's slice check could never match; each seam is now judged on its own, and only a gap the fold itself could have made is loosened (#66, 6def208) — thanks @tyamanak
- **The guard feature-detects `Intl.Segmenter`** and falls back to code points, so an engine without it (Firefox < 125, Safari < 14.1) loses grapheme precision instead of white-screening the app at boot (46a85d1)

## [0.24.1] - 2026-08-06

### Fixed

- **Long/multi-line replies to Claude panes stalled unrecoverably** — the send guard now reads Claude's `[Pasted text #N +M lines]` placeholder as send evidence when consistent with the sent message (ADR 0010) (e9f1a33)
- **Stranded-draft preview withdraws "Take over" when the line holds only Claude's paste placeholder** (e9f1a33)

## [0.24.0] - 2026-08-05

### Added

- **Buttons for Claude's `/model` picker, and any modal like it** — a last-resort grammar reads the footer's `<key> to <verb>` hints and renders them, with the arrows the screen advertised, over the mirrored region (5392ac7)
- **The ←/→ pair says what it adjusts** — the picker's live value ("◐ Medium effort") sits between the arrows and in their accessible names (d872490)
- **A send is refused before it types when the agent's input box isn't on screen** — the draft is kept, and a second Send is a deliberate "Type anyway?" that still never fires the submit key blind (c4ffe45)

### Fixed

- **A half-written reply survives leaving the pane** — drafts are kept per pane (48h, localStorage, so an OS-killed PWA doesn't lose one) instead of dying with the composer when you step over to another tab (9d41411)
- **A reply is no longer typed into a full-screen picker** — the original `/model` bug: no grammar claimed the screen, so the message fed the picker and came back "stalled" (c4ffe45, 5392ac7)
- **The stalled message says a key answer probably landed** — the part that made the original report confusing (c4ffe45)

### Changed

- **Modal menus are a documented harness contract** — the model and its footer/key grammar are harness-neutral, so a future codex/pi/opencode adapter implements them from types plus a conformance leg, not from Claude's internals (0c9dace)
- **A generically-detected menu never synthesises a digit** — in the `/model` picker a digit confirms *and* saves your default for new sessions; [ADR 0009](.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) records why (5392ac7)
- **Every dialog model is a harness contract, not a Claude internal** — the prompt-select, wizard, preview and multi-select payloads join menus in harness-neutral modules, so the AST and the renderers no longer point at one agent's grammar (3b5cf7c)
- **One race guard for every dialog, run through the pane's own adapter** — no more re-deriving through Claude's detectors; an adapter that emits a block kind gets the guard for free, and no adapter fails closed (79ebc0c)
- **The conformance suite pins the signature + identity contract for every block kind** — not just menus: a constant signature, or a comparator that passes a screen that changed, now fails CI (b78aa0f)

## [0.23.3] - 2026-08-04

### Fixed

- **The idle lock no longer ambushes you on the way back in** — a hidden page never locks and returning to the foreground auto-resumes, so it can only appear when Collie is left open, visible and untouched (746ce87)
- **A pause no longer eats an in-progress reply** — the cover sits over a still-mounted router instead of replacing it, so draft, scroll position and open sheets survive it (746ce87)
- **Resuming shows the catch-up instead of handing back a frozen screen** — the cover holds through the refetch, badge swapped for the gallop, and releases when it settles (4ffce3c)

### Changed

- **The lock screen is glass, marked, and honestly worded** — the herd stays legible underneath, the Collie mark says whose screen it is, and there's no lock glyph or "for safety": it gates nothing, and [ADR 0007](.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md) records why (746ce87, 4ffce3c)
- **`ARCHITECTURE.md` no longer lists the idle timeout as a security measure** — it never implemented one (746ce87)

## [0.23.2] - 2026-08-04

### Fixed

- **Agent alerts now send at high urgency** — at web-push's default (`normal`) Android was free to defer them by Doze / App Standby bucket, so pushes were accepted by FCM and never delivered (79f30e6)

## [0.23.1] - 2026-08-03

### Fixed

- `update` now works in a `herdr plugin install` checkout — it is detached and shallow, so `git pull --ff-only` could never run there (#63) (aeeddcd)
- `update` no longer re-links a Herdr-managed checkout, which would re-register it as local and block `herdr plugin install` (aeeddcd)

### Upgrading — `herdr plugin install` users must reinstall once

The fix ships *inside* the checkout it repairs, so `invoke update` still can't run on an install made
before 0.23.1. Take the fix with one reinstall (config and serve state live outside the checkout and
survive), after which `invoke update` works normally:

```bash
herdr plugin install AltanS/collie --yes
herdr plugin action invoke restart --plugin herdr.collie
```

Installs from a `git clone` + `herdr plugin link` were never affected — use `invoke update` as usual.

## [0.23.0] - 2026-08-03

### Added

- **Every key press and quick reply now answers you.** A nav-tray press was silent on success and deferred to a mirror that can be ~2s behind, so tapping Enter felt like nothing happened; the pressed button now fills on the tap (synchronous, no network wait) and shows a ✓ once the bridge accepts it. Quick replies echo on the tapped button and the dock outlives the send, closing after the ✓ instead of on the tap (3be4934)
- **Hold an arrow key to repeat it** — driving a long TUI menu no longer means tapping ↓ fifteen times. Repeats accumulate locally and flush as one batched `send_keys` array with exactly one call in flight, because ordering across two concurrent one-shot RPCs is unguaranteed. Arrows only, by whitelist; a hold while composing stages one chip, not fifteen (e7ada40)
- **Haptics** — a short buzz on press, toggleable in Settings, silently absent where the platform has no `vibrate` (e7ada40)
- **Quick replies follow the pane kind:** a shell gets `y`/`n` instead of "commit and push" and "skip", which mean nothing at a bash prompt (e7ada40)

### Changed

- **The pane's two control rows are now one.** Wrap, raw terminal and text size moved behind a ⚙ into a labelled panel — the raw-terminal escape hatch had been a bare `>_` glyph whose only explanation was a `title` attribute no phone ever shows, and it now says what it does. Find moved to the header, where its find bar already takes over the row. The mirror gets ~85px back (3be4934) — general direction from @simonallfrey in #49, whose "consolidate the terminal toolbar" proposal is what started this; thank you
- Closing the Keys dock on a composed key queue takes a second tap. The queue is still discarded rather than persisted — one surviving into a later open would let Send fire yesterday's chord into today's TUI state — and the guard sits on the drawer transition, since the Keys toggle and the Quick/Agent/Display buttons unmount the tray just as effectively as the ✕ (e7ada40)
- A single key press revalidates on the leading edge instead of sitting out the full 300ms burst window before its refetch even started; bursts still coalesce into one trailing refetch (3be4934)

## [0.22.0] - 2026-08-03

### Added

- **OpenCode panes get Conversation history.** OpenCode ≥1.x keeps every session in one SQLite database (no per-session log), so its journal adapter reads `opencode.db` readonly with bound parameters, touches only the three transcript tables (the same file holds auth tokens), and serves all sessions through a per-session cache key. Needs `herdr integration install opencode` once, then restart OpenCode in the pane (#61, 539cdf4) — reported by @xabilarra
- **A multiselect question inside a wizard is now a tappable dialog**, not raw terminal text. It was owned by no grammar — wizards refuse checkboxes (a wizard digit selects *and* advances; a checkbox digit only toggles) and multi-select only knew the single-question form. It now carries the wizard's step chips, navigates with the wizard's own Left/Right keys, and reads the advance row's label ("Next" / "Submit") from the pane by position, never by assumption (#51, bdf4c26) — thanks @konpyl

### Fixed

- **A preview dialog whose option label wraps no longer falls to the raw mirror.** The grammar required numbered rows on consecutive lines, but the ~30-column gutter wraps longer labels onto continuation rows; a contiguity walk anchored on the label column replaces adjacency (#51, bdf4c26) — thanks @konpyl
- `ReadSource`'s unwrapped variant matches the wire: `recent_unwrapped`, snake_case — the kebab spelling was rejected by Herdr and nothing had ever called it. HERDR_API.md records the probed contract, including that the source is a byte-identical no-op for Claude panes (alt screen + renderer-hard-wrapped prose), which is what closed #53 part 2 by measurement (bddded3)
- `multi-select-action.ts` no longer carries a literal NUL byte (git classified it binary and hid its diffs from review); `.gitattributes` keeps any future stray byte from costing reviewability (#51, bdf4c26)

## [0.21.0] - 2026-07-31

### Added

- **macOS supervises the bridge with launchd.** `start` installs a LaunchAgent (`~/Library/LaunchAgents/herdr.collie.plist`), so the bridge comes back at login and restarts on failure — the parity with the `systemd --user` unit that macOS never actually had (#55, #57, a0be73d) — thanks @darieldatoon
- **The statusline strip shows every row of the run, in the agent's own colour.** Model, cwd, git branch and permission mode live on rows 2+ and were surfaced nowhere; the strip renders them stacked, in the mirror's colour space (#60, 61db7a5, ac3c62d)

### Fixed

- **Sending no longer stalls under a tall statusline** (the run may be 8 rows, was 3). A taller run made `locateInputBox` miss the input box, so a send typed the text and then withheld Enter — with no stranded-draft preview and no pre-clear sweep, so retries stacked duplicates in the pane. Reproduced on a 3-row statusline sitting one wrapped line from the cliff (#54, #56, fe8e548) — thanks @stekman08
- `launchctl bootstrap` is retried across launchd's teardown window, so `restart` — and therefore `update` — can't end with the bridge down (b1ebb83)
- A Mac that can't bootstrap (no console login, so no `gui/<uid>`) keeps an unsupervised bridge instead of exiting with nothing running; `status` reports that degraded tier (5b5106c)
- The pi journal fixture is portable to macOS, where `containedRealpath` resolves `/var` → `/private/var` by design and the backend suite couldn't run at all (a7d8f9a)

### Changed

- **The mirror wraps by default.** Herdr spawns panes at the desktop terminal's width against a phone's ~45–50 columns, so panning was the common case, not the exception; column-faithful no-wrap stays one tap away in View. Display prefs reset to defaults on first load (storage key v4), so a pinned font size needs setting again (#53, 273d886, 73cc7da) — reported by @waynehoover
- ADR 0004 records that the statusline-run bound guards less than it looks: a dialog below the input box is refused by the border checks and by the blank line above its footer hint, never by the row count (36c78c7)

### Upgrading

- **macOS installs migrate on the next `update` or `start`**: the old unsupervised bridge is stopped and replaced by the LaunchAgent. It's a *LaunchAgent*, so it starts at **login**, not at boot — and a Mac administered purely over SSH has no `gui/<uid>` to bootstrap into, so it stays on the unsupervised bridge with a warning until someone logs in at the console once.

## [0.20.2] - 2026-07-30

### Fixed

- `herdr plugin action invoke update` no longer dies with `bun not found on PATH` — Herdr spawns actions with no login shell, so Bun is now found in its install locations too, not just on `PATH`. A failed run had already fast-forwarded the checkout, leaving the old `web/dist` being served (#52, 08f44f6) — thanks @konpyl
- Only an absolute Bun path is prepended to `PATH`, so a `bun` shell function in the plugin `.env` can't put the CWD in front of `git` / `systemctl` / `tailscale`; the control script's Bun resolution now has test coverage (4841e37)

## [0.20.1] - 2026-07-29

### Fixed

- Journal rotation-following re-checks containment, so a sibling symlinked out of the Claude projects root can no longer be served as a pane's history (e8b1357)

### Changed

- Dependency versions must be 7 days old before they install, via `bunfig.toml` (`.npmrc` for npm users) (bf38d45)

## [0.20.0] - 2026-07-29

Three contributions from @konpyl carry this release — light and system themes (#41), the triaged
dashboard (#42) and tappable URLs in the mirror (#45), landed via #46/#47/#48 with review fixes on
top. Thank you: measured rather than estimated, with the reasoning written down where it will be
argued about again.

### Added
- **Light and system themes.** Collie follows your phone's appearance by default; pin Light or Dark from **Settings → Appearance**. Per device, and documented under [Dark mode / light mode](./README.md#dark-mode--light-mode) (#41, 59bcfe1, df47112)
- ANSI slots 0–15 are now CSS variables (`--ansi-*`), so indexed terminal colour is defined in one place and reaches the mirror through both `31m` and `38;5;1` spellings (59bcfe1)
- **The dashboard is triaged, not listed.** Needs you → Ready · unseen → Working → Recent; the first three are pinned, Recent sorts by when you last used each pane (#42, da4f44c)
- **Ready · unseen** — agents that finished while you weren't looking. Opening one clears it, on every device (2f4d691)
- Recent and Spaces fold and remember it; fold both and the page is the triaged herd and nothing else (da4f44c)
- The swipe-up **Switch pane** sheet folds its long tails too — Recent, and the bare **Shells** group that buried the agents underneath it (4cca8db)
- Spaces are ordered by last used and filterable — 45 of them are now three keystrokes, not a scroll (da4f44c)
- The bridge keeps two timestamps per pane (`activeAt`, `seenAt`) in `activity.json`, because Herdr reports none (2f4d691)
- **Tab and space chips carry a status dot** — blocked / ready / working / idle, in the herd list's own palette. They only ever showed a dot for blocked before, so every other state read the same as every other (22d4a5f)
- **URLs in the pane mirror are tappable** — `http(s)://` text becomes a link that opens in a new tab, keeping the colour the agent printed and marked by an underline (#45, cc38351)
- Trailing prose punctuation is trimmed with paren balance respected, so `Fetch(https://x.dev/a)` links the URL and not the paren; a find hit inside a URL still highlights, and a URL that changes colour mid-way stays one link (cc38351)

### Changed
- The pane mirror renders in dark space under every theme and light mode inverts it, because agents emit truecolor almost exclusively and no palette can re-theme an absolute colour — [ADR 0002](.adr/0002-invert-the-light-terminal-mirror.md) (78425bd)
- In light, the page is a step off white with cards staying white, so the dashboard's hierarchy no longer rests on a single hairline — and the mirror's edge stops showing a seam (59bcfe1)
- **Agent rows are titled `project · tab`, not "claude".** The pane's own name moves to the second line; the agent stays in the avatar (da4f44c)
- Spaces moved BELOW every agent section — it's a navigator, not a work queue (da4f44c)
- Only Collie's own reads count as seeing a pane; a Herdr focus at the desk does not — [ADR 0003](.adr/0003-one-shared-seen.md) (6786ca1)
- MINOR, not MAJOR: pre-1.0, purely additive, no config or API break. Defaulting to your phone's appearance is the feature working as designed and Settings pins it either way; an older bridge reports no activity timestamps and simply renders the previous dashboard, minus the one section that would be empty

### Fixed
- **The space and tab chip rows overlapped each other on the space screen** — both strips were missing `shrink-0` inside the route's flex scroller, so they collapsed to 16px around 32px chips and the tab row painted over the space row. Pre-dates this release (636b7af)
- Three `role="alert"` warnings (incomplete multi-select, wizard, preview) used a hardcoded yellow that measured ~2:1 on white; they use the status palette now (59bcfe1)
- An off notification switch was unreadable in light — a white thumb on a 1.09:1 track, legible only by its shadow. It carries an outline now (59bcfe1)
- Focus rings were drawn at half strength, 1.77:1 in light and 1.87:1 in dark; both are full strength now (59bcfe1)
- Small muted text (section labels, the build stamp, the terminal status line, the `(n)` counts) fell under 3:1 in light — light `--muted-foreground` had no headroom left for the `/70` and `opacity-60` modifiers stacked on it, so it was darkened and the modifiers dropped (59bcfe1)
- Header controls had 20px touch targets; the Settings gear and the Settings back button are both 44px now, with no change to how they look (59bcfe1)
- The boot splash stepped from white to the page colour when React took over, and its caption measured 3.45:1 — it used `#ffffff`/`#8a8a8a` under a comment claiming they matched `--background`/`--muted-foreground`, which rasterize to `#f5f5f5`/`#5d5d5d`. Same fix for the light `theme-color` meta, so Android's URL bar matches the page (7f0189d)
- Inverse-video segments in the mirror emitted theme tokens while the muted glyphs beside them used literals; the mirror keeps one spelling now (identical pixels — the literals are those tokens' dark halves) (7f0189d)
- Marking a pane seen had made a read-level GET mutate state, so a cross-site `<img>` at a guessed pane id could silently clear your unseen agents. Only a request carrying the app's own header counts now — caught in this release's security review, never shipped (f9000cb)
- Only a request that will actually be served marks a pane seen — one falling through to 405 no longer clears an alert (f7e616b)
- **Light `--accent` was byte-identical to `--background`**, so "this is the current one" showed nothing in light mode — the open pane in the switcher, the current session, every `hover:bg-accent`. Predates this release; found by the UX sweep (dab7e05)
- Titles truncated away the tab — the only part that identifies a row — leaving several panes rendering the same `moonward_os · t…` (8a8a4c9)
- Section headings rendered at two different sizes and cases, because a `<button>` doesn't inherit `text-transform` from its `<h2>` (8a8a4c9)
- A hollow status ring on the avatar's corner read as a notch cut out of the logo (5c04453)
- A space row and its chip could disagree about what a colour meant — the row still ranked by `STATUS_RANK` while the chip used the triage classifier, so a space holding one working agent and one unseen-done agent showed "working" on the dashboard and "ready" in the strip. Both route through `bucketOf` now, in one pass rather than spaces x agents per render (e024f48)
- `aria-controls` on a collapsed section pointed at an element that isn't rendered — exactly when a screen-reader user is deciding whether to expand it (e024f48)
- A status dot passed a smaller size only resized its wrapper, so chip dots rendered at the wrong size (e024f48)
- The Settings page rearranged itself a frame after opening — Notify-when and Snooze mounted only once push state resolved, inserting ~400px into the middle of the page, and Notify-when then grew another ~180px waiting on its own prefs. Both render from the first frame now, switches disabled until their values land (3d5b191)
- The pane row ran straight into terminal output with no edge between them, so the chrome and the mirror read as one surface (e208408)
- Herd and space rows had a border radius with no border to own it, so a rounded hover fill sat under a straight `divide-y` hairline. Rows without a border are square; the ones with a real border keep their radius (3d5b191)

## [0.19.0] - 2026-07-29

### Added
- **Journal (pane history) is now per-harness, with Codex and pi support.** Reading an agent's own session log is an adapter keyed on the pane's agent (`bridge/journal/`), so a new harness is an adapter rather than a fork of the reader — Codex reads its date-partitioned `rollout-*.jsonl`, pi its per-cwd session log. Raised in #40 by @simonallfrey, who asked where to implement journaling for Codex (7e3b2bd)
- **`scripts/journal-probe.ts`** probes every adapter against the real logs on the host — the format-drift check unit tests can't make. It caught Codex 0.145 adding a `developer` message role the parser would have rendered as operator speech (7e3b2bd)

### Fixed
- **pi could never have had history.** pi reports its session as a kind-`path` ref (an absolute path) and the bridge kept only kind-`id` refs, so a pi pane arrived with no session at all. Both kinds are kept now; a path ref is confined to that harness's root after symlink resolution (7e3b2bd)
- **A pane relaunched as a different agent served the previous agent's session ref.** Herdr keeps reporting the last session announced for a pane — a pane running pi still advertised a `herdr:claude` id. The ref is dropped unless its own `agent` matches the pane's (7e3b2bd)

### Changed
- **A pane's session reference no longer goes to the browser.** `/api/snapshot` sends `hasSession` instead — for pi the reference is a filesystem path, and the History affordance only ever needed "may this pane have history?". It is now also gated on the harness actually having an adapter (7e3b2bd)

## [0.18.0] - 2026-07-28

### Added
- **Approvals are bound server-side to the prompt they were decided against.** `/keys` and `/reply` accept an optional `expected_prompt`; the bridge re-reads the pane immediately before writing and refuses with `409 prompt_changed` if the dialog moved. Shrinks the guard window from human latency to two local RPCs — a mitigation, not a guarantee, until herdr gains a conditional-input primitive (#29) — thanks @Optic00 (6afaf5b)
- **`/auth/` is reserved for a fronting proxy's sign-in page**, and the service worker always passes it to the network. An installed PWA could not reach a proxy page at all before — the precache answered every navigation, reload included — so operators had to squat a page inside `/api/`. The refusal banner now links there (#31) — thanks @Optic00 (1a5972b)

## [0.17.0] - 2026-07-27

### Fixed
- **A reply sent while an agent dialog was focused answered the dialog instead.** The submit key approved whatever option was highlighted (Claude defaults to "Yes") and the message was destroyed, while the bridge reported success. Sending now refuses outright while a dialog is up, and otherwise types first and only submits once the text is verified in the input box (#34) — thanks @maikschuheida-spec

### Changed
- Free-text replies on harnesses with a block grammar (Claude) are two steps — type, verify, submit — so "Sent ✓" now means the text was seen in the input box. Harnesses without an adapter keep the previous one-shot send

## [0.16.1] - 2026-07-27

### Fixed
- `/api/config` is now gated like every other endpoint — it was the one route that skipped the same-origin check and `COLLIE_PUBLIC_HOSTS`, noted by @Optic00 in #32 (a54afd9)

## [0.16.0] - 2026-07-27

### Added
- Bring-your-own-tunnel deployment path documented as **Variant E** — NetBird, ZeroTier, Cloudflare Tunnel (6550041)
- `scripts/collie-ctl.test.sh` — first lifecycle coverage for the control script, wired into the pre-push hook (a004449, 65889da)

### Fixed
- `unserve`/`uninstall` no longer remove a `tailscale serve` mapping Collie didn't create, and `start` no longer replaces one (a004449, thanks @iamtimmy)
- A front door that fails to publish no longer aborts `start` before the status banner (65889da)

## [0.15.0] - 2026-07-26

### Added
- Pane conversation history read from the agent's own transcript — scroll back past the live mirror (77dff7c)
- Windows support for the bridge: dials herdr's named pipe through `node:net`, one code path for both platforms (#25, #27) — thanks @mikebenner and @bwright2810 (dd6610d)
- `COLLIE_HERDR_DIAL=auto|net|bun` forces the dialer; `net` exercises the Windows path on Linux/macOS (f662834)

### Changed
- **Breaking, only if `COLLIE_DEVICE_HEADER` is set:** a request arriving *without* the device header is now read-only. It previously got full write access, which let any tailnet client reach the bridge's own URL and skip the proxy that injects the header. Front doors that inject it on every request are unaffected; direct loopback/MagicDNS access now needs the header sent by hand (#28) — thanks @Optic00 (8ed715d)

### Fixed
- A 401/403 no longer renders as an endless "reconnecting" banner — an access refusal now says so and offers Reload (#30) — thanks @Optic00 (7bdcbfb)

## [0.14.2] - 2026-07-23

### Added
- Paste an image straight from the clipboard into the composer, same upload path as the picker (#24) (ad6957b)

## [0.14.1] - 2026-07-22

### Fixed
- `collie-ctl.sh self_dnsname` shelled out to `node`, which Collie never requires — now uses `bun` (#22) — thanks @jz-wilson (a61f3d1)

## [0.14.0] - 2026-07-21

### Added
- Alt modifier in the nav tray — `alt+<key>` chords now reachable from the phone (#19) — thanks @bnivanov (d1dc947)
- Modifiers combine (checkbox, not radio): `ctrl+shift+p`, `alt+shift+p`, even triple chords (#20) (d1dc947)
- Modifier lock — tap an armed modifier again to keep it armed across presses and Sends; Clear or a third tap releases (#20) (d1dc947)

### Changed
- HERDR_API.md: multi-modifier chords live-verified in any order against Herdr 0.7.3, cross-confirmed on 0.7.4 by @bnivanov (b505c4e)

## [0.13.2] - 2026-07-20

### Fixed
- Tabs render in Herdr's reported order instead of stable-number order, so a reorder in Herdr survives to the screen — thanks @iFwu (a16478f)
- Tapping raw terminal output focuses the composer synchronously, keeping iOS's user-activation window so the software keyboard opens — thanks @iFwu (a78ccfd)

## [0.13.1] - 2026-07-20

### Fixed
- Taking over or sending a draft no longer permanently mutes the preview for that same text — the handled key resets once the host line clears (7153639)
- Send's pre-clear sweep overshoot widened 8 → 32 so host typing inside the poll gap can't leave a remnant (7153639)
- A scrollback line starting with `❯` can no longer pin a bogus session name — only the live (bottommost) prompt decides (808cce7)

## [0.13.0] - 2026-07-19

### Added
- Long-press a pane pill for a pane actions sheet — rename + two-tap close (5b50941, c713551, 90210ce, ea20df0)
- Pane rename end-to-end: `pane.rename` RPC, bridge route, label threading (99c8808)
- Tab rename + tab close (blast-radius confirm) via the same long-press sheet on tab chips (a9664b5, 37a470e)
- Claude's own `/rename` session name surfaced on cards, headers, and the switcher (d22fdd7)
- Read-only "Draft in terminal" preview with explicit Take over — the composer input is exclusively phone-owned (4b6f0ac, 10fa28d)
- Self-update without the service worker: `X-Collie-Build` on polled responses, auto-reload or tap-to-update banner (8d13622)
- Instant offline navigation — during a known outage, routes serve the last good snapshot instead of hanging on a dead fetch (b756edd)
- Busy strip on genuinely hung loads: navigations >500ms, background polls >6s (e886541, 3bfaa1c, 06516c4)
- `-dev` marker in the build stamp for non-release builds (3e785f4)

### Changed
- One shared `AppHeader` for dashboard, space, and pane — same components underneath, stale status badges dim during outages (29432c2)
- Connection status is a single animated top bar — amber "reconnecting…" after 4s of trouble, red with Retry at 15s, green flash on recovery; no header pill (394e6fe, b2dd50e)
- Switcher sections carry status-colored bullets; per-row close removed (switching is the only action there) (3918c69)
- `assets/*` served immutable, everything else `no-cache` — proxy caches can no longer starve `/sw.js` updates (8d13622)

### Fixed
- Own in-flight reply no longer flagged as a stranded terminal draft (e8462f9)
- Wrapped multi-line drafts and the new background-agents footer no longer break input-box detection (829fc7e, d9521e3)
- `navigator.onLine` never gates polling or liveness — lying flags can't wedge the app or fake outages (d31ffb8, 394e6fe)
- One shared connection-lost clock; escalation survives route changes and app switches until a poll succeeds (1486e07, 5949885)
- Sustained outages escalate everywhere — boot splash, header, banner — with Retry/Reload (0cbbac1, 4d89588, 4494cf5)
- Gallop sprite re-centered; the dog never freezes mid-stride (rest state is the static icon) (3c7174a, 394e6fe)
- Offline banner no longer overlaps the sticky header (bf98a88)

## [0.12.0] - 2026-07-17

### Added
- `COLLIE_SKIP_SERVE=1` env var to disable tailscale serve entirely — bridge stays on loopback only, ideal for deployments behind a reverse proxy (Caddy, Nginx, etc.) — thanks @diogenesc (ad5833a)
- `COLLIE_PUBLIC_URL` — `collie-ctl.sh status` banner shows your real reverse-proxy URL instead of a placeholder (4b043be)
- Bridge startup warning when `COLLIE_TRUSTED_USER` is set under `COLLIE_SKIP_SERVE=1` — the identity gate is inert without tailscale serve injecting `Tailscale-User-Login`; use `COLLIE_DEVICE_HEADER` (4b043be)
- README Variant C — reverse proxy as the only front door (no Tailscale), with Caddy example and required env (76019f7)

### Changed
- `collie-ctl.sh unserve`/`uninstall` always attempt serve teardown, even under `COLLIE_SKIP_SERVE=1` — a stale mapping from before the flag flip would keep publishing the app (4b043be)
- Security posture docs: "tailscale serve is the sole ingress" → "exactly one hardened front door" (tailscale serve or a conforming reverse proxy) across README, ARCHITECTURE, CLAUDE.md (76019f7)

## [0.11.1] - 2026-07-16

### Fixed
- Opening a tab/pane lands on the live tail — terminal `<pre>` no longer steals vertical scroll from the message list; stickiness also re-pins when content grows (04bf6fc)

## [0.11.0] - 2026-07-15

### Added
- Pluggable harness-adapter architecture: a `HarnessAdapter` registry replaces the single Claude-only gate, Claude's detectors move to `lib/harness/claude/`, and a core race-guard engine (`lib/harness/guard.ts`) is the only module that may touch the network — an import fence (enforced by `fence.test.ts` under `bun run test`) + a conformance suite let contributors add codex/pi/opencode (see `HARNESS_CONTRIBUTING.md`)
- multiSelect AskUserQuestion support: checkbox options up-level to tappable checkbox rows (terminal is source of truth), with a closed-loop Submit that navigates the pointer to Submit and verifies before Enter (never blind-sends), plus the review/confirm screen
- Prompt overlay: interactive prompts render in a bordered `bg-card` panel that lifts the whole dialog off the terminal mirror, with elevated option rows, leading key-digit badges, and a family-aware caption
- Update notifications: a footer banner (linking to the GitHub release) and an opt-out web-push when a newer release is published upstream or the running bridge is behind the on-disk code — checks the repo's tags over anonymous HTTPS, stamps its own sources for the restart signal, a Settings "check for updates" button forces an immediate check, an `updates` notify pref is the off-switch, and update/restart are surfaced as location-independent Herdr plugin actions

### Changed
- Keys and Quick menus dock in-flow above the controls row instead of a fixed overlay, so the terminal mirror shrinks and re-pins to the bottom (ResizeObserver) — the prompt/cursor stays visible; both buttons are toggles
- Prompt option rows compacted (tighter padding, snug line-height) so a multi-option dialog fits the phone viewport
- "Sent" status toast moved from a bottom overlay (which covered the terminal tail) to a slim in-flow row below the header
- Build stamp marks a dirty working tree (`<sha>-dirty`), so the footer no longer claims HEAD when the build carries uncommitted work
- multiSelect Submit is ~2s instead of ~15s: the pointer walk re-reads the actual position each step and stops on "Submit", instead of polling for the bottom row after every key (which timed out ~2.8s per step)

### Fixed
- Prompt-select + wizard grammars: a numbered list in a dialog body (e.g. a plan's steps) no longer breaks menu detection — the menu is taken as the trailing `1..m` run, so plan-approval prompts up-level correctly

## [0.10.3] - 2026-07-12

### Fixed
- `collie-ctl.sh build` installs the root dependency tree (not just `web/`) before typechecking, so a fresh Herdr install no longer fails with TS2688 "Cannot find type definition file for 'bun'" (03f409f, #9)

## [0.10.2] - 2026-07-12

### Fixed
- Composer Send clears a stranded draft off the terminal `❯` line (ctrl+k + Backspace) before typing so replies no longer accumulate on the prompt; a clean prompt skips the clear (cd1cc25)
- Bridge settles ~350ms between typing and Enter so the TUI reliably accepts the submit key (cd1cc25)

## [0.10.1] - 2026-07-11

### Fixed
- Terminal mirror defaults to no-wrap for table alignment like desktop Herdr; clearer borders/typography (font 12, muted-foreground box-drawing); pane stays viewport-width — toggle Wrap on in View for prose (85f777b)

## [0.10.0] - 2026-07-10

### Added
- Herdr session switcher: one bridge fronts every named herdr session — `?session=` on the API, `?s=` in the app, a sessions summary in the snapshot, per-session notification slots, and a `COLLIE_MULTI_SESSION` kill-switch (8fa1f20)
- Space detail is a deep-linkable route (`/space/:spaceId`) with a working browser Back button, replacing the in-home drill-in state (0e5f9c8)
- Terminal-draft recovery: a queued-then-recalled message stranded on the "❯" input line surfaces as a composer chip, with "Edit here" to clear the line and adopt the text cleanly (46dcf35)

### Changed
- Dashboard leads with "Needs you" — agents awaiting your input sit at the top, above the spaces overview (1d92592)
- Dashboard, space, and settings scroll inside a viewport-clipped region instead of the whole document (2aa9272)
- Session switcher and the session chip are dashboard-only, keeping the in-space and pane headers clean (bb0048d, ba56ba9)
- Header polish: consistent compact height across the dashboard and inside a space, zinc-800 nav chrome, a ringed Collie mark, a smaller pane-header agent logo, and the keyboard-only quick-keys strip removed (6250e0c, 9da7195, 35db0e5, ba56ba9)
- Security posture documents that `COLLIE_MULTI_SESSION` (default on) fronts every named session under the config root (fcb0b7d)

### Fixed
- Deep-linking a space that never existed shows "Space not found" rather than "Space closed" (fcb0b7d)

## [0.9.1] - 2026-07-09

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (2dc6995)
- Removed one-tap yes/no reply buttons from push notifications — they POSTed to the terminal without opening the app, i.e. approving blind. Notifications now only deep-link to the pane (cb26ee0)

## [0.9.0] - 2026-07-07

### Changed
- Quick keys mimic a physical keyboard on both surfaces: Esc top-left, Tab below it, inverted-T arrows, Enter top-right; Keys sheet gains a full-width spacebar (2f70662)
- Attach image lives in the reply row (usable without the phone keyboard open); digits leave the inline strip — the 123 tab remains (2f70662)
- Header collie logo is transparent like the gallop sprite — removed favicon.svg's baked-in gray backing rect (3f05da8)

## [0.8.0] - 2026-07-07

### Added
- Poll herdr 0.7.2's `session.snapshot` — one RPC per tick instead of three list calls; permanent fallback to the list trio on older servers (5687bbf)
- Event-poked polling: `events.subscribe` stream triggers immediate debounced re-polls; interval relaxes to `COLLIE_POLL_IDLE_MS` (default 12s) while the stream is healthy (5687bbf)

### Changed
- HERDR_API.md re-verified against herdr 0.7.2 / protocol 16; terminal observe/control filed under ARCHITECTURE.md Future ideas (aad94b3)

## [0.7.0] - 2026-07-06

### Added
- Notification type prefs: Settings "Notify when" toggles per agent status, bridge-wide; default pushes only "Needs input" (blocked) — "Finished" (done) is off (98cf5d2)

### Changed
- Push sends carry a `collie-herd` topic + 6h TTL: an offline device now gets one current summary on reconnect instead of replaying every queued update (98cf5d2)
- Disabling a notification kind retracts its pending/outstanding alerts immediately (98cf5d2)

## [0.6.0] - 2026-07-06

### Added
- First-paint PWA splash: the galloping collie shows before React mounts (299f632)
- Keys sheet: `Ctrl` modifier + visible key queue — compose chords/sequences, review, Send as one call; dialer-size digits on a `123` tab (515f795)

### Changed
- Header Collie mark matches the agent logo (2rem, aligned across screens); Find lives in the composer View row; placeholder is just "Type a reply…" (11385ee)

### Fixed
- Option taps no longer pop the phone keyboard or steal the note editor's focus (11385ee)
- Stalled connections no longer zombify the app: fetch timeouts (10s/20s/60s), polls supersede a wedged revalidation at 12s, and the collie gallops within 2.5s of a stalled load or pane-tap navigation (e6ad939)

## [0.5.0] - 2026-07-05

### Added
- **Preview-variant question notes.** Claude Code's *preview* AskUserQuestion — a single-select
  question whose options carry a `preview` field (the mockup/snippet pane, footer hint
  `n to add notes`) — is lifted into a native block that surfaces the per-question note affordance.
  A note (attach / edit / remove) is driven from the native option UI and applies **per question**,
  not per option row. Delivery uses the verified staged keystroke choreography
  (`n` → confirm the input focused → clear → paste the text via the reply path → `Escape` to blur,
  each stage verified rendered before the next fires; `Enter` is never sent, since it would submit
  the dialog — see `web/src/lib/grammar/NOTES_NOTES.md`), and option selection is the two-step
  digit → verify-pointer → `Enter` recipe. Race-guarded like the other dialog blocks (a stale tap on
  a drifted dialog aborts before anything irreversible is sent). Claude-scoped (`hasBlockGrammar`)
  and web-only; the standard non-preview select and wizard steps are unaffected (pressing `n` there
  is a no-op, so no notes UI is shown).

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (2dc6995)
- **Preview-note tap guard hardened to region-signature parity.** The preview dialog's race guard now
  carries a pointer- and note-independent **core signature** (the subject/question/stepper above the
  options joined with the option rows' left column, `❯` normalised) — matching the 0.4.0 `signature`
  parity the prompt/wizard guards already had. It is enforced at entry AND on **every** mid-flight
  acceptance/drift check, so a same-shaped successor dialog (identical question + labels, different
  subject) can no longer be answered by a stale tap: no digit-then-`Enter` or `Enter` is sent unless
  the fresh read's core signature byte-matches what the user saw. The blur poll is now three-valued
  (ok / drifted / timeout) so the Escape-retry fires only on a genuine swallowed key — never after the
  dialog drifted or vanished (which a blind second Escape could cancel / interrupt). Pasted note text
  is stripped of C0/C1 control bytes (ESC, BEL, …) before it can reach the focused input.

## [0.4.0] - 2026-07-05

### Added
- **Block-based terminal renderer.** Pane rendering now flows through a semantic Block AST (styled
  lines → typed blocks → React components) instead of a flat span mirror. The raw-block foundation is
  byte-for-byte identical to the old mirror, but it's the seam every feature below builds on —
  detected regions are lifted into native blocks in place, and anything unrecognized falls back to
  the raw mirror. Scoped to Claude Code (`hasBlockGrammar`); every other agent renders the plain
  mirror, since their TUIs are unverified.
- **Native prompt buttons.** A Claude single-choice dialog at the buffer tail (select, permission,
  trust, plan approval) is lifted out of the mirror and rendered as tappable buttons; a tap sends the
  per-family keystrokes (digit, or digit+Enter for AskUserQuestion), guarded so a stale tap on a
  scrolled-up menu can't fire. The agent's own input box/statusline are stripped so they don't
  duplicate the composer.
- **Status strip.** The stripped statusline (model · ctx% · cwd · branch · tokens) is re-surfaced as
  a slim line above the composer, so the branch/context stays visible instead of vanishing with the
  input-box chrome.
- **Submission progress bar.** A slim indeterminate bar across the top of the app while any mutation
  (reply, keys, prompt tap, upload, tab/space create, close, snooze) is in flight; background polling
  never triggers it, and a 120ms delay means a fast action never flashes it.
- **Raw-terminal escape hatch.** A View toggle (terminal icon) that turns off the block renderer —
  native prompt buttons, chrome stripping, status strip — and shows the plain mirror, so a
  mis-detected/mis-rendered dialog can always be driven by hand with the keys pad. Persisted.
- **Multi-question wizard.** A multi-question AskUserQuestion (the `☒ Focus area ☐ Scope ✔ Submit`
  stepper) now renders as a native step-by-step wizard instead of bailing to the raw mirror: the
  stepper chips (answered/current per question), the current question's options as tappable buttons
  (one digit each — verified: a wizard digit instant-selects and advances), back/next step
  navigation, and the final Submit review step (answers echoed, submit/cancel). Incremental
  round-trip: every tap is a single race-guarded keystroke re-derived against a fresh read; the TUI
  stays the source of truth. Choreography + fixtures documented in
  `web/src/lib/grammar/WIZARD_NOTES.md`.
- **Galloping Collie loader.** The mascot now doubles as the app's activity indicator: a 6-frame
  gallop sprite (`web/public/dog-gallop.png`, a 768×128 transparent strip) stepped through with a
  pure-CSS `steps(6)` animation (no JS timers). At rest it's the familiar static app icon
  (`favicon.svg`); it springs into the gallop on the boot splash while the first snapshot loads and
  whenever the connection isn't live (connecting / reconnecting / offline), settling back to the
  static icon once live. Honours `prefers-reduced-motion`. New `DogGallop` component; rough
  first-pass art to be replaced with higher-quality frames.

### Changed
- **One consistent top-left mark on every screen.** The Collie is now the brand + home button +
  connection loader in a single shared `CollieHome` component, rendered identically on the dashboard
  and inside a pane — so the header's top-left always means the same thing (previously a "stacks"
  icon inside a pane vs. the Collie logo on the dashboard). Inside a pane the Collie gallops on
  reconnect from the same global connection state as the dashboard (shared `isConnecting` predicate).

### Removed
- **The pane's Nav-hub drawer** (the left "stacks" drawer). It was redundant now that the Collie
  handles Home, the swipe-up switcher already covers pane switching/closing, and the breadcrumb
  covers cross-space jumps — removed along with its `SpaceList` component. The swipe-up switcher now
  appears whenever a pane is open, so even the last pane stays closable.

### Fixed
- **Multi-question AskUserQuestion no longer mis-parsed.** A multi-step AskUserQuestion (the
  `☒ Focus area  ☐ Scope  ✔ Submit` stepper) was detected as a single-question select and answered
  with one digit+Enter — submitting a half-filled form. It's now recognized as a wizard and left as
  the raw mirror (drive it with the keys pad, or via the new escape hatch) rather than mis-sending.

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (2dc6995)
- **Prompt/wizard taps are guarded against same-shaped successor dialogs.** The tap race guard now
  compares a byte-signature of the whole dialog region — including the subject above the options (the
  diff/command being approved), not just the question and option labels. So a tap on a frozen mirror
  can no longer approve a *different* action that happens to render an identical-looking prompt (e.g.
  a second edit to the same file after the first was answered elsewhere). Herdr's `revision` is a
  stub, so this content signature is the load-bearing freshness check.

## [0.3.0] - 2026-07-03

A full-codebase review pass: four audit agents (backend, frontend, security, ops/product) swept the
tree; everything they found was verified, fixed, and the top feature gaps were built.

### Added
- **Reply from the notification.** Needs-you pushes now carry up to two quick-reply action buttons
  (agent-aware: codex gets `yes`/`no`, others `yes`/`continue`; bridge sends `quickReplies` in the
  payload). Tapping one POSTs the reply straight from the service worker and confirms with a silent
  "Sent ✓" — no app open needed. Body tap still deep-links as before.
- **Find in output.** A magnifier in the pane header opens a find bar: case-insensitive match over
  the visible buffer, match count, prev/next that cooperates with the scroll-freeze, highlights
  rendered through the same React-text-node path (XSS boundary untouched).
- **Load older scrollback.** A "load older" row at the top of the mirror grows the fetched window
  600 lines at a time (up to 5000; the bridge clamps reads at 10000), preserving your scroll
  position across the refetch.
- **Destructive-input confirm.** Replies matching a reviewed pattern list (`rm -rf`, `sudo`,
  `git push --force`, `dd if=`, `mkfs`, redirects to system paths, …) flip Send into a two-tap
  "Really send?" state for ~3s — same pattern the `/clear` palette action already used.
- **Audit log.** Every write action (reply, keys, upload, tab/workspace create, pane close) appends
  a single JSONL line — timestamp, action, pane, device, truncated params — to
  `<state-dir>/audit.log` (mode 0600). Audit failures never block the action itself.
- `COLLIE_PUBLIC_HOSTS` env var — an explicit Host-header allowlist. When set, requests addressed
  to any other Host are rejected before origin logic, defeating DNS rebinding. Strongly
  recommended (set it to your MagicDNS name); effectively mandatory with `COLLIE_SERVE_MODE=http`.
- Startup warnings when `COLLIE_TRUSTED_USER` or `COLLIE_PUBLIC_HOSTS` is unset — parity with the
  existing bind/allowlist warnings, since an empty trusted-user means any tailnet device has write
  access.
- Uploaded images are now swept after 48h (was: kept forever).

### Changed
- **Builds are gated.** `bun run build` (root) and `collie-ctl.sh build` now typecheck bridge and
  web before building, and build into `dist-staging` with an atomic swap — a failed build can no
  longer leave an empty `web/dist` serving 503s. The pre-push hook typechecks both sides too
  (`SKIP_TYPECHECK=1` to bypass once). Root tsconfig now enforces `noUnusedLocals/Parameters`.
- **Write requests without an `Origin` header are rejected** unless they arrive on loopback
  (browsers always send Origin on POST; curl-on-host keeps working).
- Idle lock is now timestamp-based: backgrounding/foregrounding the app no longer resets the
  countdown, and returning past the deadline locks immediately.
- The composer moved into its own `<Composer>` component; `agent-chat.tsx` slimmed by ~230 lines.
- A reply whose text lands but whose submit keystroke fails now reports "typed into the pane but
  not submitted — check the pane before resending" (and `textDelivered: true`) instead of a generic
  error that invited double-sends.
- systemd unit hardened (`NoNewPrivileges`, `PrivateTmp`) and made persistent
  (`StartLimitIntervalSec=0`, `RestartSec=5`) so a crash-loop can't leave the service permanently
  down while you're phone-only.
- Notification deep links URL-encode the pane id; sheets manage focus (focus in on open, restore on
  close, `aria-labelledby`); space status dots gained screen-reader text; pinch-zoom re-enabled
  (removed `maximum-scale=1`).

### Fixed
- **Socket leak on RPC timeout** — a stalled Herdr left the Unix-socket FD open on every timed-out
  request; under the 1.5s poll cadence this exhausted file descriptors and wedged the bridge. Every
  terminal path now closes the socket.
- **UTF-8 corruption across socket chunks** — multi-byte characters (box drawing, emoji) straddling
  a socket-read boundary rendered as `�`; replies are now stream-decoded.
- **Overlapping polls** — a slow Herdr let 1.5s ticks pile up 3-4 concurrent polls; a tick is now
  skipped while the previous poll is in flight.
- **Upload buffering** — a too-large upload was buffered fully into RAM before the 10MB check;
  oversized `Content-Length` is now rejected up front and `Bun.serve` caps request bodies at 12MB.
- Push subscription saves are serialized and written atomically (temp+rename); concurrent
  add/prune can no longer drop a subscription. State files are written 0600 in 0700 dirs.
- First PWA load no longer flashes an immediate reload (service-worker `controllerchange` on
  initial claim was treated as an update).
- A rotated VAPID key now unsubscribes the stale push subscription and re-subscribes fresh instead
  of silently dead-ending pushes.
- Superseded loader revalidations are aborted (`request.signal` threaded through); raw key presses
  debounce their revalidate (one refetch per burst instead of one per keystroke).
- Slash-command insert appends to the draft instead of overwriting it; tap-to-focus no longer
  collapses an active text selection (copying pane output works now).
- `envInt` config parsing rejects garbage and out-of-range values (negative poll/debounce
  intervals, invalid ports) with a warning instead of silently accepting them.
- Static-file path guard now checks the directory boundary (`dist` vs `dist-*`); `?lines=` is
  clamped; API/static responses carry `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; graceful shutdown drains in-flight requests.
- Pre-commit version guard now also covers `web/vite.config.ts`, `web/index.html`,
  `web/package.json`, `web/public/`, `systemd/`, and root `package.json`, and requires the new
  version to sort strictly above the old one.

## [0.2.0] - 2026-06-30

### Changed
- **Smarter push notifications.** A blocked/done alert is no longer fire-and-forget. Each one now
  waits a short **debounce window** (`COLLIE_NOTIFY_DELAY_MS`, default 30s) before it sends; an agent
  you clear at your desk within that window never reaches your phone. Alerts that *do* fire are
  **retracted** automatically once the agent resolves (or its pane closes), so handled work stops
  piling up on your lock screen. The service worker also **suppresses** the system notification when a
  Collie tab is already open and visible (the in-app status surfaces it instead).
- **Coalesced into one notification.** The whole herd shares a single notification slot: one agent
  shows the named, deep-linked alert; several collapse into a *"N agents need you"* digest (tap → the
  triage home) that updates in place as agents come and go, instead of stacking N separate alerts.

### Added
- **Do Not Disturb / snooze** (Settings → *Do not disturb*): pause all push for 30m / 1h / 4h, or
  resume early. Server-enforced and self-expiring, so it quiets every device — and it clears whatever
  is already on the lock screen the moment you snooze. The current deadline rides the snapshot, so it
  stays in sync across devices.
- `COLLIE_NOTIFY_DELAY_MS` env var — the push debounce window in ms (default `30000`; `0` notifies on
  the next tick with no debounce).
- `POST /api/notifications/snooze` — set/clear the global snooze (`{ snoozedUntil: number | null }`);
  the active deadline is reported on the snapshot as `notifications.snoozedUntil`.

## [0.1.0] - 2026-06-30

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

### Added
- **Mobile-first PWA** (Vite + React + TypeScript + Tailwind v4 + shadcn): a triage dashboard
  (Spaces overview + Needs-you / Working / Idle agent groups), a per-agent colored terminal mirror,
  an agent-aware slash-command palette (Claude Code, Codex, pi, opencode), a special-keys pad with
  inline arrows/Tab, per-agent brand icons, image upload, and animated view transitions. Installable,
  with an auto-updating service worker and a build-stamp footer.
- **Bun/TypeScript bridge** over Herdr's Unix socket: a polled live snapshot (adaptive cadence,
  gzip + `ETag`/`304`) plus reply / keys / upload endpoints, and space/tab/pane management (create
  shell panes, switch, kill) through a unified nav hub.
- **Runs as a `systemd --user` service** supervised independently of Herdr, with a `tailscale serve`
  launcher (`scripts/collie-ctl.sh`) and a thin Herdr plugin (`herdr.collie`) exposing
  start / stop / restart / status / url / version / update / uninstall actions. One-command update
  (pull → rebuild → restart → re-link) for the linked checkout.
- **Optional Web Push (VAPID) notifications** when an agent needs you, with a custom service-worker
  push handler that renders the real message and deep-links the tap to the agent's pane.
- **Security posture:** loopback-only bind, `tailscale serve` as the sole ingress (never `funnel`),
  a same-origin gate, an optional `COLLIE_TRUSTED_USER` identity check, optional per-device
  authorisation via a trusted upstream header, a strict CSP, and terminal output rendered as React
  text nodes (the XSS boundary).
