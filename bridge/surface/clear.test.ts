// Clear (ADR 0116, the Clear paragraph): `POST /api/pane/:id/clear` on a pane with a screen. A fake
// multiplexer shows real captures from the fixture corpus, with a draft typed into the box, and shortens
// the draft as the clear key arrives. Covered: each refusal, `cleared`, the batch loop for a long draft,
// a box that will not empty, the replay rule (one id, one press), the audit line with no text, and the
// route's body checks.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import { muxAck, muxGone, muxOk, muxRefused, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { crewRouteFor } from "../crew/forward.ts";
import { clearRoute, type ClearRouteRuntime } from "../server.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { boundedDraft, CLEAR_DRAFT_MAX_BYTES, type ClearReceipt } from "../../web/src/lib/surface/clear.ts";
import { KeyGate } from "./key-gate.ts";
import { ClearService } from "./clear.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** Grok mid-turn: a plain-text capture whose empty box row reads `│ ❯ ... │`. */
const GROK_BOX = fx("grok--working.txt");
const OMP_APPROVAL = fx("omp--approval-bash.txt");
const NOT_A_SCREEN = "just some words\non a plain screen\n";

/** The capture with `text` typed into its box (one row, padded to the box's width). */
function withDraft(text: string): string {
  return GROK_BOX.replace(/│ ❯ ( +)│/u, (_all, pad: string) => `│ ❯ ${text}${" ".repeat(Math.max(0, pad.length - text.length))}│`);
}

const DRAFT = "half a thought";

/** A pane that shows one capture at a time and shortens its draft as the clear key arrives. */
class ScriptPane {
  keysSeen: string[][] = [];
  reads = 0;
  refuseKeys = false;
  unreadable = false;
  /** What the box holds now; a press of n keys removes up to n characters (never more than `perPress`). */
  draft: string;
  /** The most characters one press removes: a harness that drops some keys. Unlimited by default. */
  perPress = Number.POSITIVE_INFINITY;
  /** When set, a press does nothing: a box that ignores the key. */
  deaf = false;
  /** When set, this screen replaces the box after a press (a dialog the key opened). */
  afterPress: string | null = null;

  constructor(draft: string) {
    this.draft = draft;
  }

  get screen(): string {
    return this.override ?? withDraft(this.draft);
  }

  private override: string | null = null;
  show(screen: string | null): void {
    this.override = screen;
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    if (this.unreadable) return Promise.resolve(muxGone("gone"));
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 0 }));
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    if (this.refuseKeys) return Promise.resolve(muxRefused("refused"));
    this.keysSeen.push([...keys]);
    if (this.afterPress !== null) this.override = this.afterPress;
    else if (!this.deaf) this.draft = this.draft.slice(0, Math.max(0, this.draft.length - Math.min(keys.length, this.perPress)));
    return Promise.resolve(muxAck());
  };
}

interface Rig {
  readonly pane: ScriptPane;
  readonly rt: ClearRouteRuntime;
  readonly lines: string[];
  readonly sleeps: number[];
  readonly pokes: () => number;
  readonly clear: (paneId: string, body: JsonValue | undefined, redact?: boolean) => Promise<Response>;
}

