# 0105: the durable SDK is an npm package

- **Status:** Accepted
- **Date:** 2026-10-14
- **Shipped in:** 1.22.0
- **Amends in scope:** [ADR 0104](./0104-a-program-is-a-session.md), the line that it does not publish the SDK
- **Trail:** M55 spec 10 · `packages/durable-sdk/` (the package) · `scripts/sdk-build.ts` (`bun run sdk:build`) ·
  `scripts/sdk-pack-check.sh` and `scripts/sdk-pack-check.ts` (the pack check, a step of the `durable-example` CI
  job) · `examples/durable-member/` · `docs/durable-programs.md` ·
  [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) ·
  [ADR 0104](./0104-a-program-is-a-session.md)

## Context

The durable SDK lived in `examples/durable-member/sdk/`, and the example's README told a builder to copy the folder
into their program. A copy has no version, takes no fix, and cannot say which wire it speaks. Altan, 2026-10-14: "I
want the npm sdk. so we have to build this from this repo somehow."

M55 spec 03 had already split the SDK into a core with no runtime import, a Bun entry, a Node entry and a Pi entry,
in erasable TypeScript that Node 22.18 runs as it is. What was missing was a package around it.

## Decision

**The durable SDK is the npm package `@colliepwa/durable-sdk`, built from `packages/durable-sdk/` in this repo and
published by Altan alone.**

1. **The name.** `@colliepwa/durable-sdk`. It is written in one place, the package's `package.json`; a test reads the
   docs against it, so a rename is one edit there and a run of the tests. Altan confirms the scope before the first
   publish.
2. **The dist-tag.** Every version is published with `--tag experimental` until the wire leaves its experimental
   status. npm sets `latest` on a package's first publish and keeps one, so `latest` points at 0.1.0 today and carries
   no promise. The docs install `@colliepwa/durable-sdk@experimental` and never rely on `latest`. (amended 2026-10-28;
   the first text tied this to the exit in ADR 0104, which is withdrawn)
3. **One import.** The root import serves Node and Bun. `openCollie` picks the server at run time: on Bun the Bun
   server with the descendant check, elsewhere the `node:http` server, which cannot run that check and writes one line
   at start that says so. The two servers stay two files. `./bun` and `./node` force one, `./pi` is the Pi Durable
   entry, and `./core` is the wire without a transport.
4. **Peers, not dependencies.** The package has no runtime dependency. The Pi packages that `./pi` imports
   (`@earendil-works/pi-durable`, `pi-ai`, `chord`) are optional peer dependencies, `>=1.1.0 <2`, so a program that
   never imports `./pi` installs none of them, and one that does brings its own copy. Pi Durable keeps state in
   module-level maps, so a second copy would break it.
5. **Who publishes.** Altan, by hand, from his own account: `cd packages/durable-sdk` and
   `npm publish --access public --tag experimental`, after `bun run sdk:build`, `scripts/sdk-pack-check.sh`, a clean
   tree, and the version bumped in the package's `package.json` and `CHANGELOG.md`. CI holds no npm token and the
   release workflow does not publish. The pack check never publishes.
6. **Its own version.** The package follows semver apart from Collie's. `SDK_VERSION` is that version, written into
   the build from `package.json`, and `WIRE_VERSION` is the wire version it speaks.
7. **The repo imports the source.** The example and the parked Cloudflare example import `packages/durable-sdk/src`
   by relative path, so the tests need no build and no install of the package. In the repo the SDK's Pi imports
   resolve to the example's pinned install (the package's `tsconfig.json`), so the example and `./pi` load one copy.

## The exit

ADR 0104's exit was withdrawn on 2026-10-28, so nothing retires this package by a date or a condition. (amended
2026-10-28) Unpublishing is not the way out: npm allows it only in narrow cases, and a
program that pinned a version would break. So if the package is ever retired, Altan runs `npm deprecate @colliepwa/durable-sdk`
with a message that says the durable wire was withdrawn and points to the repo, and no new version is published. The
source moves with the durable code.

## Consequences

- A builder runs `npm install @colliepwa/durable-sdk@experimental` (or `bun add`) and imports one name, with types.
  No folder to copy.
- A release of Collie and a version of the SDK are two events. A change to the wire needs both: Collie accepts the
  previous wire version for one minor, and the SDK names the version it speaks.
- The package's name on npm outlives the experiment: a retirement deprecates it, it cannot remove it.
- Revisit this decision when the wire leaves its experimental status (the dist-tag rule then ends, and `latest` becomes the
  question), or if a second runtime needs a server of its own. (amended 2026-10-28)
- Wording, 2026-10-16: as of 1.22.0 the user-facing term for what this ADR and ADR 0104 call a program is "durable agent". The API channel, the code and these records keep the word program.
