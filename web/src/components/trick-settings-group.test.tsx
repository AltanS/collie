import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrickAboutSheet } from "@/components/trick-about-sheet";
import { TrickSettingsGroup } from "@/components/trick-settings-group";
import { slotLine } from "@/components/tricks-settings-card";
import type { JsonValue } from "@/lib/json";
import type { FieldValue, TrickField, WireTrickInfo } from "@/lib/tricks/schema";
import { readTrick } from "@/lib/tricks/wire";

// The Settings group of a trick's About sheet (contract 3): one 44 px row per field, the row's "Needs setup".

const FIELDS: TrickField[] = [
  { key: "repo", kind: "text", label: "Repository", hint: "owner/name", required: true },
  { key: "branch", kind: "choice", label: "Branch", options: ["main", "edge"], default: "main" },
  { key: "notify", kind: "switch", label: "Notify me" },
  { key: "rows", kind: "number", label: "Rows", min: 1, max: 50, default: 10 },
];

const TRICK: WireTrickInfo = {
  host: "lodge",
  id: "gates",
  name: "Release Gates",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["belt"],
  provenance: { via: "folder" },
  fields: FIELDS,
  needsSetup: true,
};

function group(trick: Partial<WireTrickInfo> = {}, extra: { canWrite?: boolean; onLead?: boolean; onValue?: (key: string, value: FieldValue | null) => Promise<string | null> } = {}) {
  const onValue = extra.onValue ?? vi.fn(async () => null);
  render(<TrickSettingsGroup trick={{ ...TRICK, ...trick }} canWrite={extra.canWrite ?? true} onLead={extra.onLead ?? false} onValue={onValue} />);
  const section = document.querySelector('[data-section="settings"]');
  if (!(section instanceof HTMLElement)) throw new Error("no Settings group");
  return { onValue, section };
}

describe("TrickSettingsGroup", () => {
  it("draws one row per field, each with a 44 px floor, its label and its control by kind", () => {
    const { section } = group();
    expect(within(section).getByText("Settings")).toBeInTheDocument();
    const rows = [...section.querySelectorAll("[data-field]")];
    expect(rows.map((row) => [row.getAttribute("data-field"), row.getAttribute("data-kind")])).toEqual([
      ["repo", "text"],
      ["branch", "choice"],
      ["notify", "switch"],
      ["rows", "number"],
    ]);
    for (const row of rows) expect(row.firstElementChild?.className).toContain("min-h-11");
    expect(screen.getByLabelText(/Repository/)).toHaveAttribute("enterkeyhint", "done");
    expect(screen.getByLabelText(/Rows/)).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByLabelText("Branch").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Notify me")).toHaveAttribute("role", "switch");
    expect(within(section).getByText("owner/name")).toBeInTheDocument();
    expect(section.querySelector('[data-line="settings-needs-setup"]')).toHaveTextContent("Fill in the required settings so the trick can do its work.");
    expect(section.querySelector('[data-field="repo"]')).toHaveAttribute("data-empty", "");
  });

  it("draws nothing for a trick with no fields", () => {
    render(<TrickSettingsGroup trick={{}} canWrite onValue={vi.fn()} />);
    expect(document.querySelector('[data-section="settings"]')).toBeNull();
  });

  it("saves a text on the keyboard's done, once, and clears the field with an empty box", async () => {
    const user = userEvent.setup();
    const { onValue } = group();
    const box = screen.getByLabelText(/Repository/);
    await user.type(box, "lodge/workshop{Enter}");
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith("repo", "lodge/workshop");
    await user.clear(box);
    await user.tab();
    expect(onValue).toHaveBeenLastCalledWith("repo", null);
  });

  it("checks the field's rule before it sends: a number out of range is said under the row, and nothing is sent", async () => {
    const user = userEvent.setup();
    const { onValue, section } = group();
    const box = screen.getByLabelText(/Rows/);
    await user.clear(box);
    await user.type(box, "99{Enter}");
    expect(onValue).not.toHaveBeenCalled();
    expect(section.querySelector('[data-field="rows"] [data-slot="field-note"]')).toHaveTextContent("Use a whole number from 1 to 50.");
  });

  it("saves a choice and a switch at once", async () => {
    const user = userEvent.setup();
    const { onValue } = group();
    await user.selectOptions(screen.getByLabelText("Branch"), "edge");
    expect(onValue).toHaveBeenLastCalledWith("branch", "edge");
    await user.click(screen.getByLabelText("Notify me"));
    expect(onValue).toHaveBeenLastCalledWith("notify", true);
  });

  it("says a failed write under the row and puts the old value back", async () => {
    const user = userEvent.setup();
    const { section } = group({}, { onValue: async () => "Branch was not saved. Try again." });
    await user.selectOptions(screen.getByLabelText("Branch"), "edge");
    expect(section.querySelector('[data-field="branch"] [data-slot="field-note"]')).toHaveTextContent("Branch was not saved. Try again.");
    expect(screen.getByLabelText("Branch")).toHaveValue("main");
  });

  it("is read only on a crew member, and on a device that may not write", () => {
    const { section } = group({ values: { repo: "lodge/workshop" } }, { onLead: true });
    expect(section.querySelector('[data-line="settings-on-lead"]')).toHaveTextContent("These settings live on the lead of this crew. Change them there.");
    expect(screen.getByLabelText(/Repository/)).toBeDisabled();
    expect(screen.getByLabelText(/Repository/)).toHaveValue("lodge/workshop");
  });

  it("says when the saved values could not be read", () => {
    const { section } = group({ valuesUnread: true });
    expect(section.querySelector('[data-line="settings-unread"]')).toHaveTextContent("The saved settings could not be read. Set them again.");
  });
});