/** Panes: %1 grok, %4 an agent with no profile, %7 a bare shell. */
function rig(draft: string): Rig {
  const pane = new ScriptPane(draft);
  const sleeps: number[] = [];
  const service = new ClearService({
    mux: pane,
    gate: new KeyGate(pane),
    profile: (harness) => Promise.resolve(profileFor(harness, "99.0.0", { log: () => undefined })),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  let pokes = 0;
  const engine = {
    current: () => ({
      agents: [
        { paneId: "%1", agent: "grok" },
        { paneId: "%2", agent: "omp" },
        { paneId: "%4", agent: "an-agent-collie-cannot-read" },
      ],
      shellPanes: [{ paneId: "%7" }],
    }),
    noteInput: () => undefined,
    pokeNow: () => {
      pokes++;
    },
  };
  const rt: ClearRouteRuntime = { clear: service, engine };
  const lines: string[] = [];
  const audit = new AuditLog((line) => void lines.push(line));
  return {
    pane,
    rt,
    lines,
    sleeps,
    pokes: () => pokes,
    clear: (paneId, body, redact = false) => clearRoute(rt, paneId, body, { audit, device: "phone", session: "main", acceptEncoding: null, redact }),
  };
}

async function receipt(res: Response): Promise<ClearReceipt> {
  expect(res.status).toBe(200);
  // SAFETY: the route answers a ClearReceipt as JSON; the tests below compare every field they read.
  return (await res.json()) as ClearReceipt;
}

const ID = "clear-req-0001";

describe("a Clear on a pane with a screen", () => {
  test("the box empties after the press: `cleared`, the profile's own key, length plus slack, one press", async () => {
    const { pane, clear, sleeps, lines, pokes } = rig(DRAFT);
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "cleared", draft: DRAFT });
    // Grok's profile: Backspace, slack 16.
    expect(pane.keysSeen).toHaveLength(1);
    expect(pane.keysSeen[0]).toEqual(Array.from({ length: DRAFT.length + 16 }, () => "Backspace"));
    expect(pane.keysSeen[0]!.includes("Escape")).toBe(false);
    // The first read-back already shows an empty box.
    expect(sleeps).toEqual([120]);
    expect(lines).toHaveLength(1);
    expect(pokes()).toBe(1);
  });

  test("the box reads empty only after a later look: still `cleared`", async () => {
    const { pane, clear, sleeps } = rig(DRAFT);
    // A slow redraw: the box still shows the old text on the first read-back.
    const base = pane.writeKeys;
    pane.writeKeys = async (paneId, keys) => {
      const ack = await base(paneId, keys);
      const gone = pane.draft;
      pane.draft = DRAFT;
      let reads = 0;
      const read = pane.readGrid;
      pane.readGrid = (id, request) => {
        if (++reads === 2) pane.draft = gone;
        return read(id, request);
      };
      return ack;
    };
    expect((await receipt(await clear("%1", { requestId: ID }))).outcome).toBe("cleared");
    expect(sleeps).toEqual([120, 280]);
    expect(pane.keysSeen).toHaveLength(1);
  });

  test("a draft longer than one batch is cleared in rounds, each from a fresh read that shows the box shorter", async () => {
    const long = "x".repeat(300);
    const { pane, clear } = rig(long);
    const original = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      // The fake's full draft is drawn on one row, so the bridge counts all of it.
      pane.show(withDraft(pane.draft));
      return original(paneId, request);
    };
    // The receipt carries the draft the FIRST read showed, not the rest a later round read.
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "cleared", draft: long });
    expect(pane.keysSeen.map((keys) => keys.length)).toEqual([256, 60]);
  });

  test("refused no_profile: a bare shell and an agent Collie has no profile for; no key leaves, no read", async () => {
    for (const paneId of ["%7", "%4"]) {
      const { pane, clear } = rig(DRAFT);
      expect(await receipt(await clear(paneId, { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "no_profile" });
      expect(pane.keysSeen).toEqual([]);
      expect(pane.reads).toBe(0);
    }
  });

  test("refused no_draft: the box already reads empty, and no key leaves", async () => {
    const { pane, clear, pokes } = rig("");
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "no_draft" });
    expect(pane.keysSeen).toEqual([]);
    expect(pokes()).toBe(0);
  });

  test("refused dialog_open: a dialog is up, so no key is typed at it", async () => {
    const { pane, clear } = rig(DRAFT);
    pane.show(OMP_APPROVAL);
    expect(await receipt(await clear("%2", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "dialog_open" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("refused unreadable: a screen with no box is not cleared blind", async () => {
    const { pane, clear } = rig(DRAFT);
    pane.show(NOT_A_SCREEN);
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "unreadable" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("re-read before the key: a dialog that drew after the first read is refused, and no key leaves", async () => {
    const { pane, clear } = rig(DRAFT);
    const base = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      if (pane.reads === 1) pane.show(OMP_APPROVAL);
      return base(paneId, request);
    };
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "dialog_open" });
    expect(pane.keysSeen).toEqual([]);
    expect(pane.reads).toBe(2);
  });

  test("re-read before the key: a box emptied by the second read is refused no_draft", async () => {
    const { pane, clear } = rig(DRAFT);
    const base = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      if (pane.reads === 1) pane.draft = "";
      return base(paneId, request);
    };
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "no_draft" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("refused pane_gone and press_failed (the multiplexer refused the keys)", async () => {
    const gone = rig(DRAFT);
    gone.pane.unreadable = true;
    expect(await receipt(await gone.clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "pane_gone" });
    const refused = rig(DRAFT);
    refused.pane.refuseKeys = true;
    expect(await receipt(await refused.clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "press_failed" });
    expect(refused.pokes()).toBe(0);
  });

  test("a box that ignores the key: press_failed after the read-back, and the key is NOT pressed a second time", async () => {
    const { pane, clear, sleeps, pokes } = rig(DRAFT);
    pane.deaf = true;
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "press_failed" });
    expect(pane.keysSeen).toHaveLength(1);
    // Four read-backs, then the next round's fresh read finds the box no shorter and stops.
    expect(sleeps).toEqual([120, 280, 500, 800]);
    // The key did go in, so the engine looks again.
    expect(pokes()).toBe(1);
  });

  test("a dialog the key opened is told as dialog_open after the press; nothing more is pressed", async () => {
    const { pane, clear } = rig(DRAFT);
    pane.afterPress = OMP_APPROVAL;
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "dialog_open" });
    expect(pane.keysSeen).toHaveLength(1);
  });

  test("the audit line names the request id, the pane and the outcome, and never the box's text", async () => {
    const { clear, lines } = rig(DRAFT);
    // The receipt carries the draft for Restore; the audit line beside it does not.
    expect((await receipt(await clear("%1", { requestId: ID, text: "should never be recorded" }))).draft).toBe(DRAFT);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ action: "clear", paneId: "%1", session: "main", device: "phone", detail: { requestId: ID, outcome: "cleared", replayed: false, pressed: true } });
    expect(lines[0]).not.toContain("should never be recorded");
    expect(lines[0]).not.toContain(DRAFT);
  });
});

