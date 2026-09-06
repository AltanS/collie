# 0035 — A packaged install is not ours to update

Status: **Accepted** (2026-09-06)

## Context

Collie had three install shapes and every one of them updated itself: a linked clone, a
Herdr-managed detached checkout, and a binary install under a `versions/` layout. A fourth exists on
real machines and had no name — Collie in a folder a **package manager** installed and keeps
current.

That shape arrives with Omarchy, where **Herdr itself already ships as a pacman package** from
Omarchy's own repository. Collie is Herdr's companion application and currently reaches the same
machines through a different channel, `herdr plugin install`, which fetches source and compiles it
with Bun ([#169](https://github.com/AltanS/collie/issues/169)).

Before this record, such an install fell out of `classifyInstall` as `{kind: "unknown", why:
"loose-binary"}`. `collie update` refused with *cannot tell how this Collie was installed*, and
`doctor` warned about an unrecognisable tree. Both were the right instinct expressed as a diagnosis
failure: an operator whose install was working perfectly was told it was broken.

Three roads were open. Two were tried and rejected, which is why they are recorded here rather than
argued again.

**A marker file the packager writes.** The obvious instinct is for the package to leave something —
a dotfile, a line in the manifest, an environment variable in the unit. `cli/install-kind.ts`
already argues against this for every other kind, in its own header: a marker is a fact that can be
copied, stale or absent while the tree around it says otherwise. It would also have to be produced
by each packager independently, so the detection would only ever be as good as the least careful of
them.

**One fact instead of three.** Two single-fact predicates were tried and each misses a real
packager. `access(root, W_OK)` alone misses **Homebrew**, which installs into `/opt/homebrew`, a
directory the operator can write. `stat(root).uid === 0` alone misses Homebrew too, and misses a
per-user Nix profile; worse, `access(2)` is always true for uid 0, so a bridge running as root reads
its own packaged root as writable and would see nothing. Neither fact is wrong. Neither is enough
alone.

## Decision

**A `packaged` install is decided by four clauses, and all four must hold.** A candidate is
`packaged` when:

1. there is **no `.git`** — a checkout is never packaged;
2. there is **no `versions/` layout** — a downloaded install is never packaged;
3. the **marker is present** (`herdr-plugin.toml` at the root); and
4. the root is **read-only**, **outside `$HOME`**, or **owned by uid 0**.

**Clause 4 is a disjunction of three probed facts, and each covers a packager the others miss.**
Read-only covers the **Nix store**, which is mounted read-only. Outside-`$HOME` covers **Homebrew**,
whose prefix the operator can write and still does not own. Root ownership covers a tree unpacked as
root inside `$HOME`, and the same tree probed **as root**, where `access(2)` lies. Each is a shape
on disk in the same sense as a `.git` directory, so the module's structural rule is unbroken.

**Clause 4 is asked LAST, and only where nothing else claimed the tree.** All three of its facts are
weaker than layout: a git checkout stays a checkout and a binary layout stays a binary install
whoever owns the files and wherever they sit. The new kind takes over the one branch that previously
ended in `loose-binary`.

**A writable, user-owned marker tree inside `$HOME` stays `loose-binary`.** That is the closed
direction: Collie declines to update what it cannot describe rather than claiming a package manager
that may not exist.

**The marker outranks clause 4.** A root with no `herdr-plugin.toml` remains `unknown`/`no-marker`
however it is owned: that is a directory that is not a Collie, and claiming it would make `collie
update` explain package management to someone who ran it in the wrong place. This is the one place a
marker picks a kind, and the amendment is deliberate — `herdr-plugin.toml` is not written by an
installer, it ships inside the release tarball every package wraps, so it is still a shape on disk.

**No path prefix is ever evidence.** `/usr/lib/collie`, `/nix/store` and `/opt/homebrew` appear in
`cli/install-kind.ts` exactly once, in `packageCommand`, and only to **name a command** after the
kind has already been decided. A prefix nobody recognises costs the operator a command, never a
wrong kind. Where no command can be named, every surface prints the boundary and stops rather than
guessing a manager and sending the operator after a package that does not exist.

**Declining is a boundary, not a diagnosis failure.** `collie update` says what is true and stops.
`doctor` reports the install as healthy, naming the kind, the resolved prefix and the PATH symlink
pointing into it — and its neighbouring checks were taught the kind too, so `versions` no longer
promises a staging that will never happen and `update-source` no longer names a GitHub repository
this install never fetches from. The preflight drops the checks that only mean something to an
install that updates itself and adds one `package` line.

**A remedy is a command, never prose.** `upstreamCheck` still reports that a newer release exists,
because that is true and useful. Its remedy, where it named `collie update`, becomes the package
manager's command or is **cleared**. The check marks its own remedy with `selfUpdateRemedy` at the
point it produces it; a substring test on the prose was tried first and would stop working silently
the day the sentence is reworded.

**The refusal lives on the server, not only in the client.** A packaged install's preflight is green
by design, so nothing in the existing `POST /api/update` gate would stop a start: the phone's absent
button is a courtesy, as that route says of itself. The verdict refuses the kind directly. It sits
**below** the peers-only branch, because a lead that cannot move itself can still level its peers,
and that is a different act.

**The pack branches on the KIND, never on a check id.** `PreflightMember` carries `installKind`, and
`cli/pack-update.ts` skips a member because it is `packaged`. A check id labels a sentence; matching
on one would make a rename of a green line silently un-skip a packaged peer, with a `git bundle`
pushed into a package manager's folder as the first symptom. A member that names no kind — one older
than the field — is not packaged, exactly as before.

**The layout is one folder plus one symlink.** The package installs the whole release payload under
one prefix and puts a `collie` on `$PATH` as a symlink into it. Because `process.execPath` is
realpath-resolved and `bridge/root.ts` accepts a candidate only when it carries `herdr-plugin.toml`,
`/usr/bin/collie -> /usr/lib/collie/bin/collie` resolves the root to `/usr/lib/collie` with **no
code change**. This is ADR 0021's pointer rule arriving from a different direction, with the package
manager owning the pointer instead of `collie link`.

**A package is not a Herdr plugin.** There is no `herdr plugin link`, no registration and no action
set. The plugin path's buttons update the checkout, and this tree is the package manager's to
update. `refreshRegistry` is unreachable from this kind.

## Consequences

- **A `packaged` install cannot self-update, by construction, and that is the feature.** The
  recovery path is the package manager, which is signed, versioned and reversible — strictly
  stronger than anything Collie was going to do to itself.
- **`sudo` changes nothing.** Ownership and location do not move when the caller does, and the
  read-only probe answering `null` reads as "not read-only" rather than as an answer. `sudo collie
  doctor` and `collie doctor` agree about what this install is.
- **The root-ownership disjunct is POSIX-only, and win32 reads as "no answer" rather than "root".**
  Node/Bun's `stat().uid` reports a constant `0` on win32 regardless of who owns the file.
  `realFiles.ownerUid` returns `null` there before it ever calls `stat`. A win32 install is claimed
  by clause 4 only if it is read-only or outside `$HOME`, both of which are real facts on that
  platform.
- **Refusing a tree we could have written is deliberate.** Running as root, Collie *could* replace
  the files. It must not: overwriting a package manager's files leaves its database lying about what
  is installed.
- **ADR 0006 is untouched.** Its subject is the Herdr-managed checkout, which still advances in
  place, is still never re-linked, and still has reinstall as its floor. A packaged tree is a kind
  beside it, and the re-link prohibition does not reach it: the concern was losing `herdr plugin
  install` as the only remaining refresh, and a package manager is a stronger refresh than the one
  it was protecting.
- **The bun preflight still fires on a `herdr plugin install`.** That install is a git checkout that
  genuinely rebuilds, so the check is true there. #169's second proposal is what retires it, and it
  is not this record's subject.
- **The release payload carries `scripts/collie-ctl.sh`.** Every `[[actions]]` command is frozen as
  `bash scripts/collie-ctl.sh <verb>` (ADR 0006), and the payload did not carry `scripts/`. It does
  now, so the tarball is self-consistent with the manifest it ships — independently of the fact that
  a package does not register those actions.

### What would justify revisiting

- **Herdr scans a system plugin directory** — `/usr/share/herdr/plugins/*/herdr-plugin.toml` or
  similar. A packaged plugin would then be discovered with no user action. This is the upstream ask
  that makes packaged plugins first-class, and it sits beside the refresh-verb request ADR 0006
  already filed.
- **A packager that installs a writable, user-owned tree inside `$HOME`.** All three of clause 4's
  disjuncts are false there, so the install reads `loose-binary` — wrong but safe, because it
  refuses to update rather than updating something it should not. If such installs become common,
  clause 4 needs a fourth fact, and this is the record to amend.
- **A single-user machine where everything outside `$HOME` is the operator's own.** Such a tree is
  claimed by this kind and told to ask its package manager, which is unhelpful where there is none.
  Nothing observed yet.
- **Evidence that an operator genuinely wants a packaged install to update itself.** Today that is
  read as a contradiction, and running as root to grant it is exactly the case the fourth
  consequence above refuses.
