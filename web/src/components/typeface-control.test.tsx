import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TypefaceControl } from "@/components/typeface-control";
import { __resetDesign, designPrefs } from "@/lib/design";
import { __resetOperatorCommands } from "@/lib/operator-config";
import type { BridgeConfig } from "@/lib/types";
import { server } from "@/test/setup";
import { http, HttpResponse } from "msw";

// The Typeface card is where ADR 0033 becomes something a thumb can do. The cases below are the
// four the design turns on: the default is the shipped face and costs no class; picking one writes
// the class AND the store; an operator's face is namespaced and mirrors its row into storage for
// the next cold load; and a stored choice whose row has gone renders the default WITHOUT throwing
// the preference away.

const STORAGE_KEY = "collie:design:v1";

/** Stage one /api/config body. Typed as the real wire shape, so a stale fixture fails to compile. */
function config(body: Partial<BridgeConfig>) {
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json({ push: false, vapidPublicKey: "", ...body } satisfies BridgeConfig),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  __resetDesign();
  __resetOperatorCommands();
});

describe("TypefaceControl", () => {
  it("offers the shipped faces, with Space Grotesk selected and no class on the root", async () => {
    config({});
    render(<TypefaceControl />);

    const select = await screen.findByLabelText("Family");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "System default",
      "Space Grotesk",
      "Aldrich",
    ]);
    expect(select).toHaveValue("aldrich");
    // The default wears no class — that is what keeps JavaScript off the first-paint path for a
    // device that never opens this card.
    expect(document.documentElement.className).toBe("");
  });

  it("picking a face writes the class and the store together", async () => {
    config({});
    const user = userEvent.setup();
    render(<TypefaceControl />);

    await user.selectOptions(await screen.findByLabelText("Family"), "grotesk");

    expect(document.documentElement).toHaveClass("font-grotesk");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({ font: "grotesk" });
  });

  it("swapping back to the default takes the class off again", async () => {
    config({});
    const user = userEvent.setup();
    render(<TypefaceControl />);

    const select = await screen.findByLabelText("Family");
    await user.selectOptions(select, "system");
    expect(document.documentElement).toHaveClass("font-system");
    await user.selectOptions(select, "aldrich");
    expect(document.documentElement.className).toBe("");
  });

  it("shows the operator's faces UNDER the shipped ones and mirrors the chosen row", async () => {
    config({ operatorFonts: [{ family: "Departure Mono", basename: "departure.woff2", weight: "400 700" }] });
    const user = userEvent.setup();
    render(<TypefaceControl />);

    const select = await screen.findByLabelText("Family");
    await within(select).findByRole("option", { name: "Departure Mono" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "System default",
      "Space Grotesk",
      "Aldrich",
      "Departure Mono",
    ]);

    await user.selectOptions(select, "op:departure.woff2");
    expect(document.documentElement).toHaveClass("font-operator");
    // The mirror. Without it, every cold load on this face would paint in Space Grotesk and change
    // voice once /api/config landed.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      font: "op:departure.woff2",
      operatorFont: { family: "Departure Mono", basename: "departure.woff2", weight: "400 700" },
    });
  });

  // A row the bridge would have refused must not become an option a thumb can reach, even if a
  // bridge somewhere sent it: this client re-validates rather than trusting the server's promise.
  it("never offers a row it would refuse to put in a stylesheet", async () => {
    config({ operatorFonts: [{ family: 'Evil"; } :root { color: red', basename: "evil.woff2" }] });
    render(<TypefaceControl />);

    const select = await screen.findByLabelText("Family");
    expect(within(select).getAllByRole("option")).toHaveLength(3);
  });

  // The offline / deleted-row case. The select must not silently show its first option ("System
  // default") and misreport the setting — but the PREFERENCE stays, so the row coming back restores
  // the face without the reader having to choose it again.
  it("falls back to the default face for a row that is gone, and keeps the preference", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ font: "op:gone.woff2" }));
    // Re-read the store now the value is in place: this is the cold-load case, so the page must
    // start already holding the preference rather than being told it after mount.
    __resetDesign();
    config({});
    render(<TypefaceControl />);

    expect(await screen.findByLabelText("Family")).toHaveValue("aldrich");
    expect(designPrefs().font).toBe("op:gone.woff2");
    expect(localStorage.getItem(STORAGE_KEY)).toContain("op:gone.woff2");
  });

  // D5: the note is a phrase, always present, and Aldrich's discloses the cost of its one weight.
  it("shows a note for the chosen face, and discloses Aldrich's synthesized bold", async () => {
    config({});
    const user = userEvent.setup();
    const { container } = render(<TypefaceControl />);

    await user.selectOptions(await screen.findByLabelText("Family"), "aldrich");
    expect(container.textContent).toContain("One weight");
  });
});
