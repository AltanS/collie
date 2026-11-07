# 0132: The math engines are a pack the host downloads

- **Status:** Accepted
- **Date:** 2026-11-07
- **Shipped in:** pending
- **Relates to:** [ADR 0096](./0096-speech-can-stay-on-the-phone.md) (the Whistle model, whose shape this
  copies: nothing downloads by itself, the host copies and verifies, the phone fetches from the host),
  [ADR 0052](./0052-one-build-serves-any-mount.md) (the engines are served under the mount like every
  other file).
- **Trail:** PR 634 (bsdz), whose payload carried `web/dist/math` (about 12 MB raw, 4 MB gzipped), and
  its thread: the contributor proposed trimming the MathJax font ranges to 16 or 18, keeping all of
  them, or shipping KaTeX only; Altan's reply of 2026-11-07 chose none of the three ("we don't want to
  add five megabytes to everyone downloading the setup. Same as the speech models.") · milestone M93 ·
  `.github/workflows/release.yml` · `scripts/math-pack.ts` · `scripts/build-windows-payload.ps1` ·
  `bridge/math/store.ts` · `bridge/math/http.ts` · `bridge/server.ts` (`/api/math`, `/math/*`) ·
  `web/src/components/math-control.tsx` · `web/src/lib/math-pack.ts` · `web/vite.math.ts` ·
  `web/src/lib/math/engine-files.ts`

## Context

PR 634 renders LaTeX in Chat, History and Markdown previews with KaTeX or MathJax, chosen per device in
Settings → Appearance → Math, Off by default. Off parses exactly as before, and the engines load lazily
from `web/dist/math/`, outside the precache. So a phone that never turns math on fetches nothing. The
cost is on the host: every install tarball and every update carries the engines, about 4 MB gzipped,
mostly MathJax's 41 font ranges. bsdz measured that a corpus of 2,947 real formulas needs 5 of them.

Three roads were on the table in the thread: trim the ranges to about 4 MB raw, keep them all, or ship
KaTeX alone at 0.75 MB. Each still puts megabytes into every install, for a feature most installs never
turn on. The Whistle speech model (ADR 0096) already answers the same question for 17 MB: it is not in
the release, the host downloads it on a tap, checks it, keeps it in its state folder and serves it.

## Decision

**1. The engines are one release asset, `collie-math-<version>.tar.gz`.** Both engines, all 41
MathJax ranges, as the build lays them out: every entry is under `math/`, the same paths as
`web/dist/math/**`. The trim is moot once nobody downloads the pack without asking for it. The release
job builds it from its own `web/dist`, as a ustar archive with sorted names, owner 0 and a fixed mtime,
and lists it in `collie-<version>.manifest.json` under `extras` with role `math-pack`, its `name`,
`size` and `sha256`, beside the `web-bundle`. It gets a `.sha256` sidecar like every asset.

**2. No install carries the engines.** Every payload (the four tarballs and the Windows zip) drops
`web/dist/math` after it copies `web/dist`, and `web-dist-<version>.tar.gz` excludes it. The release
job proves both before it publishes: it lists every payload and fails when one holds a file under
`web/dist/math/`.

**3. The engines are self-contained bundles, so the pack owes nothing to the app build (2026-11-08).**
Nothing under `math/` imports a file outside `math/`, and nothing under `math/<engine>/` imports a file
outside its own folder. Each engine is its own Vite build (`web/vite.math.ts`), run after the app build
into the same `dist/math/`: one ES entry `math/<engine>/<engine>.js`, its stylesheet
`math/<engine>/<engine>.css`, its fonts and (MathJax) its lazy font ranges, none with a hash in the name,
since the pack is keyed by the release version. The app holds no engine code and no chunk under `math/`:
it loads an engine by URL, `import()` of `<mount>/math/<engine>/<engine>.js`, links the stylesheet, and
calls the one export, `typeset(tex, display)`, which answers a hast tree or null
(`web/src/lib/math/engine-files.ts`, read by the loader, the engine build and the release check). Why:
the payloads build `web/dist` on their own runners and the pack comes from the release job's build. In
the first cut the engine chunks imported the app's entry chunk for shared helpers. Its hash moved with
the build stamp, and once the stamp was pinned to the commit time, the Windows runner still made another
entry chunk than Linux and macOS (run 2 of 1.28.0-edge.2). A release must not rest on two runners
building one app byte for byte, so the engines lean on nothing the app build makes, and the stamp reads
the clock again. `scripts/math-pack.ts check` fails the release when the pack lacks a file the loader
names, when a pack file imports outside its engine's folder or a file the pack lacks, when a payload's
`web/dist` holds engine code outside `math/` (a marker string of each engine, which must be in the
pack), or when it holds a `math/` that is not the pack byte for byte. A failure never reaches a phone as
formulas left as source.

**4. The trust is the release manifest of the running version, nothing new.** The host fetches
`https://github.com/<repo>/releases/download/v<version>/collie-<version>.manifest.json`, where `<repo>`
is `COLLIE_UPDATE_REPO` (default `AltanS/collie`), the manifest an update already trusts. It reads the
one `extras` entry with role `math-pack`, whose name must be exactly `collie-math-<version>.tar.gz`, and
builds the asset's URL from (repo, tag, name), never from a field of the document. No hash is pinned in
the source, because the pack's hash does not exist when the commit is made. The loopback rehearsal
mirror (`COLLIE_UPDATE_MIRROR`) is honoured exactly as the update check honours it, and it is the seam
the tests use.

**5. Only a tap downloads.** `POST /api/math`, on the write gate, from Settings. A GET reports and
fetches nothing, not even the manifest. A boot, an update and a page load download nothing. One
download runs at a time in the process; a second POST joins it.

