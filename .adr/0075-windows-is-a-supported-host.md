# 0075: Windows is a supported host

- **Status:** Accepted
- **Date:** 2026-10-03
- **Shipped in:** pending (M43)
- **Supersedes:** the contrib-only decisions on PR #71 (2026-08-11) and PR #298 (2026-09-26), which
  made Windows a community-maintained, best-effort platform. Their reasoning held while nobody could
  test Windows. It does not hold now.
- **Trail:** `.github/workflows/windows.yml` · `scripts/windows-suites.ps1` ·
  `scripts/build-windows-payload.ps1` · `scripts/windows-asset.ts` · `scripts/install.ps1` ·
  `cli/task-scheduler.ts` · `cli/lifecycle.ts` (`ServiceBackend`) · `bridge/host.ts` ·
  `bridge/owner-only.ts`, `bridge/icacls.ts`, `bridge/sddl.ts`, `bridge/acl-policy.ts` ·
  `bridge/dial.ts` · `docs/windows.md` · the workspace's `windows-vm/` and `make win-rehearse` ·
  [ADR 0001](./0001-one-managed-front-door.md) ·
  [ADR 0035](./0035-a-packaged-install-is-not-ours-to-update.md)

## Context

**Windows was contrib-only because nobody could test it.** On PR #71 I took the Task Scheduler
script as a community contribution and said I would not run Windows myself. On PR #298 I said it
again: fixes are best effort and we track no Windows follow-ups. That was the honest call at the
time, and it had a cost. Linux CI could not see a Windows break, so one shipped green. A stock
Windows 11 machine needed Bun, Git, Git's `bash` and Herdr, then a source build, and a release carried
no Windows binary.

**On 2026-10-01 the workspace got a Windows 11 test VM**, and the first runs showed how far best
effort is from supported. About 565 tests failed on real Windows on `main`, every one invisible to
Linux CI. A false `.env was mode 666` line printed on every command. `collie restart` said the
service was not supervised while Task Scheduler ran it. What already worked was the part that mattered:
Herdr for Windows plus the bridge's named-pipe dial, a supervisor under Task Scheduler, and the
running-`collie.exe` swap that @mqmalagris wrote in PR #309.

**A statement of support is a promise, and a promise needs a test behind it.** The milestone that
followed (M43, specs 01 to 11) built the tests first and wrote this decision last, so every
sentence below has a gate or a rehearsal under it.

## Decision

**Windows 11 x64 with the Herdr backend is a supported host.** Support means the maintainer owns the
code and a test keeps it true.

1. **The boundary.** Windows 11 on x64, with Herdr as the backend. Herdr's Windows build is the only
   multiplexer there. Windows 10, Windows Server and Windows on ARM are best effort, as before.
   WSL is not Windows for this purpose: a WSL operator runs the Linux setup.

2. **What supported promises.**
   - **A gate.** The `windows.yml` workflow runs the bridge, cli and scripts suites on
     `windows-latest` for every push. It is its own workflow, not a job in `ci.yml`, so a red
     Windows run can never stop a Linux hotfix. It is not yet a required check. I will promote it
     after about ten consecutive green runs on `main`, and then `release.yml`'s gate reads it too.
   - **A release asset.** Each release builds `collie-<v>-windows-x64.zip` with a lowercase
     `.sha256` and a manifest entry, in its own job. While `WINDOWS_ASSET_OPTIONAL` is on, a
     failed Windows job warns instead of failing the release. It ends after the first release
     with a Windows asset, or on 2026-11-15. A Windows job that succeeds but leaves no asset always
     fails the release.
   - **A rehearsal before each tag.** `make win-rehearse` throws away the Windows VM's disk,
     installs a release with `install.ps1` from a local mirror, updates from the terminal and
     from the phone's endpoint, forces a failed health check and shows the rollback. I run it
     before every release tag.
   - **One lifecycle.** `collie start`, `stop`, `restart`, `status`, `uninstall` and
     `doctor` exist on Windows with the exit codes they have elsewhere.

