# 0035 — A root-owned install is not ours to update, and we do not claim who owns it

Status: **Accepted** (2026-09-05)

## Context

Collie had three install shapes and every one of them updated itself: a linked clone, a
Herdr-managed detached checkout, and a binary install under a `versions/` layout. A fourth exists on
real machines and had no name — Collie sitting in a directory owned by root, put there by a distro
package or unpacked as root by hand.

That shape arrives with Omarchy, where **Herdr itself already ships as a pacman package** from
Omarchy's own repository. Collie is Herdr's companion application and currently reaches the same
machines through a different channel, `herdr plugin install`, which fetches source and compiles it
with Bun ([#169](https://github.com/AltanS/collie/issues/169)).

Before this record, such an install fell out of `classifyInstall` as `{kind: "unknown", why:
"loose-binary"}`. `collie update` refused with *cannot tell how this Collie was installed*, and
`doctor` warned about an unrecognisable tree. Both were the right instinct expressed as a diagnosis
failure: an operator whose install was working perfectly was told it was broken.

Three roads were open. Two were tried and rejected during review, which is why they are recorded
here rather than argued again.

**A marker file.** The obvious instinct is for the package to write something — a dotfile, a line in
the manifest, an environment variable in the unit. `cli/install-kind.ts` already argues against this
for every other kind, in its own header: a marker is a fact that can be copied, stale or absent
while the tree around it says otherwise. It would also have to be produced by each packager
independently, so the detection would only ever be as good as the least careful of them.

**Writability.** The first implementation asked `access(root, W_OK)`: an install this process cannot
write is one it cannot update. It reads well and it is wrong, because **`access(2)` is always true
for uid 0**. `collie update` and `sudo collie update` would report the same tree as two different
kinds, and the sudo spelling landed on the very *cannot tell how this Collie was installed* the kind
was added to delete. A bridge running as root — an ordinary container — would never see the kind at
all. The predicate has to be a fact about the tree, not about who typed the command.

## Decision

**A root whose owner is uid 0 is a `system-owned` install, and Collie never updates it in place.**
The predicate is `stat(root).uid === 0`. Ownership is a shape on disk in the same sense as a `.git`
directory or a `versions/` parent, so the structural rule the module holds itself to is unbroken,
and the answer does not move when the caller does.

**Ownership is asked LAST, and only where nothing else claimed the tree.** It is the weakest signal
here, because it describes administration rather than layout. A git checkout stays a checkout and a
binary layout stays a binary install whoever owns the files. The new kind takes over the one branch
that previously ended in `loose-binary`.

**The marker still outranks it.** A root with no `herdr-plugin.toml` remains `unknown`/`no-marker`
however it is owned: that is a directory that is not a Collie, and claiming it would make `collie
update` explain package management to someone who ran it in the wrong place. An unreadable owner
(`null`) is likewise not system-owned — nothing could be read, so nothing may be asserted.

**Collie states the ownership and never asserts the provenance.** This is the second correction, and
it is the one with teeth. Root ownership is observable; *that a package manager put it there* is an
inference, and a tarball unpacked as root is indistinguishable from a packaged install. The first
draft of this record said "was installed by a package manager, which owns its updates" — which sends
an operator who unpacked it themselves after a package that does not exist, while the real remedy
(reinstall the same way, or take ownership) goes unmentioned. So every message names the fact and
offers both ways out, and none names a manager as *the* command. One exported constant,
`SYSTEM_OWNED_REMEDY`, is the single spelling.

**Declining is a boundary, not a diagnosis failure.** `collie update` says what is true and stops.
`doctor` reports the install as healthy — and its neighbouring checks were taught the kind too, so
`versions` no longer promises a staging that will never happen and `update-source` no longer names a
GitHub repository this install never fetches from. The preflight drops the checks that only mean
something to an install that updates itself and adds one line saying why they are absent.

**The refusal lives on the server, not only in the client.** A system-owned install's preflight is
green by design, so nothing in the existing `POST /api/update` gate would stop a start: the phone's
disabled button is a courtesy, as that route says of itself. The verdict refuses the kind directly.
It sits **below** the peers-only branch, because a lead that cannot move itself can still level its
peers, and that is a different act.

## Consequences

- **A `system-owned` install cannot self-update, by construction, and that is the feature.** The
  recovery path is whatever installed it, which for a package manager is signed, versioned and
  reversible — strictly stronger than anything Collie was going to do to itself.
- **`sudo` changes nothing.** That is the whole point of choosing ownership. `sudo collie doctor`
  and `collie doctor` agree about what this install is, and a root-run bridge sees the kind.
- **The predicate is POSIX-only, and win32 is read as "no answer" rather than "root".** Windows has
  no uid, and Node/Bun's `stat().uid` reports a constant `0` there regardless of who owns the file —
  colliding that with uid 0 meaning root would misclassify an ordinary win32 install as system-owned
  the moment this shipped. `realFiles.ownerUid` returns `null` on `process.platform === "win32"`
  before it ever calls `stat`, which reads as `loose-binary`, the same fallback a failed `stat`
  already gets. A real win32 answer needs its own signal — the ACL, not a POSIX uid that platform
  does not have — and is out of scope here.
- **Refusing a root-owned tree we could have written is deliberate.** Running as root, Collie *could*
  replace the files. It must not: overwriting a package manager's files leaves its database lying
  about what is installed.
- **ADR 0006 is untouched.** Its subject is the Herdr-managed checkout, which still advances in
  place, is still never re-linked, and still has reinstall as its floor. A root-owned tree is a kind
  beside it. The re-link prohibition does not reach it either: the concern was losing `herdr plugin
  install` as the only remaining refresh, and a package manager is a stronger refresh than the one it
  was protecting.
- **The bun preflight still fires on a `herdr plugin install`.** That install is a git checkout that
  genuinely rebuilds, so the check is true there. #169's second proposal is what retires it, and it
  is not this record's subject.
- **A packaged install needs the shim the manifest names.** Every `[[actions]]` command is frozen as
  `bash scripts/collie-ctl.sh <verb>` (ADR 0006), and the release payload did not carry `scripts/`,
  so a package built from it would have installed Herdr action buttons that could not resolve. The
  release workflow now ships that one file.
- **`root` is resolved through a symlink, so the PATH name must stay a pointer.** `/usr/bin/collie`
  symlinks into `/usr/lib/collie/bin/collie`; because `process.execPath` is realpath-resolved the
  plugin root comes out as `/usr/lib/collie`, where the manifest is. Installing the binary directly
  at `/usr/bin/collie` would resolve the root to `/usr`. This is ADR 0021's rule arriving from a
  different direction.
- **Registration is a manual second step.** A root post-install hook cannot sensibly write a per-user
  Herdr registry, so the operator runs `herdr plugin link /usr/lib/collie` once.

### What would justify revisiting

- **Herdr scans a system plugin directory** — `/usr/share/herdr/plugins/*/herdr-plugin.toml` or
  similar. A packaged plugin would then be discovered with no user action, retiring the manual link.
  This is the upstream ask that makes packaged plugins first-class, and it sits beside the
  refresh-verb request ADR 0006 already filed.
- **A packager that installs into a root the operator owns** — a per-user Homebrew prefix is the
  realistic case. The predicate calls that install user-owned and falls back to `loose-binary`, which
  is wrong but safe: it refuses to update rather than updating something it should not. If such
  installs become common, the predicate needs a second signal, and this is the record to amend.
- **A single-user machine where everything is root-owned.** Such a tree is claimed by this kind and
  told to reinstall the way it arrived, which is true but unhelpful. Nothing observed yet; a location
  test (`/usr`, `/opt`) is the obvious second signal, and it was left out deliberately because it
  would not have separated the two cases that actually motivated the wording fix.
- **Evidence that an operator genuinely wants a root-owned install to update itself.** Today that is
  read as a contradiction, and running as root to grant it is exactly the case the second consequence
  above refuses.