**6. The host checks before it keeps anything.** The manifest is read up to 1 MB and no further. A
declared size above 64 MB is refused before the body. The body streams to `<stateDir>/math/collie-math-<version>.<pid>.<seq>.part`, created exclusively
at 0600, counted against both the 64 MB cap and the manifest's size, hashed as it arrives. A size or
hash that is not the manifest's keeps nothing. Then the archive is read IN THE PROCESS, never by a
spawned `tar`: Collie spawns no child for content (the security posture). Only regular files and
folders are taken; every name must be under `math/`, with no `..`, no absolute path, no backslash, no
empty segment and no Windows device name (`con`, `nul`, `com1`, …), at most 255 bytes and 8 segments
long; two names that differ only in case are refused, because they are one file on Windows and macOS;
a link, a device or any other entry refuses the whole pack. A pax record is read on its bytes, as the
format counts them. The archive inflates in one call that stops at the cap (64 MB of files and 4 MB
for the headers), so a gzip bomb costs at most the cap and never leaves a stream waiting; the entries
are capped at 4,096. The timeout covers the download, the inflate and the install. The files go to `<stateDir>/math/<version>.tmp-<pid>-<seq>/`
(folders 0700, files 0600) with a `pack.json` naming the hash, the size and the fetch time, and that
folder is renamed to `<stateDir>/math/<version>/` in one step. Other versions are then removed.

**7. `/math/*` is served from the store, else from the build, else 404.** The store's folder of the
running version first. Then `web/dist/math/` beside the build, which a source build has: `collie build`
builds the engines, and the bridge never writes under `web/dist`. Then 404, and never the app shell:
a missing engine is an error the engine loader turns into source text. The files have no hash
in their names, so they cannot be `immutable` (one name is another file in the next release): they
revalidate like the app shell, and the service worker's cache-first route for `/math/**`, emptied on
every activation, is unchanged.

**8. A development build never fetches a manifest.** A build stamped `-dev` (or a checkout with no
build stamp) has no release to read. It serves `web/dist/math/` when that folder is there and reports
`ready` from the build; otherwise it reports `unavailable` and offers no download.

**9. What fails, fails closed, and formulas stay source.** No manifest, a 404, or a manifest with no
`math-pack`: `unavailable`, reason `no-pack`, and the download is not offered again until the page
asks again. A network failure: `download-failed`. A size or hash that is not the manifest's, or an
archive entry that breaks a rule: `hash-mismatch` or `bad-pack`. A full disk: `low-space`. None of them
leaves a part file, a half folder or a broken page; Chat shows `$…$` as it was written.

**10. Lead-only, like Whistle.** The lead serves the web app, so the lead serves the pack. The routes
are not in the crew's FORWARDABLE list and read no `?host=`; a crew member answers them about its own
store, as it answers its own `/api/stt/whistle`.

**11. Choices the milestone left open.** Settings shows the pack's size as a constant from the build
("about 4 MB"), because a GET may not fetch the manifest to learn it; the progress line reads the real
total once the download has it. After an update, the new version's pack is absent until the next tap:
the operator's earlier tap is not taken as consent to fetch again. The old version's folder stays until
the next download or a remove, so a rollback finds its own pack. There is no cross-process lock: the
bridge is the only writer, there is no CLI verb, and each download writes a part file and a folder of
its own pid and sequence. Two bridges on one state dir stay out of each other's way: a part file or a
half folder of another pid is left alone until it is older than the timeout (10 minutes), and swept
after that at the start of the next download, which also sweeps this process's own leftovers from a
crash. A download that finds its version already installed by the other bridge keeps that copy.

## Trust

The sha256 comes from the manifest of the same release as the asset, so it proves the file arrived
whole, not where it came from: it guards against corruption and a wrong file, not against a release
that was itself altered. The root of trust is TLS to github.com, the same root `collie update` stands
on, and nothing here widens it. The engines then run in the app's origin, as any script of the build
does, so a pack that was altered would run with the page's rights. That is why the pack is fetched on
a tap, from the running version's own release, and never by a boot, an update or a name from the
document.

## Consequences

- An install and an update are about 4 MB smaller than with the engines inside, and a host that
  never turns math on never carries them.
- A device that chose KaTeX or MathJax on a host without the pack shows formulas as source until
  somebody taps the download. Settings says so, and shows Off as the choice while the host has no pack.
- After every update, someone taps once more. If that proves a chore, the next road is for
  `collie update` to fetch the new pack when the old version had one, through the same manifest; that
  is a change to the update, not to this contract.
- On Windows, a `<stateDir>/math/` tree holds subfolders, so a state folder that is neither a default
  location nor made by this run is no longer "plainly Collie's" under the one-level rule in
  `bridge/acl-policy.ts`: start-up checks its access list and warns instead of repairing it. The
  default locations are unaffected.
- A release whose pack lacks an engine file, imports outside an engine's folder, or whose payload carries
  engine code does not publish. That is the point of the check, and the fix is a rebuild, not a waiver.
- Revisit if a second optional download arrives: two packs make a generic "extras the host downloads"
  module worth writing, and one does not.

## Rejected

- **Ship the engines in the payload, trimmed or whole, or ship KaTeX alone.** Each puts megabytes into
  every install for a feature that is off by default. This is the decision of the thread.
- **Let the phone download from GitHub.** The CSP is `connect-src 'self'`, the phone has no manifest
  to check against, and the host is the one place that can verify once for every device.
- **A hash pinned in the source, as Whistle pins its model.** The pack is built at release time, so no
  commit can know its hash. The release manifest is the release's own statement, and `collie update`
  already stakes the whole install on it.
- **Extract with `tar`.** The bridge spawns no child for content; an in-process reader of a few dozen
  lines also refuses links and odd entries by construction instead of by flags.
