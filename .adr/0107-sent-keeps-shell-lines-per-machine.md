# 0107: Sent keeps shell lines per machine

- **Status:** Accepted
- **Date:** 2026-10-17
- **Shipped in:** pending (1.23.0)
- **Relates to:** [ADR 0095](./0095-one-off-commands-and-their-history.md) (the one-off history, its
  secret test and its file pattern), [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md)
  (the crew link forwards, it does not copy), [ADR 0086](./0086-reads-need-the-pairing-token.md) (reads
  need the pairing token), [ADR 0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md)
  (what Collie keeps of typed input).
- **Trail:** M61 "Sent" README, Altan's four decisions of 2026-10-17, which turned down three other
  roads: a history of every prompt, agents included; one merged copy on the lead; and a masked row for
  a secret line · `bridge/sent.ts` · `bridge/secret-line.ts` · `bridge/surface/protocol.ts`
  (`SendDeps.blindSent`) · `bridge/server.ts` (`serveSentRoute`, `sentMembersOf`, `launch`) ·
  `bridge/crew/forward.ts` · `bridge/config-schema.ts` (`COLLIE_SENT`) · `bridge/sent.test.ts`

## Context

People asked for a command history like atuin: the lines they sent through Collie, searchable, one
tap from the composer. Three other roads were on the table, and each one comes back.

- **Keep every prompt, agents included.** A prompt to an agent is a conversation, and the agent's own
  log already holds it. The History page reads that log. A second copy would be a second, weaker
  History, and the name "History" is taken.
- **Keep one merged copy on the lead.** It makes the lead a store of every member's lines, and a
  copy that a member's own remove or clear cannot reach. The crew link carries runtime data; it is
  not a sync channel (ADR 0013).
- **Keep a secret line as a masked row, or count it.** A masked row still says that a secret was
  typed, when and where. A counter says the same with less detail. The person gains nothing from
  either.

## Decision

**Each machine keeps its own record of the shell lines sent through Collie, in `<stateDir>/sent.jsonl`.
A crew lead reads its members over a forwardable route and keeps no copy. A line that looks secret
leaves no trace.**