describe("the cleared text rides on the receipt, for Restore", () => {
  test("a refusal carries no text; a replay carries the same text", async () => {
    const { clear } = rig(DRAFT);
    expect((await receipt(await clear("%1", { requestId: ID }))).draft).toBe(DRAFT);
    expect((await receipt(await clear("%1", { requestId: ID }))).draft).toBe(DRAFT);
    const again = await receipt(await clear("%1", { requestId: "clear-req-0002" }));
    expect(again).toEqual({ requestId: "clear-req-0002", outcome: "refused", reason: "no_draft" });
  });

  test("where the bridge masks secret shapes, a text that holds one goes without; a plain text keeps it", async () => {
    const secret = "token=abcDEF123xyz";
    const masked = rig(secret);
    const got = await receipt(await masked.clear("%1", { requestId: ID }, true));
    expect(got).toEqual({ requestId: ID, outcome: "cleared" });
    expect(JSON.stringify(got)).not.toContain("abcDEF123xyz");
    expect(masked.lines.join("\n")).not.toContain("abcDEF123xyz");
    const plain = rig(DRAFT);
    expect((await receipt(await plain.clear("%1", { requestId: ID }, true))).draft).toBe(DRAFT);
  });

  test("the text is one line, cut to 8 KiB on a character boundary", () => {
    expect(boundedDraft("one\ntwo\r\nthree\tfour")).toBe("one two three four");
    expect(boundedDraft("short")).toBe("short");
    const wide = "é".repeat(CLEAR_DRAFT_MAX_BYTES);
    const cut = boundedDraft(wide);
    expect(new TextEncoder().encode(cut).length).toBe(CLEAR_DRAFT_MAX_BYTES);
    expect(cut).toBe("é".repeat(CLEAR_DRAFT_MAX_BYTES / 2));
    const odd = `x${"😀".repeat(CLEAR_DRAFT_MAX_BYTES)}`;
    const oddCut = boundedDraft(odd);
    expect(new TextEncoder().encode(oddCut).length).toBeLessThanOrEqual(CLEAR_DRAFT_MAX_BYTES);
    expect(oddCut.endsWith("😀")).toBe(true);
  });
});