describe("in the About sheet and on the row", () => {
  it("the sheet draws the group only with a write handler", () => {
    const { unmount } = render(<TrickAboutSheet trick={TRICK} open onClose={vi.fn()} onValue={vi.fn(async () => null)} />);
    expect(screen.getByRole("dialog").querySelector('[data-section="settings"]')).not.toBeNull();
    unmount();
    render(<TrickAboutSheet trick={TRICK} open onClose={vi.fn()} />);
    expect(screen.getByRole("dialog").querySelector('[data-section="settings"]')).toBeNull();
  });

  it("the row says Needs setup while a required field is empty, and that the values do not read", () => {
    const now = Date.parse("2026-11-17T09:00:00Z");
    expect(slotLine(TRICK, now)).toEqual({ text: "Needs setup: open it to fill in its settings.", trouble: false });
    expect(slotLine({ ...TRICK, valuesUnread: true }, now)).toEqual({ text: "Its saved settings could not be read. Open it to set them again.", trouble: true });
    expect(slotLine({ ...TRICK, needsSetup: undefined }, now).text).not.toContain("Needs setup");
  });

  it("the wire keeps the fields by their rules and drops values that break them", () => {
    // SAFETY: a row as the bridge sends it is plain JSON; readTrick is the reader under test.
    const read = readTrick(JSON.parse(JSON.stringify({ ...TRICK, values: { repo: "lodge/workshop", rows: 99 } })) as JsonValue);
    expect(read?.fields).toEqual(FIELDS);
    expect(read?.values).toEqual({ repo: "lodge/workshop" });
    expect(read?.needsSetup).toBe(true);
    // SAFETY: as above, plain JSON for the reader under test.
    expect(readTrick(JSON.parse(JSON.stringify({ ...TRICK, fields: [{ key: "x", kind: "secret", label: "X" }] })) as JsonValue)?.fields).toBeUndefined();
  });

  it("review G point 5: one quiet line says the settings are not for secrets, for a writer and for a read-only device", () => {
    const words = "Not for secrets. Every paired phone can see these.";
    const { section } = group();
    expect(within(section).getByText(words)).toHaveAttribute("data-line", "settings-no-secrets");
    expect(within(section).getByText(words).className).toContain("text-muted-foreground");
    expect(section.querySelectorAll('[data-line="settings-no-secrets"]')).toHaveLength(1);
  });

  it("the no-secrets line shows for a read-only device and with no value set", () => {
    const { section } = group({ values: { repo: "lodge/workshop" } }, { canWrite: false });
    expect(within(section).getByText("Not for secrets. Every paired phone can see these.")).toBeInTheDocument();
  });
});

describe("TrickSettingsGroup values", () => {
  it("draws a setting's value in the foreground at medium weight on a muted ground, the label staying muted-free plain text", () => {
    const { section } = group({ values: { repo: "lodge/workshop", branch: "edge", rows: 20 } });
    for (const control of [section.querySelector('input[name="value"]'), section.querySelector("select")]) {
      const classes = (control?.className ?? "").split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["bg-muted", "font-medium", "text-foreground", "border", "border-border"]));
      expect(classes).not.toContain("bg-background");
    }
    expect(within(section).getByLabelText(/Repository/)).toHaveValue("lodge/workshop");
    expect(within(section).getByLabelText("Branch")).toHaveValue("edge");
    // The hint stays a plain muted sentence.
    expect(section.querySelector("p.text-muted-foreground")?.className).not.toContain("bg-muted");
  });
});
