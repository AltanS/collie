import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficialTricksReply, TricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { renderTricksPages } from "@/test/tricks-pages";

// SETTINGS → TRICKS → ONE TRICK (2026-11-21): the details page at its own address. A reload or a deep link draws
// it from the store and the official list alone; a key that names no trick says so calmly with a way back; Back
// comes up one level, to the list or to the trick's own page; tricks switched off as a whole send it to
// Settings, Tricks and the Hill. The Remove section has its own file (settings-trick-remove.test.tsx, ADR 0168).

const NOW = Date.parse("2026-11-11T09:41:00Z");
const LEGS: WireTrickInfo = {
  host: "lodge",
  id: "legs",
  name: "Browser leg",
  icon: "flask",
  on: false,
  state: "off",
  places: ["belt"],
  description: "Which release checks are green.",
  provenance: { via: "agent" },
};
const MORPH: WireOfficialTrick = { id: "morph", name: "Morph", description: "Your agent answers by drawing one screen.", repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: "0d8039936aef44961a5641f4bfdc4583ed0c3e60", state: "absent" };

async function storeWith(tricks: WireTrickInfo[]): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

const officialOf = (tricks: WireOfficialTrick[]) => async (): Promise<OfficialTricksReply> => ({ tricks });
const detail = () => document.querySelector<HTMLElement>('[data-slot="trick-detail"]');

afterEach(() => cleanup());

describe("the details page at its own address", () => {
  it("draws a trick's details on a deep link, with the trick's name as the title and its switch in the head", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([]) }, entries: ["/settings/tricks/lodge%3Alegs"] });
    expect(await screen.findByRole("heading", { name: "Browser leg" })).toBeInTheDocument();
    expect(detail()?.querySelector('[data-slot="trick-detail-name"]')).toHaveTextContent("Browser leg");
    const head = detail()?.querySelector<HTMLElement>('[data-section="head"]');
    expect(within(head!).getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    expect(head).toHaveTextContent("Off");
    // The header says what the page is; the name stands once, as the page's h1 (2026-11-21).
    expect(document.querySelector('[data-slot="settings-page-title"]')).toHaveTextContent("Trick details");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Browser leg"]);
  });

  it("flips the trick from its head with the list's one-tap switch, and says the new state in words", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...LEGS, on, state: "ok" as const }));
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([]), onSwitch }, entries: ["/settings/tricks/lodge%3Alegs"] });
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0]?.slice(0, 3)).toEqual(["lodge", "legs", true]);
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(detail()?.querySelector('[data-section="head"]')).toHaveTextContent("On");
  });

  it("draws an official entry before Add on a deep link, with its Add", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([MORPH]) }, entries: ["/settings/tricks/morph"] });
    expect(await screen.findByRole("heading", { name: "Morph" })).toBeInTheDocument();
    expect(within(detail()!).getByRole("button", { name: "Add" })).toBeEnabled();
    expect(within(detail()!).queryByRole("switch")).toBeNull();
  });

  it("says calmly that a trick is not here any more, and its button goes back to the list", async () => {
    const user = userEvent.setup();
    const router = renderTricksPages({ store: await storeWith([LEGS]), card: { now: NOW, onOfficialList: officialOf([]) }, page: { onOfficialList: officialOf([]) }, entries: ["/settings/tricks/lodge%3Agone"] });
    const gone = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="trick-detail-gone"]');
      if (el === null) throw new Error("not yet");
      return el;
    });
    expect(gone).toHaveTextContent("This trick is not here any more.");
    expect(detail()).toBeNull();
    await user.click(within(gone).getByRole("button", { name: "Show all tricks" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
  });

  it("says the same for an official id that the settled list does not hold, and for a key that does not read", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([MORPH]) }, entries: ["/settings/tricks/nope"] });
    expect(await screen.findByText("This trick is not here any more.")).toBeInTheDocument();
    cleanup();
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([]) }, entries: ["/settings/tricks/a%3Ab%3Ac"] });
    expect(await screen.findByText("This trick is not here any more.")).toBeInTheDocument();
  });

  it("Back comes up to the trick's own page when its header opened this one", async () => {
    const user = userEvent.setup();
    const router = renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: officialOf([]) }, entries: ["/trick/trick%3Alodge%3Alegs%3Alegs"] });
    await router.navigate("/settings/tricks/lodge%3Alegs", { state: { from: "/trick/trick%3Alodge%3Alegs%3Alegs" } });
    await screen.findByRole("heading", { name: "Browser leg" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/trick/trick%3Alodge%3Alegs%3Alegs"));
  });

  it("sends a deep link to Settings, Tricks and the Hill while tricks are switched off on the machine", async () => {
    const router = renderTricksPages({ store: await storeWith([LEGS]), loader: () => ({ tricksOff: true }), page: { onOfficialList: officialOf([]) }, entries: ["/settings/tricks/lodge%3Alegs"] });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
  });
});
