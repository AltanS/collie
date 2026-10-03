# 0075: Windows is a supported host

- **Status:** Accepted. The public label stays experimental until all of these hold together: a
  release carries the Windows zip, `install.ps1` is on colliepwa.dev, one install and one update have
  run against a real release, the Windows check is a required check in branch protection,
  `release.yml`'s gate reads the Windows workflow, and the tolerance for a missing Windows zip is off.
  That tolerance closes itself: it is mandatory once any earlier release carries a Windows zip, or on
  2026-11-15.
- **Date:** 2026-10-03
- **Shipped in:** 1.16.0
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

This decision supersedes the contrib-only decisions on PR #71 and PR #298 and the 2026-09-27 rule
against a Task Scheduler tier (point 4). The older decisions stand only as history.

1. **The boundary.** Windows 11 on x64, with Herdr as the backend. Herdr's Windows build is the only
   multiplexer there. Windows 10, Windows Server and Windows on ARM are best effort, as before.
   WSL is not Windows for this purpose: a WSL operator runs the Linux setup.

2. **What supported promises.**
   - **A CI run.** The `windows.yml` workflow runs the bridge, cli and scripts suites on
     `windows-latest` on every push and every pull request. That runner is Windows Server, so the
     Windows 11 VM stays the second truth. It is its own workflow, not a job in `ci.yml`, so a red
     Windows run can never stop a Linux hotfix. It blocks nothing today. At promotion, after about
     ten consecutive green runs on `main`, it becomes a required check, and `release.yml`'s gate
     reads it too.
   - **A release asset.** Each release builds `collie-<v>-windows-x64.zip` with a lowercase
     `.sha256` and a manifest entry, in its own job. While `WINDOWS_ASSET_OPTIONAL` is on, a
     failed Windows job warns instead of failing the release. It ends after the first release
     with a Windows asset, or on 2026-11-15. A Windows job that succeeds but leaves no asset always
     fails the release.
   - **What a missing zip means.** `install.ps1` tries the newest five releases, says `<tag> has no
     Windows build` for each, ends with `none of the newest 5 releases ... carries a Windows build
     yet. Nothing was installed.` and changes nothing. `collie update` on a Windows install says
     `release <version> has no Windows build; try again after the next release. Nothing was
     changed.` Both are plain lines, not stack traces.
   - **A rehearsal before each tag.** `make win-rehearse` throws away the Windows VM's disk,
     installs a release with `install.ps1` from a local mirror, updates from the terminal and
     from the phone's endpoint, forces a failed health check and shows the rollback. I run it
     before every release tag. If the Windows VM is unavailable, the tag waits. No rehearsal means
     no tag.
   - **An exit condition for "experimental".** The word leaves only when every one of these holds
     together: (a) the Windows check is a required check in branch protection, (b) `release.yml`'s
     gate reads the Windows workflow, (c) the Windows-asset tolerance is off, and the earlier
     conditions in the Status line are met. Until then the public pages keep the word.
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
   - Herdr older than 0.9.3. That is the tested minimum, and `collie doctor` warns below it.
     Herdr's own Windows build is an upstream dependency that the Herdr project makes, so a defect
     in it is not Collie's to fix.
   - Herdr's action buttons. `herdr-plugin.toml` stays `linux` and `macos` because its actions
     run `bash`.
   - Installing through `herdr plugin install` and starting from a Herdr action. On Windows the
     install is `install.ps1`, and the start is `collie start`.
   - A task name override. The community script read `COLLIE_TASK_NAME`. The task is always
     `herdr.collie`, so one task name has one owner, and `collie doctor` can tell whose it is.
   - Log rotation. `collie.log` is appended to and not rotated, and the crash-log copies of the
     community script are gone. `docs/windows.md` says how to empty it.
   - A version gate without `bash`. PR #71 proposed one and it was not taken. The release check
     still needs `bash`, and a build from source without it is the open spec 03.

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

6. **Who owns the code.** The maintainer. It is tested on the Windows 11 test VM and by
   `windows.yml`, not on contributors' machines. A contributor's Windows PR is checked on both before it
   merges, the same as any other.

7. **`contrib/windows` is removed.** Every verb of the community script `collie-ctl.ps1` is now a
   `collie` verb of the same name, and an install of the old script is taken over under the same task
   name. The credits stay: @JJLiebig wrote the first Windows supervisor in `contrib/windows`
   (PR #71), and @mqmalagris wrote the restart and swap path that makes `collie update` work on
   a running `collie.exe` (PR #309), with the Windows fixes before it (#296, #297, #298).

## Consequences

- **The public pages say what is tested.** The README, `docs/install.md` and `docs/windows.md` name
  the boundary and the limits above. The word "experimental" stays on them until every condition in
  the Status line holds together. Until then the install route is a script saved from the
  repository, and no release has the zip it downloads.
- **A Windows break now shows red on its own check.** The check is not a required one yet, so the
  first ten green runs are a promise I keep by reading the runs, not a rule GitHub enforces.
- **Each Windows check is a partial proxy for the supported target.** The `windows-latest` runner
  (Windows Server) found bugs the Windows 11 VM could not: 8.3 short temp paths, and the built-in
  Administrator account that icacls writes as the SDDL alias `LA`. The VM sees what the runner
  cannot, and neither is a real user's machine.
- **A release waits for the Windows job.** `release` needs `payload-windows`, which costs up to
  fifteen minutes and the runner queue. I accepted that on purpose. A missing Windows zip stops a release once one release has
  carried it, from 2026-11-15, or when the releases API does not answer; the repository variable
  `COLLIE_WINDOWS_ASSET_OVERRIDE=optional` is the loud, temporary escape for a Linux hotfix.
- **A source checkout never updates itself on Windows.** Every Windows install before the first
  zip is a source checkout, and it refuses `collie update`. Moving to the zip install is a one-time
  manual step: `collie uninstall`, then `install.ps1`. After that `collie update` works. This route
  was not rehearsed. Separately, releases up to and including v1.15.0 cannot swap a running
  `collie.exe` (fixed by PR #309 in v1.15.1).
- **A Windows host refuses the crew verbs in code.** `crew invite`, `crew join`, `crew add`,
  `crew deputy`, `crew approve-promote` and `collie promote` stop with one sentence and change
  nothing. The bridge's `POST /crew/v1/enroll` is left as it is, because it only spends an invite
  those verbs mint, so only a trust store copied from Linux with an unexpired invite could still
  enrol a member.
- **The first real tag, v1.16.0, is the first real test of the release job.** A rehearsal rc tag of the real
  `release.yml` has not run.
- **Open follow-ups, none of them part of this decision:** a stable launcher outside `versions\`
  so no version folder stays held; building from source without Git's `bash`; a managed front door on
  Windows; the harness core moving into the repo as a nightly run.
