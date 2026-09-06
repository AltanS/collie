# 0035 — A package manager owns the install it can write, and Collie declines to update it

Status: **Accepted** (2026-09-05)

## Context

Collie had three install shapes and every one of them updated itself: a linked clone, a
Herdr-managed detached checkout, and a binary install under a `versions/` layout. A fourth shape
exists on real machines and had no name — Collie laid down by an operating system's package manager,
under a root the running user cannot write.

That shape arrives with Omarchy, where **Herdr itself already ships as a pacman package** from
Omarchy's own repository. Collie is Herdr's companion application and currently reaches the same
machines through a different channel, `herdr plugin install`, which fetches source and compiles it
with Bun ([#169](https://github.com/AltanS/collie/issues/169)). Packaging Collie the way Herdr is
packaged closes that gap, and every release already publishes the compiled per-platform payload a
package needs.

Before this record, such an install fell out of `classifyInstall` as `{kind: "unknown", why:
"loose-binary"}`. `collie update` then refused with *cannot tell how this Collie was installed*, and
`doctor` warned about an unrecognisable tree. Both were the right instinct — Collie genuinely must
not update that install — expressed as a diagnosis failure. An operator whose package manager was
working perfectly was told their install was broken.

Two roads were open, and both will be proposed again.

**A marker file.** The obvious instinct is for the package to write something — `/usr/lib/collie/.packaged`, a
line in the manifest, an environment variable in the unit. `cli/install-kind.ts` already argues
against this for every other kind, in its own header: a marker is a fact that can be copied, stale
or absent while the tree around it says otherwise. A marker would also have to be produced by each
packager independently — pacman, Homebrew, apt, nix — so the detection would only ever be as good as
the least careful of them, and an unmarked package would land back on the `unknown` path this record
exists to remove.

**Reading permissions earlier.** Equally tempting is to ask about writability first, as the primary
question. That reclassifies working installs on a permissions change: a root-owned clone is still a
clone, and a root-owned `versions/` layout is still a binary install, whatever `chown` last did to
them.

## Decision

**An install root the running user cannot write is a `system-package` install, and Collie never
updates it.** The predicate is exactly that — `access(root, W_OK)` — and it is a shape on disk in
the same sense as a `.git` directory or a `versions/` parent, so the structural rule the module
already holds itself to is unbroken.

**Writability is asked LAST, and only where nothing else claimed the tree.** It is the weakest signal
here because it describes permissions rather than layout. A git checkout stays a checkout and a
binary layout stays a binary install, whoever owns the files. The new kind takes over the one branch
that previously ended in `loose-binary` — a Collie we could not name — and names it.

**The marker still outranks writability.** A root with no `herdr-plugin.toml` remains
`unknown`/`no-marker` however unwritable it is: `/usr/lib/something-else` is not a Collie whose
updates belong to pacman, it is a directory that is not a Collie, and claiming it would make `collie
update` explain package management to someone who ran it in the wrong place.

**Declining is a boundary, not a diagnosis failure.** `collie update` names who owns the update and
stops. `doctor` reports the install as healthy. The preflight drops the checks that only mean
something to an install that updates itself — Bun, the working tree, the staging disk floor — and
adds one line saying why they are absent.

**Collie names no package manager as the answer.** It can see that its root is unwritable, which is
what makes the update someone else's; nothing on disk says whose. Messages name `pacman` and `brew`
as examples and never as the instruction.

## Consequences

- **A `system-package` install cannot self-update, by construction, and that is the feature.** The
  recovery path is the operator's own package manager, which is signed, versioned and reversible —
  strictly stronger than anything Collie was going to do to itself.
- **ADR 0006 is untouched.** Its subject is the Herdr-managed checkout: `update` still advances that
  shape in place, still never re-links it, and reinstall is still its floor. This record adds a kind
  beside it rather than changing it. In particular, the re-link prohibition does not reach a package:
  `herdr plugin link /usr/lib/collie` is how a packaged tree is registered, and the concern that
  motivated the prohibition — losing `herdr plugin install` as the only remaining refresh — does not
  apply where `pacman -S collie` is the refresh.
- **The bun preflight still fires on a `herdr plugin install`.** That install is a git checkout and
  it genuinely does rebuild, so the check remains true there. Issue #169's second proposal — the
  plugin channel taking the published payload instead of compiling — is the change that retires it,
  and it is deliberately not this record's subject.
- **A packaged install needs the shim the manifest names.** Every `[[actions]]` command is frozen as
  `bash scripts/collie-ctl.sh <verb>` (ADR 0006), and the release payload did not carry
  `scripts/` — so a package built from it would have installed Herdr action buttons that could not
  resolve. The release workflow now ships that one file.
- **`root` is resolved through a symlink, so the PATH name must stay a pointer.** `/usr/bin/collie`
  symlinks into `/usr/lib/collie/bin/collie`; because `process.execPath` is realpath-resolved the
  plugin root comes out as `/usr/lib/collie`, where the manifest is. Installing the binary directly
  at `/usr/bin/collie` would resolve the root to `/usr` and the bridge would find neither `web/dist`
  nor the manifest. This is ADR 0021's rule arriving from a different direction.
- **Registration is a manual second step.** A root post-install hook cannot sensibly write a per-user
  Herdr registry, so the operator runs `herdr plugin link /usr/lib/collie` once.

### What would justify revisiting

- **Herdr scans a system plugin directory** — `/usr/share/herdr/plugins/*/herdr-plugin.toml` or
  similar. A packaged plugin would then be discovered with no user action, and the manual link step
  above would retire. This is the upstream ask that makes packaged plugins first-class, and it sits
  beside the refresh-verb request ADR 0006 already filed.
- **A packager that installs into a root the operator CAN write** — a per-user Homebrew prefix is the
  realistic case. The predicate would call that install writable and fall back to `loose-binary`,
  which is wrong but safe: it refuses to update rather than updating something it should not. If such
  installs become common, the predicate needs a second signal, and this is the record to amend.
- **Evidence that an operator genuinely wants a system install to update itself.** Today that is read
  as a contradiction: the thing that makes it a system install is that this process cannot write it.
