import { describe, expect, it } from "vitest";
import { en } from "../i18n/messages/en";
import { noteKey, readSend, STEP_BUTTONS, type SendReply } from "../send-protocol";
import { ANOTHER_SEND, offersFor, REQUEST_ID, reservedLead, SEND_CAUSES, SEND_MODES, SEND_OUTCOMES, SEND_REASONS, sendLines, takesManualSend, wsFree, type SendCause, type SendOutcome, type SendReason } from "./send";
import type { Surface } from "./surface";

describe("sendLines", () => {
  it("splits on every line break and drops trailing blank lines, keeping the empty ones in between", () => {
    expect(sendLines("one\r\ntwo\n\nthree\n\n  \n")).toEqual(["one", "two", "", "three"]);
  });

  it("cuts paste markers, turns a Tab into one space and drops every other control byte", () => {
    expect(sendLines("\u001b[200~a\tb\u0007c\u007fd\u009be\u001b[201~")).toEqual(["a bcde"]);
  });

  it("keeps every printable character, wide ones and emoji included", () => {
    expect(sendLines("Grüße ✓ 日本 🙂")).toEqual(["Grüße ✓ 日本 🙂"]);
  });
});

describe("reservedLead", () => {
  it("finds a lead after leading blanks, and nothing in the middle of the text", () => {
    expect(reservedLead("  /model", ["/", "!", "@"])).toBe("/");
    expect(reservedLead("see @file", ["/", "!", "@"])).toBeNull();
  });

  const leads = ["/", "!", "@"];
  const upload = "/home/me/.local/state/collie-next/uploads/w7C_pF-mvtrpn7j-e4f81595.png";

  it("does not read the path of a saved upload as a slash command", () => {
    expect(reservedLead(upload, leads)).toBeNull();
    expect(reservedLead(`  ${upload}`, leads)).toBeNull();
    expect(reservedLead(`${upload} what is wrong here?`, leads)).toBeNull();
    expect(reservedLead(`${upload}\nsecond line`, leads)).toBeNull();
    expect(reservedLead("/tmp/state/uploads/1-mvtrpn7j-e4f81595.txt", leads)).toBeNull();
  });

  it("keeps every real command shape reserved", () => {
    expect(reservedLead("/compact", leads)).toBe("/");
    expect(reservedLead("/help", leads)).toBe("/");
    expect(reservedLead("/model opus", leads)).toBe("/");
    expect(reservedLead("/clear", leads)).toBe("/");
    expect(reservedLead("/usr", leads)).toBe("/");
    expect(reservedLead("/usr/uploads", leads)).toBe("/");
  });

  it("reads a path that only looks like an upload as a command, and the lead after it as text", () => {
    expect(reservedLead("/home/me/uploads/photo.png", leads)).toBe("/");
    expect(reservedLead("/home/me/other/w7C_pF-mvtrpn7j-e4f81595.png", leads)).toBe("/");
    expect(reservedLead("/uploads/w7C_pF-mvtrpn7j-e4f81595.png/extra", leads)).toBe("/");
    expect(reservedLead(`/compact ${upload}`, leads)).toBe("/");
    expect(reservedLead(`!${upload}`, leads)).toBe("!");
  });

  it("takes a saved-upload path that no longer exists on disk as an upload, since the check is the shape", () => {
    expect(reservedLead("/gone/uploads/x-aaaaaaa-00000000.webp", leads)).toBeNull();
  });
});

