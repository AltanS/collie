import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, incidentScreens, perturbations, readScreen, rowsOf } from "../../test/surface-corpus";
import { readCues } from "./cues";
import { findInputFrame, rowText } from "./frame";
import { requireProfile } from "./profile";
import { askOf, isFree } from "./surface";
import { CORPUS_WALK, FIXTURES, labelOf, NEGATIVE, own, towardFree } from "../../test/surface-fold";

// M56 spec 13: the Codex profile over the Codex fixtures.

describe("the codex profile over the Codex fixtures (M56 spec 13)", () => {
  // The profile tests (a), (b), (c) and (d) of the design record, run with the Codex profile on the
  // Codex fixtures, and with the Codex profile applied to every fixture: a profile on a harness it
  // does not describe must never make a dialog free either.
  const CODEX = requireProfile("codex").idle;
  const codexFixtures = FIXTURES.filter((name) => labelOf(name).harness === "codex");
  const read = (name: string, idle = CODEX) => readScreen(fixtureRows(name), agentOf(labelOf(name).harness), idle);
  const signature = (r: ReturnType<typeof own>): boolean =>
    r.frame !== null && r.surface.composer === "empty" && r.surface.turn === "idle" && r.cues?.strength === "none";
  const detector = (r: ReturnType<typeof own>): boolean => askOf(r.surface.modal) !== null || r.cues?.strength === "strong";

  it("codex: the set holds idle, draft, running and dialog screens from 0.150 to 0.163", () => {
    const states = new Set(codexFixtures.map((name) => labelOf(name).state));
    for (const state of ["idle", "draft", "running", "dialog"] as const) expect(states.has(state), state).toBe(true);
    expect(codexFixtures.length).toBeGreaterThan(40);
  });

  it("codex: the frame module finds the box on every idle Codex fixture", () => {
    const idle = codexFixtures.filter((name) => labelOf(name).state === "idle");
    expect(idle.length).toBeGreaterThan(8);
    for (const name of idle) {
      expect(findInputFrame(fixtureRows(name), CODEX), name).not.toBeNull();
      expect(isFree(read(name).surface), name).toBe(true);
    }
  });

  it("codex: the Ultra glyph (issue 615) reads exactly as the original glyph does", () => {
    const pairs = [
      ["codex--v0164-queue-done--w120.txt", "codex--v0165-ultra-empty--w120.txt", "empty"],
      ["codex--v0156-headless-draft.txt", "codex--v0165-ultra-draft.txt", "draft"],
    ] as const;
    for (const [original, ultra, composer] of pairs) {
      expect(findInputFrame(fixtureRows(ultra), CODEX), ultra).not.toBeNull();
      expect(read(ultra).surface, ultra).toEqual(read(original).surface);
      expect(read(ultra).surface).toMatchObject({ turn: "idle", modal: "none", composer });
      expect(isFree(read(ultra).surface), ultra).toBe(composer === "empty");
    }
  });

  // Counsel on issue 615: the prompt pattern widened from `›` to `[›»]`, so show what it does NOT
  // take. The frame needs its blank top row, a column-0 prompt row, and the Codex status row below
  // (profiles/codex.json idle.frame); the profile only reads panes the mux names as Codex.
  describe("the widened prompt glyph takes no output line for the box (issue 615)", () => {
    const EMPTY = "codex--v0164-queue-done--w120.txt"; // composer `›`
    const ULTRA = "codex--v0165-ultra-empty--w120.txt"; // the same screen, composer `»`
    const above = (rows: ReturnType<typeof fixtureRows>, extra: ReturnType<typeof rowsOf>, gap: number) => {
      const top = findInputFrame(rows, CODEX)!.top;
      return [...rows.slice(0, top - gap), ...extra, ...rows.slice(top - gap)];
    };
    const outputLines = rowsOf(["» ~/src/collie main ✓", "» Bonjour, dit-il, « ça va » ?", "» "].join("\n"));

    it("a column-0 `» ` output line above a `›` composer is not the box, flush or one row apart", () => {
      const rows = fixtureRows(EMPTY);
      const base = findInputFrame(rows, CODEX)!;
      for (const gap of [0, 1, 2]) {
        const screen = above(rows, outputLines, gap);
        const frame = findInputFrame(screen, CODEX);
        expect(frame, `gap ${gap}`).not.toBeNull();
        expect(frame!.interior.prompt, `gap ${gap}`).toBe(base.interior.prompt + outputLines.length);
        expect(frame!.placeholder, `gap ${gap}`).toBe(true);
        const r = readScreen(screen, "codex", CODEX);
        expect(r.surface, `gap ${gap}`).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
        expect(isFree(r.surface), `gap ${gap}`).toBe(true);
      }
    });

    it("the same lines above a `»` composer leave the box where it is", () => {
      const rows = fixtureRows(ULTRA);
      const base = findInputFrame(rows, CODEX)!;
      const frame = findInputFrame(above(rows, outputLines, 0), CODEX)!;
      expect(frame.interior.prompt).toBe(base.interior.prompt + outputLines.length);
      expect(isFree(readScreen(above(rows, outputLines, 0), "codex", CODEX).surface)).toBe(true);
    });

    it("a `»` line is never a box on its own: with no Codex status row under it there is no frame", () => {
      const screen = rowsOf(["• done", "", "» ~/src/collie main ✓", "", "$ "].join("\n"));
      expect(findInputFrame(screen, CODEX)).toBeNull();
      expect(isFree(readScreen(screen, "codex", CODEX).surface)).toBe(false);
    });

    const dialogQuote = [
      "• Here is the dialog you asked about:",
      "  Would you like to run the following command?",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
      "",
      "• That is all it shows.",
    ].join("\n");

    it("mixed: a `»` composer under a quoted `›` dialog stays free, and the box is the `»` row", () => {
      const rows = fixtureRows(ULTRA);
      const base = findInputFrame(rows, CODEX)!;
      const quote = rowsOf(dialogQuote);
      const quoted = [...rows.slice(0, base.top - quote.length - 2), ...quote, ...rows.slice(base.top - 2)];
      const r = readScreen(quoted, "codex", CODEX);
      expect(r.frame).not.toBeNull();
      expect(rowText(quoted[r.frame!.interior.prompt]!).startsWith("» ")).toBe(true);
      expect(isFree(r.surface)).toBe(true);
      expect(readCues(quote.slice(1, 5), null, null).strength).toBe("strong");
    });

    it("mixed: the same dialog flush on a `»` box is never free, as on a `›` box", () => {
      const rows = fixtureRows(ULTRA);
      const top = findInputFrame(rows, CODEX)!.top;
      const dialog = rowsOf(["  Would you like to run the following command?", "› 1. Yes, proceed (y)", "  2. No (esc)", "  Press enter to confirm or esc to cancel"].join("\n"));
      const flush = [...rows.slice(0, top - dialog.length), ...dialog, ...rows.slice(top)];
      expect(isFree(readScreen(flush, "codex", CODEX).surface)).toBe(false);
      const plain = fixtureRows(EMPTY);
      const plainTop = findInputFrame(plain, CODEX)!.top;
      const plainFlush = [...plain.slice(0, plainTop - dialog.length), ...dialog, ...plain.slice(plainTop)];
      expect(isFree(readScreen(plainFlush, "codex", CODEX).surface)).toBe(isFree(readScreen(flush, "codex", CODEX).surface));
    });

    it("reverse mixed: a `›` composer under a quoted dialog drawn with `»` pointers stays free", () => {
      const rows = fixtureRows(EMPTY);
      const base = findInputFrame(rows, CODEX)!;
      const quote = rowsOf(dialogQuote.replace("› 1.", "» 1."));
      const quoted = [...rows.slice(0, base.top - quote.length - 2), ...quote, ...rows.slice(base.top - 2)];
      const r = readScreen(quoted, "codex", CODEX);
      expect(r.frame).not.toBeNull();
      expect(rowText(quoted[r.frame!.interior.prompt]!).startsWith("› ")).toBe(true);
      expect(isFree(r.surface)).toBe(true);
    });

    it("no Codex dialog capture has a composer to mistake, so the glyph widening frees none of them", () => {
      const dialogs = codexFixtures.filter((name) => NEGATIVE.has(labelOf(name).state));
      expect(dialogs.length).toBeGreaterThan(10);
      expect(dialogs.filter((name) => isFree(read(name).surface))).toEqual([]);
    });
  });

  it("codex: a draft reads as a draft, never free, and a running turn never reads idle", () => {
    for (const name of codexFixtures.filter((n) => labelOf(n).state === "draft")) {
      expect(read(name).surface.composer, name).toBe("draft");
      expect(isFree(read(name).surface), name).toBe(false);
    }
    for (const name of codexFixtures.filter((n) => labelOf(n).state === "running")) {
      expect(read(name).surface.turn, name).toBe("running");
    }
  });

  it("codex (a): the idle matcher and the modal detector never both match, on Codex fixtures and on every fixture", CORPUS_WALK, () => {
    expect(codexFixtures.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
    expect(FIXTURES.filter((name) => signature(read(name)) && detector(read(name)))).toEqual([]);
  });

  it("codex (b): a perturbed Codex fixture never frees a dialog, and no claim of a dialog moves toward free", () => {
    const wrong: string[] = [];
    for (const name of codexFixtures) {
      const label = labelOf(name);
      const before = read(name).surface;
      for (const perturbed of perturbations(fixtureRows(name))) {
        const after = readScreen(perturbed.rows, agentOf(label.harness), CODEX).surface;
        if (isFree(after) && (!isFree(before) || NEGATIVE.has(label.state))) wrong.push(`${name} ${perturbed.name}: free`);
        if (NEGATIVE.has(label.state)) for (const move of towardFree(before, after)) wrong.push(`${name} ${perturbed.name}: ${move}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("codex (c): a Codex dialog quoted in the transcript stays free", () => {
    const rows = fixtureRows("codex--v0162-idle.txt");
    const top = findInputFrame(rows, CODEX)!.top;
    const quote = rowsOf(
      [
        "• Here is the dialog you asked about:",
        "  Would you like to run the following command?",
        "› 1. Yes, proceed (y)",
        "  2. No, and tell Codex what to do differently (esc)",
        "  Press enter to confirm or esc to cancel",
        "",
        "• That is all it shows.",
      ].join("\n"),
    );
    const quoted = [...rows.slice(0, top - quote.length - 2), ...quote, ...rows.slice(top - 2)];
    const r = readScreen(quoted, "codex", CODEX);
    expect(r.frame).not.toBeNull();
    expect(isFree(r.surface)).toBe(true);
    // The quote is a dialog shape: read with no frame, the cues see it.
    expect(readCues(quote.slice(1, 5), null, null).strength).toBe("strong");
  });

  it("codex (c): the same dialog flush on the box is never free", () => {
    const rows = fixtureRows("codex--v0162-idle.txt");
    const top = findInputFrame(rows, CODEX)!.top;
    const dialog = rowsOf(["  Would you like to run the following command?", "› 1. Yes, proceed (y)", "  2. No (esc)", "  Press enter to confirm or esc to cancel"].join("\n"));
    const flush = [...rows.slice(0, top - dialog.length), ...dialog, ...rows.slice(top)];
    expect(isFree(readScreen(flush, "codex", CODEX).surface)).toBe(false);
  });

  it("codex (d): the negative set never reads free with the Codex profile, the 0.156.1 approvals and pickers included", CORPUS_WALK, () => {
    const negative = FIXTURES.filter((name) => NEGATIVE.has(labelOf(name).state));
    const codexNegative = negative.filter((name) => labelOf(name).harness === "codex");
    for (const name of ["codex--v0156-approval-exec-2opt.txt", "codex--v0156-approval-patch.txt", "codex--approval-exec.txt", "codex--v0162-picker-model.txt"]) {
      expect(codexNegative, name).toContain(name);
    }
    const free = negative.filter((name) => isFree(read(name).surface) || isFree(read(name, CODEX).surface));
    expect(free).toEqual([]);
    const lifted = codexNegative.filter((name) => isFree(readScreen(fixtureRows(name), "codex", CODEX, { lift: false }).surface));
    expect(lifted).toEqual([]);
  });

  it("codex: the incident screens never read free with the Codex profile", () => {
    expect(incidentScreens().filter((incident) => isFree(readScreen(incident.rows, incident.agent, CODEX).surface)).map((i) => i.name)).toEqual([]);
  });
});