1. **Scope: shell lines only.** A line is kept when it went to a pane the bridge reads as a bare
   shell (`kind: "shell"`, the list the snapshot's `shellPanes` comes from), or as a one-off run from
   the New page. Prompts to agents, programs, and panes with an agent Collie has no profile for stay
   out. Keys, the Keys board and Type mode never record.
2. **The record point is after the fact, on the machine that owns the pane.** The Send Protocol's
   blind send records once the text went in, Enter went out and the receipt says `sent`. A refusal, a
   text not submitted, a held send, a cancel and a replay record nothing. A one-off run records once
   the line was typed and Enter sent. The lead never records a forwarded send.
3. **The skip rules, shared with ADR 0095** (`bridge/secret-line.ts`). A line is not kept when it
   starts with a space or a tab (on the raw text, before any trim), is empty, holds a line break, is
   longer than 4096 characters, `looksSecret`, or would change under the outbound mask
   (`bridge/redact.ts`). `COLLIE_SENT=off` keeps nothing. A skipped line leaves no record, no counter
   and no log line with its text.
4. **The file.** One JSON record per line, `{"v":1,"line","cwd","at","kind"}`, appended, mode 0600 in
   a 0700 folder, absent until the first line is kept. Past 5500 records it is rewritten atomically
   with the newest 5000; no record older than 365 days survives a rewrite or a read. A line that does
   not parse is skipped, and another `v` reads as absent.
5. **The wire.** `GET /api/sent` reads, with `scope`, `cwd`, `q`, `limit` and `before`. Repeats of a
   line merge into one entry per machine, with the newest record and a count. `POST /api/sent/remove`
   and `/api/sent/clear` are idempotent writes. All three need the paired token, are forwardable with
   `?host=`, and send every line through the mask on the way out. The two writes are audited with a
   count and the request id, never the line or its id.
6. **The lead's merge.** `scope=all` on a lead asks each member the same read with `scope=here`, in
   parallel, 2 s each. A 404 is a member on an older Collie, a refused link is `unreachable`, and the
   clock is `timeout`. The lead masks each member line again, and stores none of it.

## Consequences

- A person can find and resend a shell line from the phone without a shell history file, on each
  machine of a crew.
- Each state folder gains one file, written by use only. A remove or a clear on a machine reaches
  everything that machine kept, because nothing was copied.
- The skip rules are a guess. A password passed as a plain argument, such as `mysql -pPASS`, and any
  secret with no known shape are kept. The docs say so, and say how to keep a line out with a leading
  space. Nothing here may be described as keeping no secret.
- A paired device can read the record, as it can already read every pane where those lines were
  typed. The file sits at 0600 beside the audit log.
- To revisit: if people want agent prompts searchable, the answer is a search over the agents' own
  logs, not a wider Sent.

## Addendum 2026-10-26: a pane where an agent is starting is not a shell

Point 1 takes a pane "the bridge reads as a bare shell", and the Send Protocol sends to such a pane
blind: the text, then Enter. An agent is not up at once. OMP 18.12.6 takes about twenty seconds to draw
its input box, and for the first seconds the multiplexer still names no agent. A send in that gap was
typed into the shell, answered `sent`, and the text later sat in the agent's box as an unsent draft that
refused the next sends `draft_present` (omp gang tester 15, and gang three S3 on 18.6.1 and 18.12.6).
Commit fb3a0a87a closed it for an agent the bridge launched itself (`POST /api/launch`). A person typing
`omp` in a shell, a crew script and the multiplexer's own launcher were left out, and that is the common
case.

**The launch window is a property of the pane's process, not of who started it.** `bridge/launch-window.ts`
holds one window per pane, opened by any of three sources:

1. **launch:** the bridge typed a harness's line into a pane it created. This covers the gap before the
   process exists.
2. **process:** a send to a pane with no profile of its own reads the pane's foreground processes
   (`MuxAdapter.foregroundProcesses`, bounded at 1.5 s), and one of them is a harness binary. The
   binaries are the profiles' `identity.binary`. A script run by an interpreter (`bun …/omp`) is
   matched by its first plain argument.
3. **agent:** a poll finds the multiplexer naming a harness on a pane it named otherwise, or did not list,
   on the poll before. The first poll a bridge sees is a baseline and opens nothing.

While the window is open, a send reads the screen with that harness's profile. With the harness's box on
screen it runs the normal steps. With none it ends `refused(probe_failed)` before any key, probe
included: "The pane shows no <harness> input box yet; it may still be starting. Nothing was typed." On a
pane the multiplexer already names, a dialog its profile lifts keeps its own path. The window ends when
the harness's box takes a key (a send's probe shows in it) or the poll's Surface reads the box, after
120 s, or when the harness leaves the pane (a plain shell in the foreground after the process was seen,
or the multiplexer no longer names it). A window that ended does not open again for the same harness on
the same pane until it leaves. Nothing in `bridge/surface/` names a harness.

**A drawn box is not yet a box that reads keys** (gang three tester 3, 2026-10-26). OMP 18.12.6 draws its
box about twenty seconds before it reads a key. A send in that gap typed its probe character, the probe
never showed, and once omp woke it showed the buffered `⌁` as a draft that refused every later send
`draft_present`. So, in the window, every send is probed. A probe that never shows ends
`refused(probe_failed)` with the window's words ("it may still be starting") and presses no Backspace,
since a Backspace would wait in the terminal too and could land in a person's text later. The window
stays open: the poll's box read no longer ends it, and a window that read had ended opens again inside the
bound it opened with. The window counts the probe characters that may still show. Collie's probe
character is Collie's own residue (`bridge/surface/probe-marker.ts`): a box whose whole text is one or
more probe characters and nothing else is no person's draft. A send, a command, Add to it, Replace,
Discard and Clear take out exactly those characters, one Backspace each, and go on from a read that shows
the box empty, or stop with a refusal that says so. A probe character beside any other text is never
taken out.

