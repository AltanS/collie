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
