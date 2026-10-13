import { describe, expect, it } from "vitest";

import type { ReleaseNotes } from "./types";
import { leadPieces, notesView } from "./update-notes";

const entry = (version: string, leads: string[] = ["A line."]): ReleaseNotes => ({
  version,
  url: `https://github.com/AltanS/collie/releases/tag/v${version}`,
  groups: leads.length === 0 ? [] : [{ name: "Fixed", leads }],
});

describe("notesView (1.21.1)", () => {
  it("an older bridge sends no notes, and there is no list", () => {
    expect(notesView(undefined, true)).toBeNull();
    expect(notesView(undefined, false)).toBeNull();
  });

  it("with an offer, lists the offered releases newest first, headed by the newest", () => {
    const view = notesView({ current: entry("1.21.0"), offered: [entry("1.21.1"), entry("1.21.2")] }, true);
    expect(view?.kind).toBe("offered");
    expect(view?.version).toBe("1.21.2");
    expect(view?.entries.map((e) => e.version)).toEqual(["1.21.2", "1.21.1"]);
  });

  it("an offer whose releases published no notes shows nothing, never the installed version's", () => {
    expect(notesView({ current: entry("1.21.0"), offered: [] }, true)).toBeNull();
  });

  it("with nothing on offer, lists what the running version changed", () => {
    const view = notesView({ current: entry("1.21.1"), offered: [] }, false);
    expect(view).toEqual({ kind: "current", version: "1.21.1", entries: [entry("1.21.1")] });
    expect(notesView({ current: null, offered: [] }, false)).toBeNull();
    expect(notesView({ current: entry("1.21.1", []), offered: [] }, false)).toBeNull();
  });
});

describe("leadPieces", () => {
  it("splits backticked code out of a lead, and keeps an unpaired backtick as text", () => {
    expect(leadPieces("`collie doctor` checks a program.")).toEqual([
      { text: "collie doctor", code: true },
      { text: " checks a program.", code: false },
    ]);
    expect(leadPieces("A ` stray")).toEqual([{ text: "A ` stray", code: false }]);
    expect(leadPieces("Plain.")).toEqual([{ text: "Plain.", code: false }]);
  });
});
