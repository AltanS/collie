# 0102: starters are launcher rows

- **Status:** Accepted
- **Date:** 2026-10-12
- **Shipped in:** pending (1.21.0)
- **Trail:** a durable agent program (Pi Durable) that offers named ways to begin a conversation ·
  `bridge/server.ts` (`launchersRoute`, the `/api/launchers` and `/api/launch` routes) ·
  `bridge/harness-launch.ts` · `bridge/launch-receipts.ts` · `bridge/worktree-receipts.ts` ·
  `web/src/routes/new.tsx` · [ADR 0091](./0091-launch-by-id-with-a-request-id.md) ·
  [ADR 0094](./0094-launchers-added-from-a-phone.md) ·
  [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) ·
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) ·
  [ADR 0101](./0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md)

## Context

A durable program usually has a few named ways to begin: a code review, a research task, a plain
chat. Call them starters. A person should be able to start one from the New page on the phone, on
the machine where the program runs.

The New page already lists what a machine can start and starts it by id with a receipt (ADR 0091).
The rows come from `GET /api/launchers`, which the crew forwards with `?host=` so each machine
reports its own. A launch is `POST /api/launch`, with a request id so a retry never starts a second
agent. A second list, a second route, or a second receipt for starters would give the phone two
places to look and two ways to double-start.

A starter is not a command line. Some programs rerun a starter on a repeated call, so the repeat
rule must live in the bridge and not in the program.

## Decision

**A starter is a launcher row. It rides the routes that launchers already use, with the same
receipt.**

1. **The adapter reports starters.** The `durable` adapter gives the bridge the program's starters
   as an id and a label each. The bridge lists them on `GET /api/launchers`, per
   machine, in the same list as the other rows. A body without them is a bridge that has none.
2. **A start is `POST /api/launch`.** The body names the starter by id, with a request id minted on
   the phone. The phone never sends a command line or a path to run. An unknown id is refused
   before anything reaches the program.
3. **The ADR 0091 receipt applies.** The bridge writes it before the start leaves for the program,
   and passes the request id on the socket. A repeat of the same id returns the stored pane and
   starts nothing.
4. **The existing rules for rows still hold.** A starter shows under the existing "No prompts" badge
   rules and the same operator switches as any row. An operator who turns rows off turns starters
   off too.
5. **The new conversation is a pane.** The reply to a start names the pane id, and the pane appears
   in the next census as Chat only (ADR 0099).
6. **A crew member starts its own.** The request goes to the member that owns the program, through
   the existing forward. The receipt lives where the pane was made.

## Consequences

- The New page needs no new control. A starter is a row, and it works wherever rows work.
- The phone keeps one idea of "start something", with one retry rule.
- The program's own repeat handling stops being a safety net the bridge relies on. A program that
  reruns a repeated start does no harm, because the bridge never sends the repeat.
- A starter that needs input, such as a folder or a prompt, is not covered. It would be a new
  decision about what the page may send. This one lets a person start a named thing, and nothing
  more.