**At most one probe character unaccounted for per pane** (live checks of 1.24.1, W2, 2026-10-26). On omp
18.6.1 a send at +0.3 s and one at +0.7 s each typed a probe into a box that did not read keys yet, and
the box later showed `⌁⌁`. A probe typed into the box of a harness that is starting, with no Backspace
after it, now counts as pending in the window (`LaunchWindow.pending`): the deaf box, a probe that showed
outside the box (the tty's echo), and a probe a stale-screen read never found. While one is pending, a
send, a command, Add to it and Replace type no probe. A new request is refused `probe_failed` before any
key, with the window's words and "Nothing was typed: Collie's earlier probe character has not shown in
the box yet". A starting pane refuses a new send; it does not hold it. A send already held waits: the
hold queue does not release while the character has not shown, and a release that meets the box still
starting goes back to its place without spending a try. Once the character shows, the residue rule
takes it out and the send goes. The count ends with the window: the first probe that shows, the 120 s
bound, or the harness leaving. Each character also blocks for at most 30 s (the next paragraph).

**A pending probe character blocks for 30 s, not for the window** (counsel review of 1.24.1,
2026-10-26). A character that never shows (a program that flushes its input as it starts) kept every
send refused and every held send waiting for the launch window's 120 s. Each pending character now
blocks only for `PENDING_PROBE_MS`, 30 s from the moment it was typed (the deaf gap seen live was about
20 s on omp 18.12.6). Past that the next send types one new probe, which is how Collie learns the box
reads keys now, and a held send goes on the next free poll. The character still counts for the window:
a box read alone does not end it, only a probe that shows or the 120 s bound. A character that shows
later is still taken out by the residue rule, which never depended on the count. The count is memory:
after a bridge restart it is 0, and a character that shows then is residue like any other.

**A refusal after a Backspace no read confirmed says what is true** (live check W2, 9 of 14 runs). A
send at +0.7 s typed its probe, the box showed it, Collie pressed Backspace, and no read in the probe's
budget showed the box back; the refusal said "Backspace did not give the box back as it was", while the
box read empty and idle a moment later. The decision stands: refused `probe_failed`, keys `[probe,
Backspace]`. Where the reads are no proof the box is wrong (the pane is starting, or no read after
Backspace found the box), the detail now says "Collie could not confirm the box was clean after its
probe character (⌁). Nothing was sent. Send again in a moment." A pane that is not starting and whose
box still shows the probe keeps the old words. The probe's budget (three reads, 900 ms, shared by the
character and its Backspace) is the likely reason a starting box that redraws is not read back in time;
widening it for a starting pane is not done here.

**The multiplexer naming the agent mid-send is not another program.** A send reads the pane with a
profile, from the pane itself or from the window. When the pane's generation then moves to an agent that
profile names, for example shell to omp or a session id that resolves, the send goes on. Any other move
still ends it `changed` (after the text) or `pane_gone` (before it): another harness, a shell again, the
pane gone, or a pane with no profile.
A held send follows the same rule while it waits: a pane that moves to an agent the held send's profile
names keeps the hold, which takes the new generation and that agent as its harness, and any other move ends it `pane_gone`.

**What stays on the blind road.** For about the first second after a person types the agent's command
into a shell, the shell itself is still the pane's foreground process, so a send then is a blind send to
a shell (gang three, rows u and u2: +0.2 to +0.8 s): there is no evidence yet that a harness is starting,
and point 1 holds for a pane that reads as a shell.

It fails open where the evidence is missing. A plain shell in the foreground keeps the blind send and
its Sent record. A foreground read that fails, refuses or runs slow counts as none. tmux, zellij and
tuios have no foreground read today, so on them only the launch and agent sources open a window. tmux's
`pane_current_command` is the program's name, which is `bun` or `node` for a harness shipped as a script,
so it is not used. A send refused in the window records nothing in Sent, as any refusal.