describe("offersFor", () => {
  it("offers append, replace and cancel on a framed draft, and the key pad without a frame", () => {
    expect(offersFor("refused", "draft_present", true)).toEqual(["append", "replace", "cancel"]);
    expect(offersFor("refused", "draft_present", false)).toEqual(["keys"]);
  });

  it("offers a command onto a framed draft Replace and Cancel only, and the key pad without a frame", () => {
    expect(offersFor("refused", "draft_present", true, true)).toEqual(["replace", "cancel"]);
    expect(offersFor("refused", "draft_present", false, true)).toEqual(["keys"]);
  });

  it("offers submit and discard on every typed_not_submitted, with a frame or without", () => {
    expect(offersFor("typed_not_submitted", "changed", true)).toEqual(["submit", "discard", "keys"]);
    expect(offersFor("typed_not_submitted", "changed", false)).toEqual(["submit", "discard", "keys"]);
    expect(offersFor("typed_not_submitted", "mismatch", false)).toEqual(["submit", "discard", "keys"]);
  });

  it("offers the commit tap on unconfirmed, nothing after a send", () => {
    expect(offersFor("refused", "unconfirmed", false)).toEqual(["commit", "keys"]);
    expect(offersFor("sent", undefined, true)).toEqual([]);
  });
});

describe("the closed lists", () => {
  it("a request id names a file only when it is a plain token", () => {
    expect(REQUEST_ID.test("a1b2c3d4-e5f6")).toBe(true);
    expect(REQUEST_ID.test("../../x")).toBe(false);
    expect(REQUEST_ID.test("short")).toBe(false);
  });

  it("no reason appears twice", () => {
    expect(new Set(SEND_REASONS).size).toBe(SEND_REASONS.length);
  });

  it("wsFree removes every white-space character", () => {
    expect(wsFree(" a b\n c\t")).toBe("abc");
  });
});

