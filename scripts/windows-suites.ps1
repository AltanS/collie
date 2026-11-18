# The Windows test suites, in ONE place. CI (`windows` job in ci.yml) and the Windows VM
# (`make win-test`, guest-test.ps1 in the workspace) both call this file, so they cannot drift.
#
# The caller gets the code, the toolchain and `bun install` ready. This script does none of that.
# It runs `bun test` over bridge, cli and scripts, and prints one line per suite. Exit 0 means: no
# failing test, and no suite with more skipped tests than its own budget allows. Any other result
# exits 1.
#
# Works in Windows PowerShell 5.1 and in PowerShell 7.
#
#   -Out       where the logs go: <suite>.log and <suite>.fails per suite (one failing name per line)
#   -MaxSkipsBridge, -MaxSkipsCli, -MaxSkipsScripts
#              the most skipped tests that still count as green, PER SUITE, so a new skip in one suite
#              cannot hide behind a removed one in another. A test must not be skipped just to get
#              green, so a higher count is a failure. Raise a number only with a reason.
#              Bridge went from 2 to 0 when M43 spec 04 checked the access list instead of the mode.
#              Today, 643 in all, each one named, with its reason:
#              bridge 414: 174 from before 1.29.0 and 240 new: 143 listed in the next sentence, then 2 more of the trick-leftovers merge (one agent view picture, one official add test), 71 of the local API, its run token and the `watch` manifests ("The local API, bridge" below) and 24 the budget did not list ("Not listed before" below). The 143: (the data path 54 and the inside socket 17, then the Herdr and Tuios
#                adapters 10, then Accounts 47, then 11 more of the data path for a dropped or failed data send and a shadowed part, then 1 for the pane's program environment read of pi (#793); see below). Of the 174, 15 (16 with the trick-leftovers merge, counted in the 2 above) are the agent view pictures (see "Agent view pictures, bridge" below). 5 are the POSIX-only and engine cases below, 1 the /etc link scan, 1 the telemetry file mode, 6 are the hold socket tests, 7 the walky ones, 6 the walky sibling registry ones, 30 are the
#                durable example apps, 10 are the durable-harness adapter test, 36 are the durable socket tests (see "Durable, bridge" below),
#                5 are the pane's program reads (see "The pane's program, bridge" below), and 6 are the fake git of a new
#                worktree (see "The fake git of a new worktree, bridge" below). 45 are the Hill and the tricks (see
#                "The Hill and the tricks, bridge" below).
#                2 are "createPaneVersion — a harness off the login PATH" in pane-binary.test.ts (the test and its
#                describe): the off-PATH agent is a `#!/bin/sh` script, which Windows cannot run.
#                Pi skips the raw-control one-line send test in protocol.unstyled.test.ts; its Alt+Enter remains a named key.
#                Of the first 5, four are in bridge/stt/local-cli.test.ts. Windows has no executable bit
#                and no file owner check in this provider:
#                - "commandFileProblem: regular executable passes, symlinks are followed" (the
#                  executable bit; a symlink needs a privilege on Windows)
#                - "status refuses a directory and a non-executable file, and names neither" (the
#                  executable bit)
#                - "only an old directory with the prefix, owned by this user, is removed" (the
#                  owner check by uid)
#                - "loading the provider sweeps its temp root once, in the background" (without a
#                  uid the sweep removes nothing on Windows, so there is nothing to see)
#                The fifth is bridge/stt/whistle.test.ts, "the whistle provider - the real engine, end
#                to end > a 13 s WAV becomes text through a real child of this Collie". It runs only
#                where COLLIE_TEST_WHISTLE_DIR holds the measured model, which is never committed, so
#                no CI job or VM has it (Linux CI skips it too).
#              The /etc link scan, bridge (1). In bridge/claude-commands.test.ts, "discoverClaudeCommands: the bounds
#                a reader of the operator's disk keeps". Windows has no /etc, and a file symlink needs a privilege there:
#                - "real disk: a symlink to /etc, in a project or in the personal folders, yields no row" (POSIX links to /etc)
#              The telemetry file mode, bridge (1). A file mode is POSIX, and the rest of bridge/telemetry.test.ts runs on Windows:
#                - "the file is owner-only" (telemetry.test.ts, "createTelemetry": the 0600 mode of telemetry.json)
#              The hold socket, bridge (6). Windows builds no hold socket yet, so every permission there stays a
#                screen ask (CHANGELOG, M56 spec 12). The six tests of the "the hold socket" block in
#                bridge/surface/hook-ask.test.ts are `test.skipIf` on win32:
#                Each name sits on one line, so the pin test can find it:
#                - "owner-only: the folder is 0700, the socket 0600; a second bridge on the same path does not take it" (a POSIX socket file with an owner-only mode)
#                - "a pid the bridge cannot place is dropped with one log line, and the connection closes with no decision" (it dials that socket)
#                - "a placed request reaches the session; the decision travels back as one line" (the same)
#                - "a request from another multiplexer's pane is dropped without a log line, a same-namespace miss is logged" (the same)
#                - "an unparsed line is dropped" (the same)
#                - "every request the socket receives leaves exactly one record, a foreign multiplexer's and a skip line's too" (the same)
#              Walky talky, bridge (7). A file mode and a Unix socket are POSIX. In bridge/walky/ the checks of
#                0700 and 0600 sit in their own skipped test, and the behaviour beside them runs on Windows:
#                - "keeps its tokens at 0600 in a 0700 folder" (instances.test.ts, "the instance registry")
#                - "is private: a 0700 folder and a 0600 file" (log.test.ts, "the log")
#                - "the file is 0600 in a 0700 folder" (off.test.ts, "the off flag")
#                - "keeps its file at 0600 in a 0700 folder" (refusals.test.ts, "the refusal counter")
#                - "keeps an id and target a day, apart from the log, on disk at 0600" (seen.test.ts, "the seen file")
#                - "is 0600, answers one line per connection, and refuses a second bridge on the same path" (socket.test.ts, "the socket"): every part of it is the Unix socket, and Windows builds no walky socket ("Windows has no socket" runs there)
#                - "the server answers an unread line with its reason or `not here`, never the bare word" (socket.test.ts, "the socket"): the answer travels over the Unix socket
#              The walky sibling registry, bridge (6). bridge/walky/siblings.test.ts walks a live hook target registry
#                (liveHookTargets), which needs a pid start-time probe, and win32 has none: every target reads as dead, so
#                the registry is empty there in production and there is nothing to merge. The rule, the merge, the cache and
#                the fixture with the siblings handed in run on Windows. Each name sits on one line, so the pin test can find it:
#                - "the next log's list for the pane holds the stable-recorded row, with `recordedBy`"
#                - "the sibling's files are only read: the log, its inbox and its instances stay as they were"
#                - "a registry that is not private reads as no siblings, and the list is the own one"
#                - "a missing registry reads as no siblings"
#                - "a sibling with no walky log adds nothing"
#                - "a FIFO or a folder where a log should be is skipped, never opened" (mkfifo is POSIX only)
#              Durable, bridge (30 + 36). Windows has no socket transport (WIRE.md section 1A), so a test
#                that is about the Unix socket itself cannot run there. The tests about the wire (controls,
#                asks, answers, receipts, events, Chat, starters, the conformance suite) run on Windows
#                against the fake program on 127.0.0.1 (`FakeDurableProgram.startWire`). The 30 are every
#                test of bridge/mux/durable/example.test.ts (12), example-hello.test.ts (6) and
#                example-cloudflare.test.ts (12): the durable example speaks over a Unix socket (or needs
#                `wrangler`), and Windows attaches a program over HTTPS, so none of them runs there. A file's
#                count is its tests plus the skipped placeholder, the beforeAll and the afterAll that Bun
#                counts with them. The VM run of release-1.22 counted bridge 71, nine more than the 62 this
#                budget held before example-hello.test.ts (6) and three more counted in the other two files.
#                The 36 are bridge/mux/durable/client.test.ts: "the privacy check", "the path walk" and "the request"
#                (26; the socket client's owner, mode, link and path rules, and its deadline and size cap on
#                a socket); bridge/mux/durable/adapter.test.ts (6: the factory reading
#                COLLIE_DURABLE_SOCKET, the startup line, socket path rules, a program that asks for a token,
#                a socket that loses its mode, a socket that is not there); events.test.ts (the factory
#                handed a socket path), asks.test.ts (a socket with nothing listening) and
#                http-client.test.ts (the socket client sends no Authorization header), one each; and
#                bridge/durable/log.test.ts (a mode 0755 folder put back to 0700).
#              Durable harness, bridge (10). bridge/mux/durable/example-durable-harness.test.ts returns a skip reason on
#                win32: it starts the examples/durable-harness server with Node 24 and its Bun install, which no
#                Windows job or VM has. The Linux job "durable example" in ci.yml runs it. The 10 are its 7 tests,
#                the skipped placeholder, the beforeAll and the afterAll that Bun counts with them.
#              The pane's program, bridge (5). The version read of 1.24.1 (.adr/0124) runs the pane's own binary.
#                Each name sits on one line, so the pin test can find it:
#                - "boundedRun answers at its cap even when a grandchild holds the pipe" (binary-version.test.ts, win32: a POSIX sh grandchild)
#                - "boundedRun returns what a quick command printed, and its exit code" (binary-version.test.ts, win32: a POSIX sh)
#                - "procProbe sees a live process's executable and folder" (pane-binary.test.ts, off Linux: it reads /proc)
#                - "two copies of one harness" (pane-binary.test.ts, win32: its fake omp copies are POSIX sh scripts), its one test and
#                  the hook Bun counts with it. The Windows path of paneBinaryOf runs on Windows with a fake host ("no /proc" tests).
#                One more, new with the pi pane fix (#793), in the 143 new:
#                - "procProbe reads a live process's environment, and nothing on another host" (pane-binary.test.ts, off Linux: it reads
#                  /proc/<pid>/environ of a live `sleep`, and Windows has neither /proc nor `sleep`; the parse of that file, `envFromEnviron`,
#                  and the other-host answer run on Windows in the tests beside it)
#              The fake git of a new worktree, bridge (6). bridge/worktree-add.test.ts hands `addWorktree` a fake git, a POSIX
#                `#!/bin/sh` script that Windows cannot spawn (EFTYPE). Those tests are `test.skipIf` on win32; every test
#                there that runs the real git runs on Windows too (M81). Each name sits on one line, so the pin test can find it:
#                - "two creates for one folder at once spawn one git worktree add, and both open the checkout" (a logging wrapper)
#                - "a create waiting on a failed one for its folder reports the failure, and runs no add of its own" (the same)
#                - "removes the half-made checkout and the branch it made, and says so" (a git that sleeps past the timeout)
#                - "says the branch stayed behind when its delete fails" (the same)
#                - "keeps the branch when the checkout could not be removed" (the same)
#                - "never removes a folder that was there before the call" (the same)
#              Agent view pictures, bridge (15). Every test of bridge/agent-view/media.test.ts is `posix(...)`, a `test.skipIf`
#                on win32: it keeps pictures in 0700 folders and reads them through the hill's POSIX file checks
#                (owner, mode, no link), which Windows does not have. The store and service tests beside it run on Windows.
#              The Hill and the tricks, bridge (42). A symlink needs a privilege on Windows, a FIFO and a device are POSIX,
#                Windows has no walky socket, and a shell line is cmd.exe there (bridge/tricks/run.ts), so a `#!/bin/sh`
#                program does not run. The checks of a 0600 file and a 0700 folder beside them read the access list on
#                Windows and run there. Each name sits on one line, so the pin test can find it:
#                - "a symlink, a symlinked folder, a folder, a missing file, a FIFO and a device are refused with the reason" (hill/media.test.ts)
#                - "a symlink in the folder that points out, a symlinked folder in it, and `../` out of it are refused" (hill/media.test.ts)
#                - "an image path rides the socket, the bridge reads the file, and the phone reads the bytes" (hill/media.test.ts, the socket)
#                - "hill.clear over the socket needs no pane, clears every closed decision and answers the count" (hill/routes.test.ts)
#                - "post over the socket, read the hill, answer, and the walky send types the contract's body" (hill/routes.test.ts)
#                - "a symlink in the trick folder that points out of it is refused, even to another trick's image" (tricks/hill.test.ts)
#                - "end to end with the legs trick" (tricks/hill.test.ts, its one test: the legs fixture is `./program.sh`)
#                - "a symlink is never followed: not to a file outside, not through a folder outside" (tricks/inputs.test.ts)
#                - "a symlink the program planted is never written through, nor read as a kept file" (tricks/inputs.test.ts)
#                - "a FIFO as trick.toml or config.toml is refused and never hangs the scan" (tricks/units.test.ts, mkfifo)
#                36 are bridge/tricks/official.test.ts, the add from the official list: every test of "adding from the list",
#                "updating an added trick to the list's commit" and "a git run killed at its time cap", and its 4 `test.if(posix)`
#                cases. The fixture repository is reached as `file://` plus a temp path, which is no file URL on Windows; its
#                programs are `#!/bin/sh` with an executable bit; the time cap kills a POSIX process group.
#              The local API, bridge (62 + 9). The local API does not stand on Windows in this release: tricks are gated there
#                (`TricksService.gated`), the socket follows "tricks run here", so `ApiSocket.start()` is a no-op that logs once and
#                `localApiWanted` is false. A test that starts the server and dials it has no socket to dial. The one reason for all of them
#                is NO_API_ON_WINDOWS in bridge/api/skip.ts: "the local API does not stand on Windows before the Windows gate for tricks opens".
#                Each is `apiSocketTest` or `apiSocketDescribe` (bridge/api/skip.ts), a skip on win32; the Windows answer (no socket, said once;
#                never told true by the gate) runs everywhere with an injected platform:
#                - 9 in bridge/api/socket.test.ts, "the socket's life" (all but "no socket until started" and "Windows: no socket, said once")
#                - 53 in bridge/api/socket.test.ts, every test of "the framing" (17, with the 5 of "the log line of a read"), "the waits" (7), "requests in flight and idle connections" (3),
#                  "the api folder is the user's own" (4), "the write budget" (3), "the screen reads of the whole socket" (2), "hello over the socket" (1)
#                  and "the run token" (16, M105 spec 05: every one opens a connection with `hello` and a run token)
#                The 9 are in bridge/tricks/triggers.test.ts (`watchTest`): a manifest's `watch` path starts with `/` or `~/`, so the temp-folder path of a
#                  real file on Windows (`C:\...`) is refused ("A watched path starts with / or ~/.") and the trick never watches. This is a real Windows
#                  fault of the schema, to be settled when the gate for tricks opens; the watcher itself runs on Windows in bridge/tricks/watch.test.ts.
#              Not listed before, bridge (24). The VM run of e5c645d2e counted bridge 331 against 317. These skip on win32 and were in no list above:
#                bridge/tricks/repo-index.test.ts (13: reading an index, adding from an index, the empty home of a fetch, a git that hangs, the .git
#                link; real git and `#!/bin/sh` programs, `describe.if(posix)` and one `test.if(posix)`; 12 of them were there at e5c645d2e),
#                bridge/api/trick-end-to-end.test.ts (5: it dials the local API socket; 2 of spec 04 and 3 more of the run token, spec 05), and bridge/tricks/approved.test.ts (1: a symbolic link at the
#                state folder, new with the trick-leftovers merge), bridge/tricks/service.test.ts (3: the run token printed back by a real `#!/bin/sh` program, `describe.skipIf(win32)`) and bridge/tricks/feature-switch.test.ts (1: "off while a program RUNS" kills a real `./legs.sh` child, which the runner refuses on Windows) and bridge/tricks/proposals.test.ts (1: a new version whose only change is a file mode, POSIX only). 12 + 2 = the 14 of the VM run, and the 10 run-token, switch and mode ones came after it. The count of the VM decides: if it is not 414,
#                the next run says by how much, and this paragraph names the files again.
#              The data path, bridge (63 + 19). The part (the local socket of bridge/inside/, ADR 0140) is OFF on Windows in 1.29.0
#                (decision 15: Windows keeps the screen path). `InsideServer.start()` answers false there, so `dataRig` cannot start
#                and no test can dial the socket, as for the hold and walky sockets above. Each of these is `dataTest` or `dataDescribe`
#                (bridge/inside/data-rig.ts), a skip on win32, and the file's tests that do not use the rig run on Windows:
#                - 22 in bridge/walky/deliver.test.ts, "WalkyTalky by data (M99 spec 05)"
#                - 7 in bridge/inside/round.test.ts, every test: a whole round with the fake part
#                - 18 in bridge/surface/data-send.test.ts, every test
#                - 3 in bridge/surface/holds.test.ts, "a data send while the part's turn runs"
#                - 10 in bridge/inside/stale-word.test.ts, every test
#                - 3 in bridge/inside/linked.test.ts, the two that start the rig and "the field follows the live part"
#                - 19 in bridge/inside/server.test.ts, every test that starts the server or dials it. One test there runs everywhere
#                  and proves the Windows answer with an injected host (`start()` is false and logs "not built for Windows"; the gate
#                  says "platform", also in gate.test.ts).
#              The Herdr and Tuios adapters, bridge (10). The describe "a connection closed before the reply" of
#                bridge/mux/herdr/client.test.ts and of bridge/mux/tuios/client.test.ts (5 tests each, M100 spec 03) is `describe.skipIf`
#                on win32: its stand-in daemon is a `net` server listening on a Unix socket path in a temp folder, which the
#                Windows client does not dial (it dials a named pipe).
#              Accounts, bridge (47). Accounts (M101) are OFF on Windows by decision: the route answers 404 there and the app hides
#                the page. The feature rests on POSIX folder forms (`~/x`, a leading `/`), symlinks and the 0700 mode, and these tests
#                are written in those forms, so on a Windows path module they fail by their own fixtures. Each is `accountTest`
#                (bridge/accounts-skip.ts), a skip on win32; the tests of the same files that pass on Windows still run, and the
#                Windows answer (404, no offer, a refused add) is proven on every system with an injected platform:
#                - 2 in bridge/account-adapters.test.ts, the default folder and the journal root
#                - 6 in bridge/account-folder.test.ts, parseFolderPath (2) and checkFolder (4)
#                - 2 in bridge/account-links.test.ts, planLinks on a fresh default and on a file link
#                - 29 in bridge/accounts-routes.test.ts, the found folders, the windows of a row, the adds, the remove, the start
#                  line, a pane's account, the server glue, the live journal roots, and 12 of who is signed in (spec 04: the
#                  status command per account, its environment, the state file rule, the wait, the background refresh, the redaction, Sign in
#                  again and the sign-in pane), and 2 of Change login (the running sessions per account, none for an unused one)
#                - 4 in bridge/accounts-store.test.ts, a good row, the duplicate row, the store add and the listener
#                - 3 in bridge/launch-by-id.test.ts, a launch with an account, and Change login's start on a signed-in account
#                - 1 in bridge/worktree-from-folder.test.ts, a worktree with an account
#              cli 194 in all: 1 is new with the local API ("The local API, cli" below), 2 are the trick-add ones the trick-leftovers merges added to the 22 below, 2 are the pictures a proposal brings (2026-11-18, in the 22 of cli/trick-propose.test.ts below), and of the other 189, 21 are new since 1.29.0: 3 of the hold card, 8 of the harness verbs, 3 of the first full trick run, 5 of the
#                repository index and 2 of the proposal card in the session (all
#                of the Hill verbs and the tricks), below. The other 168: 21 in the next paragraph, then 3 of the statusLine wrapper, 54 of walky talky, 21 of the agent view,
#                and 69 of the Hill verbs and the tricks (72 with the 3 above; see "The Hill verbs and the tricks, cli" below). The 18 of
#                the helper's output, once gated on Windows (b), run on Windows again since the helper v6 (see "The helper's output, cli" below).
#                Of the 21, 12 are every test of the "doctor durable" describe in cli/doctor.test.ts: each reads a
#                real Unix socket. Its Windows rows are tested in cli/durable-findings.test.ts with a fake
#                platform. The other 9:
#                "a per-call override wins over the Exec's own environment (#283) > a child killed by a signal says which one"
#                (Windows has no POSIX signals),
#                "a per-call override wins over the Exec's own environment (#283) > inherit and runIn can point the child's stdout at stderr"
#                (cli/sys.test.ts, added in 1.25.0: its children are POSIX `sh -c` commands),
#                "collie _whistle-transcribe - the real engine, end to end > a child of this checkout's CLI turns 10.4 s of speech into text"
#                (the same missing model as the bridge case), and the 3 tests of
#                "installScript from a shallow lead, run for real" in cli/remote.test.ts: they run the
#                install leg, POSIX sh that a crew member runs over ssh, and a Windows machine cannot be a
#                crew member (WINDOWS_CREW_SENTENCE in cli/crew.ts), and
#                "the real probe on an hc-only home reports the core and Collie's own config dir" in cli/remote.test.ts
#                (M84: the stand-in `hc` and the probe are POSIX `sh`), and the 2 tests of
#                "the probe's dirty check, run for real" in cli/remote.test.ts (the probe again, run
#                with /bin/sh against a real git checkout).
#              The local API, cli (0 + 1). cli/api.test.ts has no skip any more: since M105 spec 05 `collie api` run by hand prints one line and reads
#                nothing, so no test of it dials a scratch Unix socket (the 10 `apiSocketTest` of the bridge's reason, NO_API_ON_WINDOWS, are gone with
#                the dial); the table tests run on Windows through a seam, and the Windows line of `collie api` has its own test. One in
#                cli/tricks-switch.test.ts, "check --run is a developer's tool: it runs a folder once in the terminal with tricks off": the `--sh`
#                sample is a `#!/bin/sh` program, which does not run on Windows.
#              The statusLine wrapper, cli (3). The "runShell stops the whole command" block in cli/statusline.test.ts is
#                `describe.skipIf` off Linux: it signals a POSIX process group, and the wrapper is not on Windows by design
#                (the usage row, .adr/0115). Its 3 tests are "a SIGTERM to the wrapper stops a compound command's grandchild"
#                (2, one per group layout) and "passes the command's output and exit code through".
#              Walky talky, cli (54). cli/walky.test.ts runs the verbs against a real bridge socket in a temp state
#                dir, and Windows cannot bind it (the same reason as the hold socket). Each of those tests is
#                `socketTest`, 13 in "send" (M98 added the outside flag and the broadcast refusal), 37 in "reply, inbox, status, who" (two of them, from M85, are the resting-session sends and the `--wake` refusal on a reply; three, from M89, are `off` and `on`, the who marks and the two off refusals; M98 added the who space cases; the pairing fix added one; the session names added the who name and title case; the subject added the `--subject` send, its refusal and the send past a lead below 1.29.0) and 4 in "on a crew member". The
#                tests that never reach the socket run on Windows: the usage errors, "no bridge at all is
#                UNREACHABLE" and "on Windows it says why and exits STATE".
#              Agent view, cli (21). cli/trick-view.test.ts drives the `trick view` verbs against a real bridge socket, as
#                cli/walky.test.ts does, and Windows cannot bind it. Each of those tests is `socketTest`; the parse
#                and screen-reading tests beside them run on Windows.
#              The Hill verbs and the tricks, cli (74).
#                28 are cli/hill.test.ts: each `socketTest` drives `collie hill` against a real walky socket, as cli/walky.test.ts
#                does, and Windows cannot bind it (the verbs say so there). Four of them, "a picture under /tmp, for a bridge
#                with a private /tmp", also stage from /tmp, which systemd's PrivateTmp hides.
#                7 are cli/image-stage.test.ts, `linux(...)`: staging a picture is for a bridge under systemd's PrivateTmp,
#                on Linux only. Its path and pass-through tests run on Windows.
#                22 are cli/trick-add.test.ts ("collie trick add", "collie trick update", "collie trick remove", and the 5 of
#                "collie trick add <url> with no folder", the repository's index, package J): the fixture
#                cases build symlinks, exec bits and sh hooks. The source and hardening cases run on Windows.
#                22 are cli/trick-propose.test.ts: 20 `socketTest` (the walky socket) and 2 `posixTest` (a symlink each). The
#                first full trick run (2026-11-16) added 3: two run a proposed trick without its config.toml, one reads
#                the one warning prefix, all three over the socket. The pictures a proposal brings (2026-11-18) added 2:
#                one sends them over the socket, one leaves a picture behind a link:
#                - "refuses a symbolic link, even to a file inside the folder"
#                - "a picture through a link stays behind: a linked file, a linked folder, a linked media/; the mode bit never goes"
#                2 are cli/trick-kit/trick.test.ts, the helper's POSIX tools. Each name sits on one line, so the pin test can find it:
#                - "t.sh runs without a shell, never throws, caps its output, stops on time, and hides BUN_BE_BUN from the child" (echo, head, sleep, env, /dev/zero)
#                - "t.tool finds a program on PATH, else in the extra and user folders, PATH only under TRICK_TOOLS_ONLY_PATH=1" (sh on /usr/bin:/bin, a tool found by its executable bit)
#              The hold card, cli (3). The "two emitters, one card" describe of cli/hold.test.ts runs the hook against a real hold socket
#                and is `test.skipIf` off Linux (Windows builds no hold socket, see the hold socket above):
#                - "with no owning part the hook's hold is the card, as before"
#                - "the part owns permissions: one card from the part, the hook returns at once with no decision"
#                - "the hook comes first: its card stays until the part's hold opens, then the hook returns with no decision and the part's hold is the one card"
#              The harness verbs, cli (8). The tests of "harness verbs for the data path" pin `platform: "linux"` through the verbs'
#                `deps.platform` seam, so their logic runs on Windows (the verbs refuse on win32 in 1.29.0, ADR 0140; "on Windows link
#                refuses" runs everywhere). The 8 that run the fake `claude`, a `#!/bin/bash` script that Windows cannot run from a
#                PATH lookup, are `claudeTest`, a skip on win32: link claude, link claude twice, unlink claude, the managed setting,
#                the interrupted first link, unlink while `claude plugin list` fails, "update: harness sync rewrites an older linked
#                part" and "touches nothing else".
#              The helper's output, cli (0, was 18): fault b of the Windows milestone. A program that used the trick helper
#                (`./trick.ts`) printed nothing on Windows, because the helper ended a run with `process.exit` over a stdout write
#                in flight. Helper v6 ends after the pipe took the output, so the 18 tests that run such a program (3 in
#                cli/trick.test.ts, 9 in cli/trick-kit/trick.test.ts, 6 in cli/trick-dev.test.ts) are no longer `helperTest`
#                and run on Windows. Tricks stay gated on Windows (bridge/tricks/service.ts `gated`) until Altan lifts the gate.
#              scripts 35: 23 are every test of scripts/install.test.ts ("scripts/install.sh > ..."):
#                install.sh is POSIX sh, and Windows installs with install.ps1, tested beside it.
#                The other 2 are in the harness lab (scripts/harness-canary/lab/):
#                - "POSIX only: the login copy has mode 600" in seed.test.ts (Windows has no file modes)
#                - "a real throwaway server starts, shows its pane, stops, and leaves no socket" in tmux.test.ts
#                  (it needs a tmux binary, and Windows has none)
#                The last 10 are every test of scripts/official-tricks.test.ts, the maintainer script that keeps the official
#                list in step with the tricks repository: it builds a temp repository of `#!/bin/sh` programs with an
#                executable bit and reads it through `file://`, as the add from the list does (bridge 33 above).
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxSkipsBridge = 414,
  [int]$MaxSkipsCli = 194,
  [int]$MaxSkipsScripts = 35
)
$skipBudget = @{ bridge = $MaxSkipsBridge; cli = $MaxSkipsCli; scripts = $MaxSkipsScripts }
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# Always run from the repository root, whatever directory the caller is in.
Set-Location (Split-Path -Parent $PSScriptRoot)
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

