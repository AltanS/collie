import { describe, expect, it } from "vitest";

import { SEND_OUTCOMES, SEND_REASONS, type SendOutcome, type SendReason } from "../surface/send";
import { closeOffer, NO_TROUBLE, noteSettled, offersReport, TROUBLE_THRESHOLD, TROUBLE_WINDOW_MS, troubleFrom, troubleStep, type SettledSend } from "./trouble";

let n = 0;
function send(outcome: SendOutcome, reason: SendReason | null, extra: Partial<SettledSend> = {}): SettledSend {
  n += 1;
  return { requestId: `req-${String(n).padStart(6, "0")}`, outcome, reason, at: 1_000_000 + n * 1000, ...extra };
}

describe("troubleStep: the reason table (ADR 0123)", () => {
  it.each([
    ["effective", null, "reset"],
    ["sent", null, "reset"],
    ["steered", null, "reset"],
    ["refused", "probe_failed", "count"],
    ["refused", "not_free", "count"],
    ["refused", "unconfirmed", "count"],
    ["refused", "stale_surface", "count"],
    ["refused", "bound", "count"],
    ["refused", "write_failed", "count"],
    ["typed_not_submitted", "mismatch", "count"],
    ["typed_not_submitted", "changed", "count"],
    ["typed_not_submitted", "modal_cue", "count"],
    ["typed_not_submitted", "stale_token", "count"],
    ["typed_not_submitted", "submit_failed", "count"],
    ["typed_not_submitted", "unreadable", "count"],
    ["typed_not_submitted", null, "count"],
    ["unknown", "crash", "count"],
    ["unknown", "lost_lock", "count"],
    ["unknown", "no_evidence", "count"],
    ["unknown", null, "count"],
    ["refused", "busy", "ignore"],
    ["refused", "turn_running", "ignore"],
    ["refused", "draft_present", "ignore"],
    ["refused", "pane_gone", "ignore"],
    ["refused", "multiline", "ignore"],
    ["refused", "reserved_lead", "ignore"],
    ["refused", "id_reused", "ignore"],
    ["refused", "steer_unsupported", "ignore"],
    ["refused", "steer_not_allowed", "ignore"],
    ["typed_not_submitted", "dialog_open", "ignore"],
    ["unknown", "dialog_after_enter", "ignore"],
    ["held", "turn_running", "ignore"],
    ["cancelled", null, "ignore"],
    ["discarded", null, "ignore"],
    ["expired", null, "ignore"],
  ] as const)("%s/%s %s", (outcome, reason, step) => {
    expect(troubleStep({ outcome, reason })).toBe(step);
  });

  it("the cap's unconfirmed is a confirm the person owes, never a failure", () => {
    expect(troubleStep({ outcome: "refused", reason: "unconfirmed", cap: true })).toBe("ignore");
  });

  it("answers every outcome and reason the protocol names, and names no harness", () => {
    for (const outcome of SEND_OUTCOMES) for (const reason of [null, ...SEND_REASONS]) expect(["reset", "count", "ignore"]).toContain(troubleStep({ outcome, reason }));
  });
});

describe("noteSettled: the streak", () => {
  it(`offers the report on the ${String(TROUBLE_THRESHOLD)}rd counted failure in a row, not before`, () => {
    let trouble = NO_TROUBLE;
    trouble = noteSettled(trouble, send("refused", "probe_failed"));
    trouble = noteSettled(trouble, send("typed_not_submitted", "mismatch"));
    expect(offersReport(trouble)).toBe(false);
    trouble = noteSettled(trouble, send("unknown", "no_evidence"));
    expect(offersReport(trouble)).toBe(true);
    expect(trouble.sends).toHaveLength(3);
  });

  it("a success ends the streak", () => {
    const trouble = troubleFrom([send("refused", "probe_failed"), send("refused", "probe_failed"), send("sent", null), send("refused", "probe_failed")]);
    expect(trouble.sends).toHaveLength(1);
    expect(offersReport(trouble)).toBe(false);
    expect(troubleFrom([send("refused", "probe_failed"), send("refused", "probe_failed"), send("refused", "probe_failed"), send("effective", null)])).toBe(NO_TROUBLE);
  });

  it("draft_present, turn_running and a held send neither count nor reset", () => {
    const trouble = troubleFrom([
      send("refused", "probe_failed"),
      send("refused", "draft_present"),
      send("refused", "turn_running"),
      send("held", "turn_running"),
      send("refused", "probe_failed"),
    ]);
    expect(trouble.sends).toHaveLength(2);
    expect(offersReport(trouble)).toBe(false);
  });

  it("a retry under the same request id counts once", () => {
    const first = send("unknown", "no_evidence");
    const trouble = troubleFrom([first, { ...first, at: first.at + 500 }, { ...first, at: first.at + 900 }]);
    expect(trouble.sends).toHaveLength(1);
    expect(offersReport(trouble)).toBe(false);
  });

  it("a failure more than ten minutes after the last one starts a new streak", () => {
    const a = send("refused", "probe_failed");
    const b = send("refused", "probe_failed", { at: a.at + 1000 });
    const late = send("refused", "probe_failed", { at: b.at + TROUBLE_WINDOW_MS + 1 });
    expect(troubleFrom([a, b, late]).sends).toEqual([late]);
  });

  it("closing the card keeps it closed until the streak ends, then a new streak offers again", () => {
    let trouble = troubleFrom([send("refused", "probe_failed"), send("refused", "probe_failed"), send("refused", "probe_failed")]);
    trouble = closeOffer(trouble);
    expect(offersReport(trouble)).toBe(false);
    trouble = noteSettled(trouble, send("refused", "probe_failed"));
    expect(offersReport(trouble)).toBe(false);
    trouble = noteSettled(trouble, send("sent", null));
    for (let i = 0; i < 3; i++) trouble = noteSettled(trouble, send("refused", "write_failed"));
    expect(offersReport(trouble)).toBe(true);
  });

  it("closing with no offer changes nothing", () => {
    const trouble = troubleFrom([send("refused", "probe_failed")]);
    expect(closeOffer(trouble)).toBe(trouble);
  });
});