describe("takesManualSend (M56 spec 06)", () => {
  const at = (over: Partial<Surface>): Surface => ({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", ...over });

  it("opens on unknown(no-match), on a weak cue and on an unreadable overlay", () => {
    expect(takesManualSend(at({ reason: "no-match" }))).toBe(true);
    expect(takesManualSend(at({ turn: "idle", composer: "empty" }))).toBe(true);
    expect(takesManualSend(at({ modal: "unreadable" }))).toBe(true);
    expect(takesManualSend(at({ turn: "idle", modal: "unreadable", composer: "empty" }))).toBe(true);
  });

  it("stays closed on a free box, an ask, a draft, a running turn, a box out of reach, and a read that is stale, torn or contested", () => {
    expect(takesManualSend(at({ turn: "idle", modal: "none", composer: "empty" }))).toBe(false);
    expect(takesManualSend(at({ modal: { ask: { id: "a", kind: "menu", options: [], channel: "keys", hash: "h" } } }))).toBe(false);
    expect(takesManualSend(at({ composer: "draft" }))).toBe(false);
    expect(takesManualSend(at({ turn: "running", modal: "unreadable" }))).toBe(false);
    expect(takesManualSend(at({ composer: "unreachable" }))).toBe(false);
    for (const reason of ["stale", "torn", "contested"] as const) expect(takesManualSend(at({ reason }))).toBe(false);
  });

  it("the modes include command, for a text with a reserved lead", () => {
    expect(SEND_MODES).toContain("command");
  });
});

// M102 spec 02: every pair of the closed lists that can reach a stop card names its next step, and the
// card has an action that changes the situation. A new reason, cause or outcome cannot ship as a dead end:
// `nextStep` is total, and this walk fails on the first pair it leaves without a step or a sentence
// without one. The table behind it: experiments/m102/refusal-table.md.
describe("no dead end: every refusal names its next step (M102 spec 02)", () => {
  const surfaceOf = (over: Partial<Surface>): Surface => ({ revision: 7, turn: "idle", modal: "none", composer: "empty", ...over });
  const SURFACES: readonly (Surface | null)[] = [
    null,
    surfaceOf({}),
    surfaceOf({ turn: "running" }),
    surfaceOf({ composer: "draft" }),
    surfaceOf({ modal: "unreadable" }),
    surfaceOf({ modal: "unknown", composer: "unknown" }),
    surfaceOf({ composer: "unreachable" }),
    surfaceOf({ reason: "stale" }),
  ];
  const CAUSES: readonly (SendCause | null)[] = [null, ...SEND_CAUSES];
  // The ends that block nothing: the text went, the box was emptied on purpose, or a held send ended
  // on its own card (ADR 0122, which has its Resend and Dismiss).
  const NOT_A_STOP: ReadonlySet<SendOutcome> = new Set<SendOutcome>(["sent", "effective", "steered", "discarded", "held", "expired", "cancelled"]);
  // A gone pane: nothing on this pane can change it. Its sentence still says the draft stays and to go back.
  const NO_BUTTON: ReadonlySet<SendReason> = new Set<SendReason>(["pane_gone"]);
  // A next step is a sentence that starts with what the person does.
  const STEP_WORDS = /(?:^|[.!?] )(?:Send|Answer|Add|Replace|Submit|Look|Read|Check|Change|Stop|Empty|Get|Go|Wait|Try|Use|Tap|Select|Close|Then send)\b/u;

  const pairs = SEND_OUTCOMES.flatMap((outcome) =>
    [null, ...SEND_REASONS].flatMap((reason) =>
      [true, false].flatMap((framed) => [false, true].map((command) => ({ outcome, reason, framed, command }))),
    ),
  );

  it.each(pairs)("no dead end: $outcome / $reason (framed $framed, command $command)", ({ outcome, reason, framed, command }) => {
    for (const surface of SURFACES) {
      for (const cause of CAUSES) {
        const reply: SendReply = {
          outcome,
          reason,
          offers: offersFor(outcome, reason ?? undefined, framed, command),
          rowsHash: null,
          replayed: false,
          surface,
          detail: reason === "busy" ? ANOTHER_SEND : null,
          cap: null,
          queued: false,
          cause,
        };
        const reading = readSend(reply);
        if (reading.clear || NOT_A_STOP.has(outcome)) continue;
        const where = `${outcome}/${String(reason)}/${String(cause)}/${surface === null ? "no surface" : JSON.stringify(surface)}`;
        // An action that changes the situation: Open Keys alone never counts, and a step's button is
        // always one of the strip's offers, the card, a step button or the person's own field.
        if (!(reason !== null && NO_BUTTON.has(reason))) {
          expect(reading.step, where).not.toBeNull();
          if (reading.step === "offers") expect(reading.offers.length, where).toBeGreaterThan(0);
          if (reading.step === "card") expect(reading.toCard, where).toBe(true);
          if (reading.step !== null && reading.step !== "offers" && reading.step !== "card" && reading.step !== "field") {
            expect(STEP_BUTTONS, where).toContain(reading.step);
          }
        }
        // The sentence ends on what the person can do.
        const sentence = en[noteKey(reading.note)];
        expect(sentence, where).toMatch(STEP_WORDS);
      }
    }
  });

  it("no dead end: Send again waits only for the other running send, and a full queue keeps its line", () => {
    const busy = (detail: string): SendReply => ({ outcome: "refused", reason: "busy", offers: ["keys"], rowsHash: null, replayed: false, surface: null, detail, cap: null, queued: false, cause: null });
    expect(readSend(busy(ANOTHER_SEND))).toMatchObject({ step: "sendAgain", waits: true, detail: null });
    const full = readSend(busy("This pane already holds 5 messages. Cancel one, or wait for the turn to end."));
    expect(full).toMatchObject({ step: "sendAgain", waits: false });
    expect(full.detail).toContain("already holds 5 messages");
  });

  it("no dead end: a draft with no Add, Replace or Cancel offers Empty the box, and its sentence says the draft is deleted", () => {
    const reading = readSend({ outcome: "refused", reason: "draft_present", offers: ["keys"], rowsHash: null, replayed: false, surface: null, detail: null, cap: null, queued: false, cause: null });
    expect(reading).toMatchObject({ note: "draftUnseen", step: "emptyBox", offers: [] });
    expect(en["composer.protocol.draftUnseen"]).toMatch(/deletes that draft/u);
  });

  it("no dead end: a step's button never repeats the card, and the Keys offer is never the only way", () => {
    for (const step of STEP_BUTTONS) expect(["offers", "card", "field"]).not.toContain(step);
  });
});