# Some suites shell out to bash. Git for Windows has one, but it is not on PATH by default.
# Put Git's own bash FIRST: Windows can also have `System32\bash.exe`, the WSL launcher, and that one is no use.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$gitBin = if ($gitCmd) { Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd.Source)) "bin" } else { "C:\Program Files\Git\bin" }
if (Test-Path (Join-Path $gitBin "bash.exe")) { $env:Path = "$gitBin;" + $env:Path }
Write-Output ("bash     {0}" -f $(if (Get-Command bash -ErrorAction SilentlyContinue) { (Get-Command bash).Source } else { "NOT FOUND" }))

# Hermetic: the suites must not read a config or state dir that a live bridge on this machine uses.
foreach ($v in "HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "COLLIE_STATE_DIR", "COLLIE_PORT", "HERDR_SOCKET_PATH") {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $Out, "$Out\cfg", "$Out\state" | Out-Null
$env:HERDR_PLUGIN_CONFIG_DIR = "$Out\cfg"
$env:HERDR_PLUGIN_STATE_DIR = "$Out\state"

function Read-Utf8Lines([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  return [System.IO.File]::ReadAllLines($path)
}

# The count that bun prints on a line like "  12 skip". A missing line means zero.
function Get-BunCount([string[]]$lines, [string]$word) {
  foreach ($l in $lines) { if ($l -match "^\s*(\d+) $word\s*$") { return [int]$Matches[1] } }
  return 0
}

$failed = $false
$allFails = @()
$overBudget = @()
$totalSkips = 0

# One suite = one command line. cmd.exe does the redirect, so PowerShell never wraps or
# re-encodes the output, and the "(fail) name" lines stay whole.
$suites = [ordered]@{
  bridge  = "bun test ./bridge"
  cli     = "bun test ./cli"
  scripts = "bun test ./scripts"
}
foreach ($name in $suites.Keys) {
  $log = "$Out\$name.log"
  cmd /c "$($suites[$name]) > `"$log`" 2>&1"
  $bunExit = $LASTEXITCODE
  $lines = Read-Utf8Lines $log
  $pass = Get-BunCount $lines "pass"
  $fail = Get-BunCount $lines "fail"
  $skip = Get-BunCount $lines "skip"
  $failing = @($lines | Where-Object { $_ -like "(fail) *" } |
    ForEach-Object { ($_ -replace "^\(fail\) ", "") -replace "\s+\[[\d.]+ms\]$", "" } |
    Sort-Object -Unique)
  # Not `Set-Content`: with an empty list it leaves the old file in place, and a green run would
  # keep the failures of an earlier red one.
  [System.IO.File]::WriteAllLines("$Out\$name.fails", [string[]]$failing)
  Write-Output ("{0,-8} {1} pass, {2} fail, {3} skip" -f $name, $pass, $fail, $skip)
  $totalSkips += $skip
  if ($skip -gt $skipBudget[$name]) { $overBudget += ("{0} {1}, allowed {2}" -f $name, $skip, $skipBudget[$name]) }
  $allFails += @($failing | ForEach-Object { "{0}: {1}" -f $name, $_ })
  if ($pass -eq 0) {
    # No summary line, or none passed: a suite that ran nothing must not look green.
    Write-Output ("         {0}: no passing test in {1}" -f $name, $log)
    $failed = $true
  }
  if ($fail -gt 0 -or $failing.Count -gt 0) { $failed = $true }
  elseif ($bunExit -ne 0) {
    # bun failed with no failing test: a crash, a timeout, or a file that did not load.
    Write-Output ("         bun exit {0} with no failing test, last lines of {1}:" -f $bunExit, $log)
    $lines | Select-Object -Last 8 | ForEach-Object { Write-Output "         $_" }
    $failed = $true
  }
}

$allowed = $MaxSkipsBridge + $MaxSkipsCli + $MaxSkipsScripts
Write-Output ("skips    {0} (allowed {1}: bridge {2}, cli {3}, scripts {4})" -f $totalSkips, $allowed, $MaxSkipsBridge, $MaxSkipsCli, $MaxSkipsScripts)
if ($overBudget.Count -gt 0) {
  Write-Output ("         too many skipped tests: {0}." -f ($overBudget -join "; "))
  Write-Output "         Remove the skip. If a test truly cannot run on Windows, raise that suite's -MaxSkips<Suite> in scripts/windows-suites.ps1 and say why in the PR."
  $failed = $true
}
if ($allFails.Count -gt 0) {
  Write-Output "failing tests (first 40):"
  $allFails | Select-Object -First 40 | ForEach-Object { Write-Output "         $_" }
}
Write-Output "logs     $Out"
if ($failed) { exit 1 }
exit 0