3. **What it does not promise.**
   - tmux and zellij. Neither has a native Windows build. tuios on Windows is not probed.
   - Windows on ARM, Windows 10 and Windows Server.
   - A Windows machine joining a crew. No crew step was rehearsed on Windows, so a Windows host
     cannot join a crew in this release.
   - A managed front door. ADR 0001 says Collie manages exactly one front door, and on Windows it
     manages none yet: `tailscale serve` is not driven from a Windows host.
   - A signed binary. `collie.exe` ships unsigned, installed with a sha256 check, as Herdr and pi
     do. Smart App Control can block it. Signing is a later option, not a gate.
   - winget or MSI. A package-managed install must not update itself, and packages wait for the
     maintainer's accounts.
   - Herdr's action buttons. `herdr-plugin.toml` stays `linux` and `macos` because its actions
     run `bash`.

4. **The service tier is native Task Scheduler.** `cli/task-scheduler.ts` registers the task
   `herdr.collie` at logon with a limited token. The task runs `collie.exe _supervise`, which relaunches
   the bridge with a backoff. This is a tier inside `cli/lifecycle.ts`, behind the same
   `ServiceBackend` interface as systemd and launchd. It reverses my 2026-09-27 "no Task Scheduler
   tier in `cli/lifecycle.ts`", which I gave under the contrib-only decision. The task runs
   `<install>\current\bin\collie.exe`, and `current` is a directory junction, because a standard
   user cannot create symlinks.

5. **Secrets are owner-only by NTFS access list.** Chmod does nothing on NTFS, so Collie reads
   and sets the access list through `icacls` by absolute path. `collie doctor` reports
   `secrets-private` in three states: private, loose, not checked. The repair is narrow: only the
   bridge process repairs, and only a folder Collie created now, a default folder under the profile,
   or a folder that is empty or holds only Collie's names. Any other folder is checked and
   warned about, with the `icacls` line that fixes it. The old list is saved first, and the bridge prints
   the `icacls /restore` line. `COLLIE_NO_ACL_REPAIR=1` turns every change off. A network share or a
   FAT volume is "not checked", because a list that does not exist cannot be read.

6. **Who owns the code.** The maintainer. It is tested on the Windows 11 VM on minibuch and by
   `windows.yml`, not on contributors' machines. A contributor's Windows PR is checked on both before it
   merges, the same as any other.

7. **`contrib/windows` is removed.** Every verb of the community script `collie-ctl.ps1` is now a
   `collie` verb of the same name, and an install of the old script is taken over under the same task
   name. The credits stay: @Pimpmuckl wrote the first Windows supervisor in `contrib/windows`
   (PR #71), and @mqmalagris wrote the restart and swap path that makes `collie update` work on
   a running `collie.exe` (PR #309), with the Windows fixes before it (#296, #297, #298).

## Consequences

- **The public pages say what is tested.** The README, `docs/install.md` and `docs/windows.md` name
  the boundary and the limits above. The word "experimental" stays on them until a release
  carries the Windows zip and `install.ps1` is published on colliepwa.dev, because until then the
  front door is the zip on the release page.
- **A Windows break now fails a check.** The check is not a required one yet, so the first ten
  green runs are a promise I keep by reading the runs, not a rule GitHub enforces.
- **A release waits for the Windows job.** `release` needs `payload-windows`, which costs up to
  fifteen minutes and the runner queue. I accepted that on purpose.
- **Users on 1.15.0 or older update by hand once.** The second half of `collie update` runs the code
  of the release it fetched, and that older code swaps `collie.exe` the old way and fails with
  `EPERM`. The first release that carries the fixed swap is the first one that updates itself.
- **The first real tag is the first real test of the release job.** A rehearsal rc tag of the real
  `release.yml` has not run.
- **Open follow-ups, none of them part of this decision:** a stable launcher outside `versions\`
  so no version folder stays held; building from source without Git's `bash`; a managed front door on
  Windows; the harness core moving into the repo as a nightly run.
