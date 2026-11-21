import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OfficialTrickDetail, OriginLabel, TrickDetail } from "@/components/trick-detail";
import { t } from "@/lib/i18n";
import type { WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";

// THE LOOK OF A TRICK'S DETAILS PAGE (2026-11-21, the lead's six points): a warning's glyph in the caution tone, the
// official accent on the official origin only, the name as the page's h1, the Settings fields in one bordered
// group, and the three lines that said "sheet".

const BASE: WireTrickInfo = { host: "lodge", id: "kettle", name: "Kettle Watch", icon: "flask", on: false, state: "off", places: ["belt"], description: "Says when the kettle boils.", provenance: { via: "cli", at: "2026-11-08T07:41:00Z" } };
const ENTRY: WireOfficialTrick = { id: "lantern", name: "Lantern", description: "Lights a lamp.", repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: "0c1e5d82346486815073fedcdb994bc4c2041b55", state: "absent" };
const page = () => document.querySelector<HTMLElement>('[data-slot="trick-detail"]')!;
/** No colour on this page may say "safe". */
const SAFE = /\b(text|bg|border)-(green|emerald|status-done)\b/;

describe("a warning row", () => {
  it("draws its glyph in the caution tone of a flagged code line, and its words in the normal colour, word for word", () => {
    render(<TrickDetail trick={{ ...BASE, warnings: [{ kind: "network", text: "This trick reaches the network." }] }} />);
    const glyph = page().querySelector('[data-fact="warn"]');
    expect(glyph?.getAttribute("class")).toContain("text-status-working");
    const words = page().querySelector('[data-warning="network"]');
    expect(words?.textContent).toBe("This trick reaches the network.");
    expect(words?.closest("li")?.className).not.toMatch(/status|bg-|shadow-\[var\(--edge-accent\)/);
    // Every other fact keeps the muted glyph.
    for (const other of page().querySelectorAll('[data-fact]:not([data-fact="warn"])')) expect(other.getAttribute("class")).toContain("text-muted-foreground");
  });
});

describe("the origin", () => {
  it("draws Official and the official tile in the accent, and Community neutral; never a safe colour", () => {
    const { unmount } = render(<OriginLabel origin="official" />);
    expect(screen.getByText("Official").className).toContain("bg-control-on");
    unmount();
    render(<OriginLabel origin="community" />);
    expect(screen.getByText("Community").className).toContain("text-muted-foreground");
    expect(screen.getByText("Community").className).not.toContain("control-on");
  });

  it("gives the head's tile the accent for an official trick only", () => {
    const { unmount } = render(<OfficialTrickDetail entry={ENTRY} busy={false} canWrite onAdd={vi.fn()} />);
    const official = page().querySelector('[data-slot="trick-detail-icon"]');
    expect(official?.className).toContain("bg-control-on");
    expect(page().innerHTML).not.toMatch(SAFE);
    unmount();
    render(<TrickDetail trick={BASE} origin="community" />);
    const community = page().querySelector('[data-slot="trick-detail-icon"]');
    expect(community?.className).toContain("bg-card");
    expect(community?.className).not.toContain("control-on");
    expect(page().innerHTML).not.toMatch(SAFE);
  });
});

describe("the name", () => {
  it("is the page's h1, once", () => {
    render(<TrickDetail trick={BASE} />);
    expect(screen.getByRole("heading", { level: 1, name: "Kettle Watch" })).toHaveAttribute("data-slot", "trick-detail-name");
    expect(screen.getAllByText("Kettle Watch")).toHaveLength(1);
  });
});

describe("the Settings section", () => {
  it("holds one row per field in one bordered group, the no-secrets line above it", () => {
    const fields: WireTrickInfo["fields"] = [
      { key: "room", kind: "text", label: "Room" },
      { key: "beep", kind: "switch", label: "Beep when it boils" },
    ];
    render(<TrickDetail trick={{ ...BASE, fields }} onValue={vi.fn(async () => null)} />);
    const section = page().querySelector('[data-section="settings"]')!;
    const group = section.querySelector('[data-slot="list-group"]');
    expect(group?.tagName).toBe("UL");
    expect([...(group?.children ?? [])].map((li) => li.querySelector("[data-field]")?.getAttribute("data-field"))).toEqual(["room", "beep"]);
    const note = section.querySelector('[data-line="settings-no-secrets"]');
    expect(note?.textContent).toBe("Not for secrets. Every paired phone can see these.");
    expect(note!.compareDocumentPosition(group!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the three lines that said sheet", () => {
  it("say go back and open this page again, the rest word for word", () => {
    expect(t("settings.tricks.about.code.failed")).toBe("The code could not be read. Go back and open this page again.");
    expect(t("settings.tricks.about.code.moved")).toBe("The code changed while it was read. Go back and open this page again.");
    expect(t("settings.tricks.fields.refused.gone")).toBe("This setting is gone from the trick. Go back and open this page again.");
  });
});
