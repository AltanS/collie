// Updates: the upstream check, the digest snooze, the band's dismiss, the card's read, and starting
// an update from the phone (M15/05). The three POSTs that manage notices and the card's GET are
// read-level; starting an update is a WRITE.

import { createController } from "remix/router";
import { apiError } from "../../error-codes.ts";
import type { JsonValue } from "../../json.ts";
import { UPDATE_ON_DEMAND_POLL_TIMEOUT_MS } from "../../server.ts";
import { parseUpdateStartRequest, updateStartVerdict } from "../../update-action.ts";
import type { BridgeHttp } from "../deps.ts";
import { gate } from "../middleware/guard.ts";
import { json, jsonError, text } from "../respond.ts";
import { routes } from "../routes.ts";

export function updateController(deps: BridgeHttp) {
  const { opts, updateMonitor, audit, whois, updateStatusWithPeers } = deps;
  return createController(routes.update, {
    actions: {
      check: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // Force an immediate upstream check (the "check for updates" button), instead of waiting for
          // the periodic timer. Read-level — checking a version isn't terminal-driving — and idempotent
          // (the monitor de-dupes concurrent checks). Returns the fresh status the client revalidates on.
          await updateMonitor.checkRelease();
          return json(updateMonitor.status(), req.headers.get("accept-encoding"));
        },
      },
      snooze: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // "Remind me next digest" — dismisses the CURRENT update push without touching the `updates`
          // pref, which stays the only off switch. Read-level like the notification snooze: managing
          // your own notifications isn't terminal-driving. The banner keeps showing; only the push waits.
          await updateMonitor.snoozeDigest();
          return json(updateMonitor.status(), req.headers.get("accept-encoding"));
        },
      },
      dismiss: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // The update band was closed, for the version it named, in the scope it was closed in. The
          // version is recorded on the bridge rather than in the browser that closed it, so the band
          // stays down wherever it is read next (M17/08). Closing THIS host's offer also snoozes the
          // digest, in the monitor's one write — hiding a notice about another machine does not.
          //
          // Read-level, exactly like the snooze beside it: declining a notification about your own
          // machine isn't terminal-driving. Not a mute either — `updatesEnabled()` stays the only off
          // switch, and a NEWER release raises the band again.
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction; the version is checked
            // for being a non-empty string below before anything is written.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad request", 400);
          }
          const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
          const version = record === null ? undefined : record.version;
          if (typeof version !== "string" || version.trim() === "") return text("bad version", 400);
          // WHICH band, because they are two decisions: the offer this host was given, and the quiet
          // notice about a machine a package manager owns. Absent reads as the offer, which is what
          // every client before the crew states could close.
          //
          const scope = record === null ? undefined : record.scope;
          if (scope !== undefined && scope !== "offer" && scope !== "crew") {
            return text("bad scope", 400);
          }
          await updateMonitor.dismiss(version, scope ?? "offer");
          return json(updateMonitor.status(), req.headers.get("accept-encoding"));
        },
      },
      // `GET /api/update/check`: the card's own read. A GET because it is a read in the strictest
      // sense — it starts nothing, takes no upstream look and mutates no state.
      status: {
        middleware: [gate(deps, "read")],
        async handler({ request: req }) {
          // The card's own read: everything `POST /api/update/check` answers, plus the PREFLIGHT that
          // decides whether the update button is live and what it says when it is not (M15/05).
          //
          // A GET because it is a read in the strictest sense — it starts nothing, takes no upstream
          // look and mutates no state — and read-gated for the same reason the snapshot is. It is safe
          // to poll: the preflight behind it is cached (bridge/update-action.ts), so a phone sitting on
          // the settings screen costs one `collie update --check` a minute at most.
          //
          // It is deliberately NOT folded into the snapshot. The snapshot is polled by every open
          // client on a burst cadence, and the preflight shells out to git and to `doctor`; paying that
          // on every poll for a card nobody has opened is the wrong trade.
          // Right after a restart `latest` is null until the monitor's own first poll — deliberately
          // delayed so the bridge never probes the network mid-boot (bridge/index.ts). A card opened in
          // that window must not print "isn't known yet" over a healthy network just because it read a
          // second too early, so THIS read triggers the SAME poll the timer would eventually run
          // (`checkRelease` de-dupes, so a concurrent timer tick or a second tab awaits the one fetch)
          // and waits a bounded moment for it. Once `latest` is set — success or a settled failure — this
          // never fires again; a persistently offline network still answers within the bound, unchanged.
          if (updateMonitor.status().latest === null) {
            await Promise.race([
              updateMonitor.checkRelease(),
              new Promise<void>((resolve) => setTimeout(resolve, UPDATE_ON_DEMAND_POLL_TIMEOUT_MS)),
            ]);
          }
          // ── THE CREW'S HALF (M16/03) ────────────────────────────────────────
          // The same on-demand shape, one line lower: six hours is the right cadence for a background
          // fact and the wrong one for a page the operator is looking at, so this read fires ONE
          // immediate sweep carrying `X-Crew-Preflight: fresh` and waits the same bounded moment for
          // it. Past the bound the answer is what the lead already has — a stale `asOf`, never a
          // fabricated green — and a peer that ignores the header is a correct peer.
          //
          // The peer's own `PREFLIGHT_TTL_MS` is what keeps this cheap: the header is honoured at most
          // once a minute per member, so a phone sitting on the page cannot make a peer shell out to
          // git and `doctor` on every poll.
          const freshSweep = opts.crewLead?.sweep({ freshPreflight: true });
          if (freshSweep !== undefined) {
            await Promise.race([
              freshSweep,
              new Promise<void>((resolve) => setTimeout(resolve, UPDATE_ON_DEMAND_POLL_TIMEOUT_MS)),
            ]);
          }
          const report = opts.updateAction ? await opts.updateAction.preflight() : null;
          // `preflight: null` is a fact the card renders ("could not be checked"), not an omission —
          // the key is always present so the phone can tell "not checked" from "old bridge". `crew`
          // follows the same rule: `[]` on a solo instance and on a peer, never absent. It is composed
          // from what the sweep BANKED (`CrewLead.updateRows`) and dials nobody — `status-wire.ts`'s
          // purity argument, one route over.
          return json(
            { ...updateStatusWithPeers(), preflight: report, crew: opts.crewLead?.updateRows() ?? [] },
            req.headers.get("accept-encoding"),
          );
        },
      },
      // `POST /api/update`, and no other method: no GET trigger, no beacon path (ADR 0024). The gate
      // is the browser's write gate, the SAME function a pane write passes (`browserGate`).
      start: {
        middleware: [gate(deps, "write")],
        async handler({ request: req }) {
          // ── STARTING AN UPDATE FROM THE PHONE (M15/05) ──────────────────────
          // A WRITE, through the pane path's own `browserGate` — same host allowlist, same same-origin
          // rule, same device header, same pairing credential. No new authentication concept, and no
          // beacon path: an update is an action, and an action is armed by a named choice of the
          // operator's and by nothing else (ADR 0024).
          const action = opts.updateAction;
          if (!action) return text("update action unavailable", 503);
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction, and
            // `parseUpdateStartRequest` re-checks every field of it before any of it is believed.
            body = (await req.json()) as JsonValue;
          } catch {
            return jsonError(apiError("update.confirm_required"), 400, req.headers.get("accept-encoding"));
          }
          const parsed = parseUpdateStartRequest(body);
          if (parsed === null) {
            return jsonError(apiError("update.confirm_required"), 400, req.headers.get("accept-encoding"));
          }
          // FORCED, never the cached report: the client's disabled button is a courtesy and this is
          // the actual gate, so it asks the machine now rather than trusting a minute-old answer.
          const report = await action.preflight(true);
          const status = updateMonitor.status();
          const verdict = updateStartVerdict(parsed, {
            current: status.current,
            latest: status.latest,
            majorAvailable: status.majorAvailable,
            run: status.run ?? null,
            lockHeld: action.lockHeld(),
            preflight: report,
            // The one gate a green preflight cannot express: a package manager owns this folder, so there is
            // nothing here Collie may replace (ADR 0035).
            installKind: status.installKind,
            // One confirm covers the crew (M16/03): the members' banked verdicts gate this start the
            // same way the lead's own does. Read, never fetched — the sweep is the only thing that
            // talks to a member.
            crew: opts.crewLead?.updateRows() ?? [],
            // And the legs of the last run, which is what "Retry crew update" is about (M16/04).
            peers: opts.crewLead?.updatePeers() ?? [],
            // A crew run still open refuses a second confirm (A5).
            crewRunOpen: opts.crewLead?.updateRunOpen() ?? false,
          });
          if (verdict.kind === "refuse") {
            return jsonError(verdict.body, verdict.status, req.headers.get("accept-encoding"));
          }
          // ONE id per confirm, minted here and nowhere else. It is what the peers' turns carry and
          // what a member that rolled back keys its "not twice" memory on — so a fresh confirm, and
          // only a fresh confirm, permits one further attempt at the same tag.
          const runId = action.newRunId();
          // ── A PEERS-ONLY RUN MOVES NOTHING HERE ────────────────────────────
          // The lead is already current. It starts no updater, spawns nothing and restarts nothing:
          // it opens a run whose only legs are the peers, and the first of §20's three immediate
          // sweeps carries the first turn out.
          if (verdict.kind === "peers") {
            action.beginCrewRun?.({ runId, to: verdict.to });
            audit.record({
              action: "update",
              device: whois(req).device,
              detail: { to: verdict.to, major: false, peersOnly: true },
            });
            return json(
              { ok: true, to: verdict.to, major: false, run: status.run ?? null, runId },
              req.headers.get("accept-encoding"),
              202,
            );
          }
          const started = action.start({ major: verdict.major, runId });
          if (!started.ok) {
            return jsonError(
              apiError("update.start_failed", { reason: started.reason }),
              500,
              req.headers.get("accept-encoding"),
            );
          }
          // The peers ride the SAME confirm and the same id. Their turns are granted once this lead's
          // own health gate settles — a lead that announced a version it has not finished taking would
          // send its whole crew after a release it may itself roll back from (§20).
          action.beginCrewRun?.({ runId, to: verdict.to });
          audit.record({
            action: "update",
            device: whois(req).device,
            detail: { to: verdict.to, major: verdict.major },
          });
          // 202, and the request ENDS HERE. The update stages and then restarts this very process —
          // holding the request open across that would mean answering with a socket that is about to
          // be closed by the thing the request asked for. The card watches the run record instead, on
          // the snapshot it already polls, and on `/standby/update` while this door is shut.
          //
          // `run` is the record as `status` read it BEFORE the start, so on a lead that has updated before
          // it is the LAST run's, and the new run writes its own a beat later. `runId` is how the phone
          // tells the two apart: it names the run this confirm began (2026-09-26, the 1.13.3 update that
          // showed "Update finished" at 0:00 with the old versions).
          return json(
            { ok: true, to: verdict.to, major: verdict.major, run: status.run ?? null, runId },
            req.headers.get("accept-encoding"),
            202,
          );
        },
      },
    },
  });
}