describe("the replay rule", () => {
  test("the same request id twice answers the same receipt and presses once", async () => {
    const { pane, clear, lines, pokes } = rig(DRAFT);
    const first = await receipt(await clear("%1", { requestId: ID }));
    // The box is empty now, so a second run would refuse no_draft; the stored receipt answers instead.
    const second = await receipt(await clear("%1", { requestId: ID }));
    expect(second).toEqual(first);
    expect(second.outcome).toBe("cleared");
    expect(pane.keysSeen).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"replayed":true');
    expect(pokes()).toBe(1);
  });

  test("two taps at once with one id press once", async () => {
    const { pane, clear } = rig(DRAFT);
    const [a, b] = await Promise.all([clear("%1", { requestId: ID }), clear("%1", { requestId: ID })]);
    expect(await receipt(a)).toEqual(await receipt(b));
    expect(pane.keysSeen).toHaveLength(1);
  });

  test("a refusal is replayed as it was, and a new id is a new tap", async () => {
    const { pane, clear } = rig("");
    const first = await receipt(await clear("%1", { requestId: ID }));
    pane.draft = DRAFT;
    expect(await receipt(await clear("%1", { requestId: ID }))).toEqual(first);
    expect(pane.keysSeen).toEqual([]);
    expect((await receipt(await clear("%1", { requestId: "clear-req-0002" }))).outcome).toBe("cleared");
  });

  test("a request id used on another pane is a 409 and presses nothing", async () => {
    const { pane, clear } = rig(DRAFT);
    await clear("%1", { requestId: ID });
    const other = await clear("%2", { requestId: ID });
    expect(other.status).toBe(409);
    expect(pane.keysSeen).toHaveLength(1);
  });

  test("the 256 newest receipts are kept; the oldest id is forgotten and can press again", async () => {
    const { pane, clear } = rig("");
    for (let i = 0; i < 257; i++) await clear("%1", { requestId: `clear-req-${String(i).padStart(4, "0")}` });
    pane.draft = DRAFT;
    // The first id fell out of the 256: it runs again, and clears.
    expect((await receipt(await clear("%1", { requestId: "clear-req-0000" }))).outcome).toBe("cleared");
    // The newest id is still kept and replays its refusal.
    expect((await receipt(await clear("%1", { requestId: "clear-req-0256" }))).reason).toBe("no_draft");
  });
});

describe("the route's body", () => {
  test("no request id, a bad one, or a body that is no object is a 400; a pane the engine lacks is a 404 with its own receipt", async () => {
    const { pane, clear } = rig(DRAFT);
    for (const body of [undefined, null, "x", [], {}, { requestId: 5 }, { requestId: "short" }, { requestId: "../../etc/passwd-x" }]) {
      expect((await clear("%1", body)).status).toBe(400);
    }
    const missing = await clear("%9", { requestId: ID });
    expect(missing.status).toBe(404);
    // The Clear's own receipt, so the phone tells a gone pane from a build with no Clear (unsupported_build).
    expect(await missing.json()).toEqual({ requestId: ID, outcome: "refused", reason: "pane_gone" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("with no Clear service on the runtime the route says so, and presses nothing", async () => {
    const { rt } = rig(DRAFT);
    const res = await clearRoute({ engine: rt.engine }, "%1", { requestId: ID }, { audit: new AuditLog(() => undefined), device: null, session: "main", acceptEncoding: null });
    expect(res.status).toBe(404);
  });
});

describe("across a crew link and the device gate", () => {
  test("the clear route crosses to the member that owns the pane, which runs the press and answers the receipt", () => {
    expect(crewRouteFor("/api/pane/%251/clear")).toBe("pane/%251/clear");
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const branch = src.indexOf('action === "clear" && req.method === "POST" && rt.clear !== undefined');
    expect(branch).toBeGreaterThan(0);
    // Before the crew handler is built: the same code serves the lead's own panes and a member's.
    expect(branch).toBeLessThan(src.indexOf("const crewHandler = opts.crewRouter?.("));
  });
});
