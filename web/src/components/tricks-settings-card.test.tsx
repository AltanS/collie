import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { originLine } from "@/lib/tricks/row-words";
import { HOLD_MS, TricksSettingsCard, autoLine, officialFailureLine, placesLine, provenanceLine, readsLine, slotLine, useTricksPresent, versionCardOpener, warningLines } from "@/components/tricks-settings-card";
import type { HillDecision } from "@/lib/hill/wire";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import { collieCard } from "@/test/hill-fixtures";
import { addOfficialTrick, setTrickAuto, setTrickValue, setTricksSwitch, switchTrick, undoTrick } from "@/lib/api";
import { resetPollIntent, topologyBursting } from "@/lib/poll-intent";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { ABOUT_MAX, DESCRIPTION_MAX, inputsSentence, TRICKS_WINDOWS_LINE, TRICKS_WINDOWS_SHELL_LINE, type TricksReply, type WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { readTrick, readTrickText } from "@/lib/tricks/wire";
import type { JsonObject } from "@/lib/json";
import { clearStatus, currentStatus } from "@/lib/status";
import { server } from "@/test/setup";

// The Tricks card (M94 slice 04): absent without a tricks reply, one row per trick in a fixed shape of
// three lines, one switch per row, and a switch that flips at once and goes back when the bridge says no.

const NOW = Date.parse("2026-11-08T09:41:00Z");

const LEGS: WireTrickInfo = {
  host: "lodge",
  id: "legs",
  name: "Browser leg",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["belt", "session"],
  provenance: { via: "agent", at: "2026-11-08T07:41:00Z" },
};
const TRACKER: WireTrickInfo = {
  host: "lodge",
  id: "tracker",
  name: "Tracker",
  icon: "file",
  on: false,
  state: "off",
  places: ["session"],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "owner/tracker-trick", sha: "3f2a91c0d4e5" },
};

/** A store that has taken one reply listing `tricks`. */
async function storeWith(tricks: WireTrickInfo[]): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

/** The official list these cards read: none, so every trick is a community row. */
const NO_OFFICIAL = async () => ({ tricks: [] });

function renderCard(store: TricksStore, onSwitch?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>, readOnly = false) {
  const loader = readOnly ? () => ({ device: { enforced: true, authorized: false } }) : undefined;
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} onSwitch={onSwitch} now={NOW} onOfficialList={NO_OFFICIAL} />, loader }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

const rowOf = (id: string) => {
  const row = document.querySelector(`[data-trick="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${id}`);
  return row;
};

/** A row once the card drew its rows: they wait for the official list's first answer. */
async function findRow(id: string): Promise<HTMLElement> {
  await vi.waitFor(() => rowOf(id));
  return rowOf(id);
}

afterEach(() => {
  clearStatus();
  vi.useRealTimers();
});

describe("TricksSettingsCard: when it shows", () => {
  it("draws nothing before the phone holds a tricks reply", async () => {
    const store = createTricksStore({ fetchTricks: async () => Promise.reject(new Error("no runner")), tapTrick: async () => Promise.reject(new Error("no")), mintRequestId: () => "r" });
    await store.syncTricks(undefined);
    renderCard(store);
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    const { result } = renderHook(() => useTricksPresent(store));
    expect(result.current).toBe(false);
  });

  it("draws the card once a reply is held", async () => {
    const store = await storeWith([LEGS]);
    renderCard(store);
    expect(await screen.findByTestId("tricks-settings")).toBeInTheDocument();
    const { result } = renderHook(() => useTricksPresent(store));
    expect(result.current).toBe(true);
  });
});

describe("B7: TricksSettingsCard on a machine that runs no tricks", () => {
  async function storeRunsOn(runsOn: TricksReply["runsOn"]): Promise<TricksStore> {
    const reply: TricksReply = { rev: 5, tricks: [LEGS], parts: [], present: [], runsOn };
    const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
    await store.syncTricks(5);
    return store;
  }

  it("says the lead runs them, by name, and that this machine runs none", async () => {
    renderCard(await storeRunsOn({ lead: "desk" }));
    expect(await screen.findByText("Tricks run on the lead of this crew (desk). This machine runs none.")).toBeInTheDocument();
  });

  it("says it without a name when the lead is not known", async () => {
    renderCard(await storeRunsOn({}));
    expect(await screen.findByText("Tricks run on the lead of this crew. This machine runs none.")).toBeInTheDocument();
  });

  it("says nothing of the kind on a lead or a solo machine", async () => {
    renderCard(await storeWith([LEGS]));
    await screen.findByTestId("tricks-settings");
    expect(screen.queryByText(/This machine runs none/)).toBeNull();
  });
});

describe("TricksSettingsCard: a gated bridge", () => {
  it("windows gate: the card draws nothing (the switch card says the line once), and reads no list", async () => {
    const reply: TricksReply = { rev: 5, tricks: [], parts: [], present: [], gate: "windows" };
    const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
    await store.syncTricks(5);
    const official = vi.fn(async () => ({ tricks: [] }));
    const router = createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={official} /> }],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    expect(container.textContent).not.toContain(TRICKS_WINDOWS_LINE);
    expect(official).not.toHaveBeenCalled();
  });
});

describe("TricksSettingsCard: the rows", () => {
  it("is one row per trick: the name, the places, the provenance and a switch", async () => {
    renderCard(await storeWith([LEGS, TRACKER]));
    const legs = await screen.findByText("Browser leg");
    expect(legs).toBeInTheDocument();
    const a = within(rowOf("legs"));
    expect(a.getByText("belt, page")).toBeInTheDocument();
    expect(a.getByText("Added by agent · 2 h ago")).toBeInTheDocument();
    expect(a.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    const b = within(rowOf("tracker"));
    expect(b.getByText("page")).toBeInTheDocument();
    expect(b.getByText("From owner/tracker-trick @ 3f2a91c · 3 min ago")).toBeInTheDocument();
    expect(b.getByRole("switch", { name: "Tracker" })).not.toBeChecked();
    expect(screen.getByText("A trick runs as you.")).toBeInTheDocument();
  });

  it("says no parts for a manifest with no places, and the CLI and hand provenances in words", () => {
    expect(placesLine([])).toBe("No parts");
    expect(placesLine(["belt", "belt", "status", "dashboard", "tabbar"])).toBe("belt, status, Dashboard, Bottom bar");
    expect(provenanceLine({ ...LEGS, provenance: { via: "cli" } }, NOW)).toBe("Added by CLI");
    expect(provenanceLine({ ...LEGS, provenance: { via: "folder" } }, NOW)).toBe("Added by hand");
    expect(provenanceLine({ ...LEGS, provenance: undefined }, NOW)).toBe("Added by hand");
    expect(provenanceLine({ ...LEGS, provenance: { via: "repo", repo: "o/r" } }, NOW)).toBe("From o/r");
    // From the official repository, but not a version of the official list (a pull request's commit).
    expect(provenanceLine({ ...LEGS, provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: "9c41d07aa", unlisted: true } }, NOW)).toBe("From AltanS/collie-tricks @ 9c41d07, not on the official list");
    expect(originLine({ via: "repo", repo: "AltanS/collie-tricks", sha: "9c41d07aa", unlisted: true })).toBe("From AltanS/collie-tricks @ 9c41d07, not on the official list");
    expect(originLine({ via: "repo", repo: "AltanS/collie-tricks", sha: "9c41d07aa" })).toBe("From AltanS/collie-tricks @ 9c41d07");
    expect(provenanceLine({ ...LEGS, provenance: { via: "repo" } }, NOW)).toBe("Added from a repository");
    expect(provenanceLine({ ...LEGS, provenance: { via: "agent", proposed: { by: "agent", host: "workshop" } } }, NOW)).toBe("Proposed by an agent on workshop");
    expect(provenanceLine({ ...LEGS, provenance: { via: "cli", proposed: { by: "terminal", host: "lodge" } } }, NOW)).toBe("Proposed from lodge, session not confirmed");
  });

  it("fills the third line with the masked error for a failing or stopped trick, one line, clipped", async () => {
    const failing: WireTrickInfo = { ...LEGS, state: "failing", error: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json and a great deal more besides" };
    const stopped: WireTrickInfo = { ...TRACKER, on: true, id: "stopped", name: "Stopped one", state: "stopped", error: "exit 1, five times" };
    renderCard(await storeWith([failing, stopped]));
    const line = within(await findRow("legs")).getByText(/^legs\.sh: exit 2/);
    expect(line.dataset.line).toBe("slot");
    expect(line.dataset.trouble).toBe("true");
    expect(line.className).toContain("truncate");
    expect(within(rowOf("stopped")).getByText("exit 1, five times")).toBeInTheDocument();
    // The provenance is not drawn beside it: the slot holds one or the other.
    expect(within(rowOf("legs")).queryByText(/Added by agent/)).toBeNull();
  });

  it("says the trick cannot run, with the first reason, for a skipped trick", async () => {
    const skipped: WireTrickInfo = {
      ...LEGS,
      state: "skipped",
      on: false,
      refusals: [
        { code: "place", path: "/places/0", reason: '"nowhere" is not a place this Collie knows.' },
        { code: "missing", path: "/run", reason: "run is missing" },
      ],
    };
    renderCard(await storeWith([skipped]));
    expect(within(await findRow("legs")).getByText('This trick cannot run. "nowhere" is not a place this Collie knows.')).toBeInTheDocument();
    expect(slotLine({ ...skipped, refusals: undefined, error: undefined }, NOW).text).toBe("This trick cannot run.");
  });

  it("decision 5: a part the bridge refused shows its reason on the row in every state, in its own words", () => {
    const refusals: WireTrickInfo["refusals"] = [{ code: "text", path: "/parts/0/chip/text", reason: "\"text\" is 19 characters. At most 12.", part: "todo" }];
    for (const state of ["ok", "failing"] as const) {
      expect(slotLine({ ...LEGS, state, refusals, error: undefined }, NOW)).toEqual({ text: "Part of this trick is not shown. \"text\" is 19 characters. At most 12.", trouble: true });
    }
    // A note the parser only ignored is no refusal: the row keeps its provenance.
    expect(slotLine({ ...LEGS, refusals: [{ code: "ignored", path: "/x", reason: "x This Collie ignores it." }] }, NOW).trouble).toBe(false);
  });

  it("a watch that checks on a clock says so alone, never after the \"part is not shown\" prefix", async () => {
    const polled: WireTrickInfo = { ...LEGS, watch: ["~/notes/todo.md"], watchPollSeconds: 5 };
    const line = "Collie could not watch these files for changes, so it checks them every 5 seconds.";
    expect(slotLine(polled, NOW)).toEqual({ text: line, trouble: false });
    // Nothing was refused: the row also never shows it as a trouble report, and the line holds no error code.
    expect(slotLine(polled, NOW).text).not.toContain("Part of this trick");
    expect(slotLine(polled, NOW).text).not.toMatch(/ENOSPC|EMFILE/u);
    // A real refusal still shows with its prefix, and it comes first: the row holds one line.
    const refusals: WireTrickInfo["refusals"] = [{ code: "text", path: "/parts/0/chip/text", reason: "\"text\" is 19 characters. At most 12.", part: "todo" }];
    expect(slotLine({ ...polled, refusals }, NOW)).toEqual({ text: "Part of this trick is not shown. \"text\" is 19 characters. At most 12.", trouble: true });
    // A trick that is off has no watch running: the row keeps its provenance.
    expect(slotLine({ ...polled, on: false, state: "off" }, NOW).text).toBe("Added by agent · 2 h ago");
    renderCard(await storeWith([polled]));
    expect(within(await findRow("legs")).getByText(line)).toBeInTheDocument();
  });

  it("a trick that reads through the local API, where it is off, says so once and alone", async () => {
    const off: WireTrickInfo = { ...LEGS, access: "see", accessOff: true };
    const line = "This trick reads through Collie's local API, which is off here.";
    expect(slotLine(off, NOW)).toEqual({ text: line, trouble: false });
    // A trick that is off has nothing to say yet; a trick whose socket stands says nothing.
    expect(slotLine({ ...off, on: false, state: "off" }, NOW).text).toBe("Added by agent · 2 h ago");
    expect(slotLine({ ...LEGS, access: "see" }, NOW).text).toBe("Added by agent · 2 h ago");
    renderCard(await storeWith([off]));
    expect(within(await findRow("legs")).getByText(line)).toBeInTheDocument();
  });

  it("keeps every row the same three lines, whatever the state", async () => {
    const failing: WireTrickInfo = { ...LEGS, id: "bad", name: "Bad", state: "failing", error: "exit 2" };
    renderCard(await storeWith([LEGS, TRACKER, failing]));
    await screen.findByText("Bad");
    for (const id of ["legs", "tracker", "bad"]) {
      const row = rowOf(id);
      // The three lines; a trick that took a change without asking adds its changes row below them (crew slice 3).
      const lines = [...row.querySelectorAll<HTMLElement>("[data-line]")].filter((el) => el.closest('[data-line="changes"]') === null);
      expect(lines.length).toBe(2);
      expect(row.querySelector('[data-line="changes"]')).toBeNull();
      expect(row.querySelector('[data-line="places"]')?.textContent).not.toBe("");
      expect(row.querySelector('[data-line="slot"]')?.textContent).not.toBe("");
    }
  });

  it("shows one muted row and the init command when the folder holds no trick", async () => {
    renderCard(await storeWith([]));
    expect(await screen.findByText("No tricks yet")).toBeInTheDocument();
    expect(screen.getByText("collie trick init <id>").className).toContain("font-mono");
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByText("A trick runs as you.")).toBeInTheDocument();
  });
});

describe("TricksSettingsCard: Uses agent tokens (2026-11-12)", () => {
  it("draws the chip on the name line of a trick that makes an agent read or write more, and none on the others", async () => {
    const ANSWERS: WireTrickInfo = { ...TRACKER, id: "inbox", name: "PR Inbox", decidesReply: true };
    const RULES: WireTrickInfo = { ...TRACKER, id: "notes", name: "Notes", rules: { file: "rules.md", text: "Write short.\n" } };
    renderCard(await storeWith([LEGS, ANSWERS, RULES, { ...TRACKER, decides: true }]));
    await findRow("inbox");
    const chip = (id: string) => rowOf(id).querySelector('[data-slot="trick-about"] [data-slot="token-use"]');
    expect(chip("inbox")?.textContent).toBe("Uses agent tokens");
    expect(chip("notes")?.textContent).toBe("Uses agent tokens");
    // A program trick whose last run listed Decisions but declares no reply, and a plain one: no chip.
    expect(chip("tracker")).toBeNull();
    expect(chip("legs")).toBeNull();
    // The name, then the labels as one group that wraps under the name rather than cut it; the open button
    // keeps the name it always had.
    const button = rowOf("inbox").querySelector('[data-slot="trick-about"]');
    expect(button?.className).toContain("flex-wrap");
    expect([...(button?.children ?? [])].map((el) => el.getAttribute("data-slot"))).toEqual(["row-name", "row-labels"]);
    expect([...(button?.lastElementChild?.children ?? [])].map((el) => el.getAttribute("data-slot"))).toEqual(["trick-origin", "token-use"]);
    expect(within(rowOf("inbox")).getByRole("button", { name: "About PR Inbox" })).toBe(button);
  });
});

describe("TricksSettingsCard: the warnings before the switch (review 15)", () => {
  const WARNED: WireTrickInfo = {
    ...TRACKER,
    warnings: [
      { kind: "model", text: "bridge words for model" },
      { kind: "network", text: "bridge words for network" },
    ],
  };
  const MODEL_LINE = "On a timer this trick starts an agent or calls a model. Each run can use your subscription.";
  const HONESTY = "Found by a text search of its code, not a proof.";

  it("lists a trick's warnings in the phone's words under an off trick, with the honesty line", async () => {
    renderCard(await storeWith([LEGS, WARNED]));
    const row = within(await findRow("tracker"));
    const list = await row.findByRole("list", { name: "What a text search of its code found" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([MODEL_LINE, "This trick reaches the network."]);
    expect(row.getByText(HONESTY)).toBeInTheDocument();
    // A trick with none draws the three lines alone.
    expect(rowOf("legs").querySelector('[data-line="warnings"]')).toBeNull();
  });

  it("keeps the switch one tap: no second confirm and no button", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...WARNED, on, state: "ok" as const, warnings: undefined }));
    renderCard(await storeWith([WARNED]), onSwitch);
    await user.click(await screen.findByRole("switch", { name: "Tracker" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("lodge", "tracker", true);
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeChecked();
    // The buttons on the card are the names, which open an About sheet, and the last row's "Add from a repository". The Hill has no row here any more.
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-slot"))).toEqual(["trick-about", "repo-add-open"]);
  });

  it("shows them for a changed trick that is on, and the bridge's own words for a kind it does not know", async () => {
    const changed: WireTrickInfo = { ...LEGS, state: "stopped", changed: true, error: "This trick changed.", warnings: [{ kind: "teleport", text: "This trick moves the moon." }] };
    renderCard(await storeWith([changed]));
    expect(await within(await findRow("legs")).findByText("This trick moves the moon.")).toBeInTheDocument();
    expect(warningLines({ warnings: undefined })).toEqual([]);
  });

  it("reads a bridge that sends none, and leaves out a malformed entry", () => {
    const base = { host: "lodge", id: "legs", name: "Legs", icon: "plug", on: false, state: "off", places: ["belt"] };
    expect(readTrick(base)).not.toHaveProperty("warnings");
    expect(readTrick({ ...base, warnings: "loud" })).not.toHaveProperty("warnings");
    expect(readTrick({ ...base, warnings: [{ kind: "network", text: "x" }, 5, { kind: 1, text: "y" }, null] })?.warnings).toEqual([{ kind: "network", text: "x" }]);
  });
});

describe("TricksSettingsCard: what a contract 2 trick reads (M99)", () => {
  it("says the globs in one sentence under the places, with every machine on a crew's lead", async () => {
    const solo: WireTrickInfo = { ...TRACKER, inputs: { globs: ["TODO.md", "shots/*.png"], crew: false } };
    const crew: WireTrickInfo = { ...LEGS, inputs: { globs: ["TODO.md"], crew: true } };
    renderCard(await storeWith([crew, solo]));
    expect((await within(await findRow("tracker")).findByText(/^Reads /u)).textContent).toBe("Reads TODO.md, shots/*.png in your agent sessions' folders.");
    expect(rowOf("legs").querySelector('[data-line="reads"]')?.textContent).toBe("Reads TODO.md in your agent sessions' folders on every machine of the crew.");
  });

  it("speaks the same words as the version card and collie trick check", () => {
    for (const crew of [false, true]) {
      const globs = ["TODO.md", "notes/*.md"];
      expect(readsLine({ globs, crew })).toBe(inputsSentence(globs, crew));
    }
  });

  it("draws no line for a trick without inputs, and reads a malformed field as none", async () => {
    renderCard(await storeWith([LEGS]));
    await screen.findByRole("switch", { name: "Browser leg" });
    expect(rowOf("legs").querySelector('[data-line="reads"]')).toBeNull();
    const base = { host: "lodge", id: "legs", name: "Legs", icon: "plug", on: false, state: "off", places: ["belt"] };
    expect(readTrick({ ...base, inputs: { globs: ["TODO.md"], crew: true } })?.inputs).toEqual({ globs: ["TODO.md"], crew: true });
    for (const inputs of ["TODO.md", { globs: [], crew: false }, { globs: ["a"] }, { globs: [5], crew: false }, { globs: Array.from({ length: 9 }, () => "a"), crew: false }, { globs: ["x".repeat(257)], crew: true }]) {
      expect(readTrick({ ...base, inputs }), JSON.stringify(inputs).slice(0, 40)).not.toHaveProperty("inputs");
    }
  });
});

describe("TricksSettingsCard: the switch", () => {
  it("posts the new position, flips at once and keeps it", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...TRACKER, on, state: "ok" as const }));
    renderCard(await storeWith([LEGS, TRACKER]), onSwitch);
    const sw = await screen.findByRole("switch", { name: "Tracker" });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(onSwitch).toHaveBeenCalledWith("lodge", "tracker", true);
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeChecked();
    // The other trick's switch is untouched.
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(currentStatus()).toBeNull();
  });

  it("flips before the bridge answers", async () => {
    const user = userEvent.setup();
    let release: (info: WireTrickInfo) => void = () => {};
    const onSwitch = vi.fn(() => new Promise<WireTrickInfo>((resolve) => (release = resolve)));
    renderCard(await storeWith([LEGS]), onSwitch);
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // A second tap while the first is in flight sends nothing.
    await user.click(screen.getByRole("switch", { name: "Browser leg" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    await act(async () => release({ ...LEGS, on: false, state: "off" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
  });

  it("goes back and says so when the bridge refuses", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => Promise.reject(new Error("/api/tricks/lodge/legs/switch → 404")));
    renderCard(await storeWith([LEGS]), onSwitch);
    const sw = await screen.findByRole("switch", { name: "Browser leg" });
    await user.click(sw);
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(currentStatus()).toMatchObject({ text: "Could not switch Browser leg. Try again.", tone: "error" });
  });

  it("lets go of the held position once the list agrees, and after a while if it never does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const reply = (tricks: WireTrickInfo[], rev: number): TricksReply => ({ rev, tricks, parts: [], present: [] });
    let served = reply([LEGS], 5);
    const store = createTricksStore({ fetchTricks: async () => served, tapTrick: async () => Promise.reject(new Error("no")), mintRequestId: () => "r" });
    await store.syncTricks(5);
    renderCard(store, async () => ({ ...LEGS, on: false, state: "off" }));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // The list is still the old one: the held position stands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS - 1000);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // The bridge's list moves to agree.
    served = reply([{ ...LEGS, on: false, state: "off" }], 6);
    await act(async () => {
      await store.syncTricks(6);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // And later the bridge turns it on from the CLI: the card follows the store, not a stale hold.
    served = reply([LEGS], 7);
    await act(async () => {
      await store.syncTricks(7);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
  });

  it("gives the switch back to the list when it never agrees within the hold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCard(await storeWith([LEGS]), async () => ({ ...LEGS, on: false, state: "off" }));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
  });

  it("disables the switches on a device that may only read", async () => {
    renderCard(await storeWith([LEGS]), undefined, true);
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeDisabled();
  });

  it("each write to a trick buys fast polls, and a refused one buys none", async () => {
    resetPollIntent();
    server.use(
      http.post(/\/api\/tricks\/[^/]+\/[^/]+\/(switch|auto|undo)$/, () => HttpResponse.json({ ...TRACKER, on: true, state: "ok" })),
      http.post(/\/api\/tricks\/[^/]+\/[^/]+\/value$/, () => HttpResponse.json({ info: { ...TRACKER, on: true, state: "ok" } })),
      http.post("/api/tricks/switch", () => HttpResponse.json({ on: true })),
    );
    expect(topologyBursting()).toBe(false);
    const writes: (() => Promise<void>)[] = [
      async () => void (await switchTrick("lodge", "tracker", true)),
      async () => void (await setTrickAuto("lodge", "tracker", true)),
      async () => void (await undoTrick("lodge", "tracker")),
      async () => void (await setTrickValue("lodge", "tracker", { rid: "0f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", key: "repo", value: "a" })),
      async () => void (await setTricksSwitch(true)),
    ];
    for (const write of writes) {
      resetPollIntent();
      await write();
      expect(topologyBursting()).toBe(true);
    }
    resetPollIntent();
    server.use(http.post(/\/switch$/, () => HttpResponse.json({ error: "unknown-trick" }, { status: 404 })));
    await expect(switchTrick("lodge", "gone", true)).rejects.toThrow();
    expect(topologyBursting()).toBe(false);
  });

  it("switchTrick posts { on } to the trick's switch route and reads the trick back", async () => {
    let seen: { path: string; body: unknown } | null = null;
    server.use(
      http.post(/\/api\/tricks\/[^/]+\/[^/]+\/switch$/, async ({ request }) => {
        seen = { path: new URL(request.url).pathname, body: await request.json() };
        return HttpResponse.json({ ...TRACKER, on: true, state: "ok" });
      }),
    );
    const info = await switchTrick("blue fin", "tracker", true);
    expect(seen).toEqual({ path: "/api/tricks/blue%20fin/tracker/switch", body: { on: true } });
    expect(info).toMatchObject({ id: "tracker", on: true });
    server.use(http.post(/\/switch$/, () => HttpResponse.json({ nope: 1 })));
    await expect(switchTrick("lodge", "tracker", true)).rejects.toThrow(/not a trick/);
    server.use(http.post(/\/switch$/, () => HttpResponse.json({ error: "unknown-trick" }, { status: 404 })));
    await expect(switchTrick("lodge", "gone", true)).rejects.toThrow();
  });
});

beforeEach(() => {
  clearStatus();
});

// A ROW THAT FAILS DRAWS ALONE (M94 review).
describe("a trick entry that is broken", () => {
  it("draws a trick with no places as a manifest that declares none", async () => {
    const bare: WireTrickInfo = JSON.parse('{"host":"lodge","id":"bare","name":"Bare","icon":"flask","on":true,"state":"ok"}');
    renderCard(await storeWith([bare, TRACKER]));
    expect(within(await findRow("bare")).getByText("No parts")).toBeTruthy();
    expect(placesLine(undefined)).toBe("No parts");
    expect(rowOf("tracker")).toBeTruthy();
  });

  it("keeps a row's switch, labelled by its id, when the row cannot be drawn, and the switch flips", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bomb: WireTrickInfo = {
      ...LEGS,
      get name(): string {
        throw new Error("a name that cannot be read");
      },
      get places(): WireTrickInfo["places"] {
        throw new Error("places that cannot be read");
      },
    };
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...LEGS, on }));
    renderCard(await storeWith([bomb, TRACKER]), onSwitch);
    const row = await findRow("legs");
    expect(row.textContent).toBe("legs");
    const toggle = within(row).getByRole("switch", { name: "legs" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onSwitch).toHaveBeenCalledWith("lodge", "legs", false);
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("leaves the other rows and their switches drawn when one row throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bomb: WireTrickInfo = { ...LEGS, id: "bomb", name: "Bomb", get state(): WireTrickInfo["state"] { throw new Error("a row that cannot be read"); } };
    renderCard(await storeWith([bomb, TRACKER]));
    expect((await findRow("bomb")).hasAttribute("data-fallback")).toBe(true);
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeTruthy();
    vi.restoreAllMocks();
  });
});

// The Hill switched off (bridge/tricks/hill.ts): a trick that asks Decisions keeps running, and its row
// says once that they are not shown. The note takes the provenance's slot, never a trouble report's.
describe("the Hill switched off", () => {
  const ASKS: WireTrickInfo = { ...LEGS, decides: true };

  it("slotLine: the note for a trick that is on and asks, only while the Hill is off", () => {
    expect(slotLine(ASKS, NOW, true)).toEqual({ text: "The Hill is off: this trick's Decisions are not shown.", trouble: false });
    expect(slotLine(ASKS, NOW, false).text).toBe("Added by agent · 2 h ago");
    expect(slotLine(LEGS, NOW, true).text).toBe("Added by agent · 2 h ago");
    expect(slotLine({ ...ASKS, on: false, state: "off" }, NOW, true).text).toBe("Added by agent · 2 h ago");
    // A failing trick's own error wins: the row says what is wrong first.
    expect(slotLine({ ...ASKS, state: "failing", error: "exit 2" }, NOW, true)).toEqual({ text: "exit 2", trouble: true });
  });

  it("fault B: a trick stopped for its rights says so in the phone's words, ahead of every other line", () => {
    const stopped: WireTrickInfo = { ...ASKS, state: "stopped", error: "the bridge's English line", rightsMoved: true, pending: { hash: "a".repeat(64), files: { added: 0, changed: 1, removed: 0 }, powersChanged: false, warnings: [] } };
    expect(slotLine(stopped, NOW, true)).toEqual({ text: "Its rights changed. Switch it on again.", trouble: true });
    // An older bridge sends no flag: its own line stands.
    const { rightsMoved: _flag, ...older } = stopped;
    expect(slotLine(older, NOW, true)).toEqual({ text: "the bridge's English line", trouble: true });
  });

  it("fault B: a stopped trick's switch shows off with the line, and ONE tap on approves the version the row shows", async () => {
    const user = userEvent.setup();
    const approves = "b".repeat(64);
    const stopped: WireTrickInfo = { ...ASKS, on: false, state: "stopped", error: "the bridge's English line", rightsMoved: true, approves, warnings: [{ kind: "network", text: "x" }] };
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean, _hash?: string) => ({ ...LEGS, on, state: "ok" as const }));
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={await storeWith([stopped])} onSwitch={onSwitch} now={NOW} onOfficialList={NO_OFFICIAL} /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    const sw = await screen.findByRole("switch", { name: "Browser leg" });
    expect(sw).not.toBeChecked();
    expect(rowOf("legs").querySelector('[data-line="slot"]')).toHaveTextContent("Its rights changed. Switch it on again.");
    // The rights a yes approves are on the row before the tap, as for a first switch on.
    expect(await within(rowOf("legs")).findByText("This trick reaches the network.")).toBeInTheDocument();
    await user.click(sw);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("lodge", "legs", true, approves);
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
  });

  it("the row reads the snapshot's hillOff from the root data", async () => {
    const store = await storeWith([ASKS, TRACKER]);
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={NO_OFFICIAL} />, loader: () => ({ hillOff: true }) }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await screen.findByText("Browser leg");
    expect(rowOf("legs").querySelector('[data-line="slot"]')).toHaveTextContent("The Hill is off: this trick's Decisions are not shown.");
    expect(rowOf("tracker").querySelector('[data-line="slot"]')).not.toHaveTextContent("The Hill is off");
  });

  it("a row can carry the warnings list and the Hill-off note together", async () => {
    const both: WireTrickInfo = { ...ASKS, changed: true, warnings: [{ kind: "network", text: "x" }] };
    const store = await storeWith([both]);
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={NO_OFFICIAL} />, loader: () => ({ hillOff: true }) }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await screen.findByText("Browser leg");
    expect(rowOf("legs").querySelector('[data-line="slot"]')).toHaveTextContent("The Hill is off: this trick's Decisions are not shown.");
    expect(await within(rowOf("legs")).findByText("This trick reaches the network.")).toBeInTheDocument();
  });
});

// A new version waits (crew slice 2, bridge/tricks/service.ts): the trick keeps running the approved copy,
// and its row says once that a newer folder waits for a yes. The note takes the provenance's slot, never a
// trouble report's, and the row grows no button: the switch, switched on again, is the yes.
describe("a new version waits", () => {
  const PENDING = { hash: "ab".repeat(32), files: { added: 1, changed: 2, removed: 0 }, powersChanged: false, warnings: [] };
  const WAITING: WireTrickInfo = { ...LEGS, pending: PENDING };

  it("slotLine: the note for a trick that is on, after any trouble and before the Hill note", () => {
    expect(slotLine(WAITING, NOW)).toEqual({ text: "A new version waits for your yes.", trouble: false, waits: true });
    // M96 spec 14: the card needs no Hill, so the Hill off changes nothing in the line, trick that asks or not.
    expect(slotLine({ ...WAITING, decides: true }, NOW, true)).toEqual({ text: "A new version waits for your yes.", trouble: false, waits: true });
    expect(slotLine(WAITING, NOW, true).text).toBe("A new version waits for your yes.");
    // A version card the phone holds says it too, with no `pending` on the row (a proposal's new version).
    expect(slotLine(LEGS, NOW, true, true)).toEqual({ text: "A new version waits for your yes.", trouble: false, waits: true });
    // A trick that is off keeps its provenance line, and one in trouble its trouble.
    expect(slotLine({ ...WAITING, on: false, state: "off" }, NOW, true).text).toBe("Added by agent · 2 h ago");
    expect(slotLine({ ...WAITING, on: false, state: "off" }, NOW).text).toBe("Added by agent · 2 h ago");
    expect(slotLine({ ...WAITING, state: "failing", error: "exit 2" }, NOW)).toEqual({ text: "exit 2", trouble: true });
  });

  it("versionCardOpener: only an open version or proposal card of this trick opens from its row", () => {
    const opened: string[] = [];
    const open = (d: HillDecision) => opened.push(d.id);
    const cards = [collieCard("rights", "legs", { id: "rights-legs" }), collieCard("version", "legs", { id: "version-legs" })];
    versionCardOpener(cards, { id: "legs" }, open)?.();
    expect(opened).toEqual(["version-legs"]);
    expect(versionCardOpener(cards, { id: "tracker" }, open)).toBeUndefined();
    expect(versionCardOpener([cards[0]!], { id: "legs" }, open)).toBeUndefined();
  });

  it("the row shows the note and adds no button", async () => {
    renderCard(await storeWith([WAITING, TRACKER]));
    await screen.findByText("Browser leg");
    expect(rowOf("legs").querySelector('[data-line="slot"]')).toHaveTextContent("A new version waits for your yes.");
    expect(rowOf("tracker").querySelector('[data-line="slot"]')).not.toHaveTextContent("A new version waits");
    expect(within(rowOf("legs")).getAllByRole("button").map((b) => b.getAttribute("data-slot"))).toEqual(["trick-about"]);
  });

  // The slot line is a button when the phone holds the version's card. It once carried `truncate` (overflow:
  // hidden) beside a `::before` that reaches 14px past it: the clip cut the tap reach to the drawn 16px, and the
  // box could be scrolled by 14px, which moved the glyphs out and left only the dotted underline (lab run,
  // 2026-11-16). jsdom draws no layout, so this holds the markup that cannot do it; the 44px reach, and the
  // glyphs staying drawn after a scroll, only a browser shows (`document.elementFromPoint` above and below).
  it("the slot line as a button: its text is drawn and the button itself clips nothing", async () => {
    server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev: 1, open: [collieCard("version", "legs", { id: "version-legs" })], closed: [] })));
    await act(async () => {
      syncHill(1, "tricks");
      await __settleHill();
    });
    try {
      renderCard(await storeWith([WAITING, TRACKER]));
      await findRow("legs");
      const button = await vi.waitFor(() => {
        const found = rowOf("legs").querySelector('button[data-line="slot"][data-slot="trick-card-open"]');
        if (!(found instanceof HTMLElement)) throw new Error("no slot button yet");
        return found;
      });
      // The words are in the DOM as one text node, inside the block that truncates.
      expect(button).toHaveTextContent("A new version waits for your yes.");
      const text = button.firstElementChild;
      expect(button.childNodes).toHaveLength(1);
      expect(text?.tagName).toBe("SPAN");
      expect(text?.classList.contains("truncate")).toBe(true);
      expect(text?.textContent).toBe("A new version waits for your yes.");
      // No class that clips or hides on the button: it is the box the `::before` reaches out of.
      const classes = [...button.classList];
      const clipping = classes.filter((name) => /^(truncate|overflow|text-ellipsis|text-clip|line-clamp|sr-only|hidden|invisible|opacity-0|text-transparent|text-\[0)/u.test(name));
      expect(clipping).toEqual([]);
      // The reach that gives the 44px floor, and the stacking above the row's layer, stay on the button.
      expect(classes).toEqual(expect.arrayContaining(["relative", "z-10", "before:-inset-y-3.5", "before:inset-x-0"]));
      // The same size and colour as the plain line it replaces.
      expect(classes).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground"]));
    } finally {
      __resetHill();
    }
  });

  it("readTrick keeps a well-formed pending and drops a malformed one", () => {
    const base = { host: "lodge", id: "legs", name: "Legs", icon: "plug", on: true, state: "ok", places: ["belt"] };
    expect(readTrick(base)).not.toHaveProperty("pending");
    expect(readTrick({ ...base, pending: PENDING })?.pending).toEqual(PENDING);
    const warned = { ...PENDING, warnings: [{ kind: "network", text: "x" }, 7] };
    expect(readTrick({ ...base, pending: warned })?.pending?.warnings).toEqual([{ kind: "network", text: "x" }]);
    expect(readTrick({ ...base, pending: { ...PENDING, hash: 5 } })).not.toHaveProperty("pending");
    expect(readTrick({ ...base, pending: { ...PENDING, files: { added: -1, changed: 0, removed: 0 } } })).not.toHaveProperty("pending");
    expect(readTrick({ ...base, pending: { ...PENDING, powersChanged: "yes" } })).not.toHaveProperty("pending");
    expect(readTrick({ ...base, pending: "soon" })).not.toHaveProperty("pending");
  });
});

describe("take changes without asking, and undo an automatic change (crew slice 3)", () => {
  function renderWith(store: TricksStore, calls: { onAuto?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>; onUndo?: (host: string, id: string) => Promise<WireTrickInfo> }) {
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onAuto={calls.onAuto} onUndo={calls.onUndo} onOfficialList={NO_OFFICIAL} /> }], { initialEntries: ["/"] });
    return render(<RouterProvider router={router} />);
  }

  it("draws no auto switch and no hint on the card, for a trick that is on or off: the switch lives in the About sheet", async () => {
    renderWith(await storeWith([{ ...LEGS, auto: false }, TRACKER]), {});
    await screen.findByText("Browser leg");
    expect(screen.queryByText("Take changes without asking")).toBeNull();
    expect(screen.queryByText(/still asks\./)).toBeNull();
    // The two rows' own switches are the only ones.
    expect(screen.getAllByRole("switch").map((sw) => sw.getAttribute("aria-label"))).toEqual(["Browser leg", "Tracker"]);
    expect(rowOf("legs").querySelector('[data-line="changes"]')).toBeNull();
    expect(rowOf("legs").querySelector('[data-line="auto-at"]')).toBeNull();
  });

  it("posts the new position from the sheet, flips at once, and goes back with a status line when the bridge refuses", async () => {
    const user = userEvent.setup();
    const onAuto = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...LEGS, auto: on }));
    renderWith(await storeWith([LEGS]), { onAuto });
    await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
    const sw = () => within(screen.getByRole("dialog")).getByRole("switch", { name: "Take changes without asking" });
    await user.click(sw());
    expect(onAuto).toHaveBeenCalledWith("lodge", "legs", true);
    expect(sw()).toBeChecked();
    onAuto.mockRejectedValueOnce(new Error("409"));
    await user.click(sw());
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("Could not change Browser leg. Try again."));
    // Back to what the bridge's list says, which has not moved.
    expect(sw()).not.toBeChecked();
  });

  it("says when a version was taken without asking, and Undo asks for a second tap before it goes back", async () => {
    const onUndo = vi.fn(async () => ({ ...LEGS, auto: true }));
    renderWith(await storeWith([{ ...LEGS, auto: true, autoAt: "2026-11-08T07:41:00Z" }]), { onUndo });
    await screen.findByText("Browser leg");
    const line = rowOf("legs").querySelector<HTMLElement>('[data-line="auto-at"]');
    expect(line).toHaveTextContent("Updated 2 h ago, automatically.");
    const undo = within(line!).getByRole("button");
    const front = () => undo.querySelector("[data-active]")?.textContent;
    expect(front()).toBe("Undo");
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    fireEvent.click(undo);
    expect(onUndo).not.toHaveBeenCalled();
    expect(front()).toBe("Undo?");
    expect(undo.className).toContain("text-destructive");
    // Inside the dwell the same touch landing twice does nothing; after it, the second tap goes back.
    clock.mockReturnValue(t0 + 100);
    fireEvent.click(undo);
    expect(onUndo).not.toHaveBeenCalled();
    clock.mockReturnValue(t0 + 600);
    await act(async () => fireEvent.click(undo));
    expect(onUndo).toHaveBeenCalledWith("lodge", "legs");
    clock.mockRestore();
  });

  it("autoLine: only for a trick that is on with a time it can read", () => {
    expect(autoLine({ on: true, autoAt: "2026-11-08T09:38:00Z" }, NOW)).toBe("Updated 3 min ago, automatically.");
    expect(autoLine({ on: false, autoAt: "2026-11-08T09:38:00Z" }, NOW)).toBeNull();
    expect(autoLine({ on: true }, NOW)).toBeNull();
    expect(autoLine({ on: true, autoAt: "soon" }, NOW)).toBeNull();
  });

  it("readTrick keeps a boolean auto and a time autoAt, and drops either of another shape", () => {
    const base = { host: "lodge", id: "legs", name: "Legs", icon: "plug", on: true, state: "ok", places: ["belt"] };
    expect(readTrick({ ...base, auto: true, autoAt: "2026-11-08T07:41:00Z" })).toMatchObject({ auto: true, autoAt: "2026-11-08T07:41:00Z" });
    expect(readTrick({ ...base, auto: "yes", autoAt: 5 })).not.toHaveProperty("auto");
    expect(readTrick({ ...base, auto: "yes", autoAt: "later" })).not.toHaveProperty("autoAt");
  });
});

describe("the auto and undo calls (crew slice 3)", () => {
  it("setTrickAuto posts { on } and undoTrick posts {}, each to its route, and read the trick back", async () => {
    const seen: { path: string; body: unknown }[] = [];
    server.use(
      http.post(/\/api\/tricks\/[^/]+\/[^/]+\/(auto|undo)$/, async ({ request }) => {
        seen.push({ path: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ ...LEGS, auto: true });
      }),
    );
    expect(await setTrickAuto("blue fin", "legs", true)).toMatchObject({ id: "legs", auto: true });
    expect(await undoTrick("lodge", "legs")).toMatchObject({ id: "legs" });
    expect(seen).toEqual([
      { path: "/api/tricks/blue%20fin/legs/auto", body: { on: true } },
      { path: "/api/tricks/lodge/legs/undo", body: {} },
    ]);
    server.use(http.post(/\/undo$/, () => HttpResponse.json({ error: "no-previous", message: "There is no earlier version to go back to." }, { status: 409 })));
    await expect(undoTrick("lodge", "legs")).rejects.toThrow();
  });
});

describe("TricksSettingsCard: a trick's About sheet", () => {
  const TOLD: WireTrickInfo = { ...LEGS, description: "Shows the browser leg.", about: "First paragraph.\n\nSecond paragraph." };

  it("draws the description under the name, and no line for a trick without one", async () => {
    renderCard(await storeWith([TOLD, TRACKER]));
    await screen.findByText("Browser leg");
    expect(rowOf("legs").querySelector('[data-line="description"]')).toHaveTextContent("Shows the browser leg.");
    expect(rowOf("tracker").querySelector('[data-line="description"]')).toBeNull();
  });

  it("gives the name a muted chevron inside the button, hidden from assistive tech, and the description the places line's muted style", async () => {
    renderCard(await storeWith([TOLD]));
    const button = await screen.findByRole("button", { name: "About Browser leg" });
    const glyph = button.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.getAttribute("class")).toContain("text-muted-foreground");
    // The name, then the label of where it comes from, both inside the one button.
    expect(button.textContent).toBe("Browser legCommunity");
    expect(button.querySelector('[data-slot="trick-origin"]')?.getAttribute("data-origin")).toBe("community");
    const description = (await findRow("legs")).querySelector('[data-line="description"]');
    expect(description?.className).toContain("text-muted-foreground");
    expect(description?.className).toContain("line-clamp-2");
    expect(rowOf("legs").querySelector('[data-line="places"]')?.className).toContain("text-muted-foreground");
  });

  it("opens the sheet from the name, and the switch stays its own tap target", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...TOLD, on, state: "ok" as const }));
    renderCard(await storeWith([TOLD]), onSwitch);
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "About Browser leg" }));
    const dialog = screen.getByRole("dialog", { name: "Browser leg" });
    expect(within(dialog).getByText("First paragraph.")).toBeInTheDocument();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The whole row opens the sheet (2026-11-12). jsdom lays nothing out, so a tap on a line cannot be
  // aimed here: this holds the structure the real engine needs, and e2e/tricks-row-taps.spec.ts aims the
  // taps (elementFromPoint) in Chromium.
  it("makes the whole row the About button's reach: one button, a stretched layer, and the switch above it as a sibling", async () => {
    renderCard(await storeWith([TOLD]));
    const row = await findRow("legs");
    const button = within(row).getByRole("button", { name: "About Browser leg" });
    // One open action, with the name it always had, and no control inside another.
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("data-slot"))).toEqual(["trick-about"]);
    expect(button.querySelector("button, [role='switch']")).toBeNull();
    const toggle = within(row).getByRole("switch", { name: "Browser leg" });
    expect(button.contains(toggle)).toBe(false);
    // The layer: the row is the positioned box, the button's ::after fills it, the switch stands above it.
    expect(row.className).toContain("relative");
    expect(button.className).toContain("after:absolute");
    expect(button.className).toContain("after:inset-0");
    expect(button.className).not.toMatch(/(^|\s)relative(\s|$)/);
    expect(toggle.className).toContain("z-10");
    // Every line of the row is plain text under that layer, never a control of its own.
    for (const line of ["description", "places", "slot"]) {
      const el = row.querySelector(`[data-line="${line}"]`);
      expect(el, line).not.toBeNull();
      expect(el?.closest("button"), line).toBeNull();
    }
  });

  it("toggles on a tap on the switch and opens no sheet; the name opens it", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...TOLD, on, state: "ok" as const }));
    renderCard(await storeWith([{ ...TOLD, on: false, state: "off" }]), onSwitch);
    const toggle = await screen.findByRole("switch", { name: "Browser leg" });
    await user.click(toggle);
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0]?.[2]).toBe(true);
    expect(toggle).toBeChecked();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("the Updates switch in the sheet", () => {
    const sheetSwitch = () => within(screen.getByRole("dialog")).getByRole("switch", { name: "Take changes without asking" });

    it("holds the position the sheet's switch was flipped to, while the write is in flight and after", async () => {
      const user = userEvent.setup();
      const onAutoPost = vi.fn();
      server.use(
        http.post("/api/tricks/:host/:id/auto", async ({ request }) => {
          const on = (await request.text()).includes('"on":true');
          onAutoPost(on);
          return HttpResponse.json({ ...TOLD, auto: on });
        }),
      );
      renderCard(await storeWith([TOLD]));
      await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
      expect(within(rowOf("legs")).queryByText("Take changes without asking")).toBeNull();
      expect(sheetSwitch()).not.toBeChecked();
      await user.click(sheetSwitch());
      await vi.waitFor(() => expect(onAutoPost).toHaveBeenCalledWith(true));
      expect(sheetSwitch()).toBeChecked();
    });

    it("goes back and says it in the status line when the write fails, as the trick's own switch does", async () => {
      const user = userEvent.setup();
      server.use(http.post("/api/tricks/:host/:id/auto", () => HttpResponse.json({ error: "no" }, { status: 500 })));
      renderCard(await storeWith([TOLD]));
      await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
      await user.click(sheetSwitch());
      await vi.waitFor(() => expect(currentStatus()?.text).toBe("Could not change Browser leg. Try again."));
      expect(sheetSwitch()).not.toBeChecked();
    });

    it("is not in the sheet of a trick that is off", async () => {
      const user = userEvent.setup();
      renderCard(await storeWith([{ ...TOLD, on: false, state: "off" }]));
      await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByText("Updates")).toBeNull();
      expect(within(dialog).queryByRole("switch")).toBeNull();
    });
  });

  it("reads description and about off the wire tolerantly", () => {
    const base = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"] };
    expect(readTrick({ ...base, description: "One line.", about: "a\n\nb" })).toMatchObject({ description: "One line.", about: "a\n\nb" });
    expect(readTrick(base)).not.toHaveProperty("about");
    expect(readTrick({ ...base, about: 4, description: ["x"] })).not.toHaveProperty("about");
    expect(readTrick({ ...base, about: 4, description: ["x"] })).not.toHaveProperty("description");
    expect(readTrick({ ...base, description: "d".repeat(DESCRIPTION_MAX + 1) })).not.toHaveProperty("description");
    expect(readTrickText("a".repeat(ABOUT_MAX), "about")).toHaveLength(ABOUT_MAX);
    expect(readTrickText("a".repeat(ABOUT_MAX + 1), "about")).toBeUndefined();
    expect(readTrickText("hidden\u202Emark", "about")).toBeUndefined();
    expect(readTrickText("two\nlines", "description")).toBeUndefined();
  });
});

describe("an agent view (contract 2)", () => {
  const VIEW_TRICK: WireTrickInfo = {
    host: "lodge",
    id: "morph",
    name: "Morph",
    icon: "eye",
    on: false,
    state: "off",
    places: [],
    agentView: true,
    rules: { file: "rules.md", text: "Draw one screen.\n" },
    refusals: [],
    provenance: { via: "folder" },
  };

  it("lists the trick with agent view as its place, no later note, and a switch that switches it on", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => ({ ...VIEW_TRICK, on: true, state: "ok" as const }));
    renderCard(await storeWith([VIEW_TRICK]), onSwitch);
    const row = await findRow("morph");
    expect(row.querySelector('[data-line="places"]')).toHaveTextContent(/^agent view$/u);
    expect(row.querySelector('[data-line="later"]')).toBeNull();
    expect(row.querySelector('[data-line="slot"]')?.getAttribute("data-trouble")).toBeNull();
    await user.click(within(row).getByRole("switch", { name: "Morph" }));
    expect(onSwitch).toHaveBeenCalledWith("lodge", "morph", true);
  });

  it("places beside the view keep their words, the view comes last", () => {
    expect(placesLine(["belt"], true)).toBe("belt, agent view");
    expect(placesLine([], false)).toBe("No parts");
  });

  it("the wire keeps agentView and rules only in their shapes, and a trick with rules never reads as auto", () => {
    const wire = (extra: JsonObject) => readTrick(JSON.parse(JSON.stringify({ ...VIEW_TRICK, ...extra })));
    expect(wire({})?.rules).toEqual({ file: "rules.md", text: "Draw one screen.\n" });
    expect(wire({})?.agentView).toBe(true);
    expect(wire({ agentView: "yes" })?.agentView).toBeUndefined();
    expect(wire({ auto: true })?.auto).toBe(false);
    for (const rules of [{ file: "../rules.md", text: "x\n" }, { file: "rules.md", text: "tab\there\n" }, { file: "rules.md", text: "café\n" }, { file: "rules.md", text: "a‮b\n" }, { file: "rules.md", text: "" }, { file: "rules.md" }, "rules.md"]) {
      expect(wire({ rules })?.rules, JSON.stringify(rules)).toBeUndefined();
    }
  });
});

describe("review 8 V-N5: rules the phone cannot show", () => {
  const BAD: WireTrickInfo = {
    host: "lodge",
    id: "morph",
    name: "Morph",
    icon: "eye",
    on: false,
    state: "off",
    places: [],
    agentView: true,
    provenance: { via: "folder" },
  };
  const UNSHOWN = "This phone cannot show these agent instructions, so the trick cannot be switched on here. Read them and switch it on on the machine.";

  it("the wire keeps that rules were sent but could not be read, and a view without rules counts the same", () => {
    const wire = (extra: JsonObject) => readTrick(JSON.parse(JSON.stringify({ ...BAD, ...extra })));
    expect(wire({ rules: { file: "rules.md", text: "tab\there\n" } })?.rulesUnshown).toBe(true);
    expect(wire({})?.rulesUnshown).toBe(true);
    expect(wire({ rules: { file: "rules.md", text: "Draw.\n" } })?.rulesUnshown).toBeUndefined();
  });

  it("the row says so and its switch cannot switch the trick on; one that is on can still be switched off", async () => {
    const store = await storeWith([{ ...BAD, rulesUnshown: true }, { ...BAD, id: "view-on", name: "View on", on: true, state: "ok", rulesUnshown: true }]);
    renderCard(store);
    const row = await findRow("morph");
    expect(row.querySelector('[data-line="rules-unshown"]')).toHaveTextContent(UNSHOWN);
    expect(within(row).getByRole("switch", { name: "Morph" })).toBeDisabled();
    expect(within(rowOf("view-on")).getByRole("switch", { name: "View on" })).toBeEnabled();
  });
});

// REVIEW 3, ITEM 4: a level word a newer bridge sends that this phone does not know is kept as `unknown`. The row
// says one fixed line and offers no switch on; a trick that is on can still go off.
describe("review 3 item 4: a level of access the phone does not know", () => {
  const LINE = "It asks for access this app does not know yet. Update the app before you say yes.";
  const OFF: WireTrickInfo = { host: "lodge", id: "gauge", name: "Gauge", icon: "eye", on: false, state: "off", places: ["belt"], provenance: { via: "folder" }, access: "unknown" };

  it("the row says the one line and its switch cannot switch the trick on; one that is on can still be switched off", async () => {
    const store = await storeWith([OFF, { ...OFF, id: "gauge-on", name: "Gauge on", on: true, state: "ok" }, { ...OFF, id: "plain", name: "Plain", access: "see" }]);
    renderCard(store);
    const row = await findRow("gauge");
    expect(row.querySelector('[data-line="access-unknown"]')).toHaveTextContent(LINE);
    expect(within(row).getByRole("switch", { name: "Gauge" })).toBeDisabled();
    expect(within(rowOf("gauge-on")).getByRole("switch", { name: "Gauge on" })).toBeEnabled();
    expect(rowOf("plain").querySelector('[data-line="access-unknown"]')).toBeNull();
    expect(within(rowOf("plain")).getByRole("switch", { name: "Plain" })).toBeEnabled();
  });
});

describe("review 8 V-N1: a switch on names the code the person read", () => {
  it("sends the hash the row shows, and when the trick changed since, says so and stays off", async () => {
    const user = userEvent.setup();
    const hash = "a".repeat(64);
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/tricks/lodge/legs/switch", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ error: "moved", message: "The trick changed after you read it. Read it again, then switch it on." }, { status: 409 });
      }),
    );
    renderCard(await storeWith([{ ...LEGS, on: false, state: "off", approves: hash }]));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("The trick changed after you read it. Read it again, then switch it on."));
    expect(bodies).toEqual([{ on: true, hash }]);
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
  });

  it("a switch-on refused with 409 not-whole says Collie cannot show all of the code, and stays off; another failure keeps the generic line", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/tricks/lodge/legs/switch", () => HttpResponse.json({ error: "not-whole", message: "The bridge's own words." }, { status: 409 })));
    renderCard(await storeWith([{ ...LEGS, on: false, state: "off" }]));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("Collie cannot show all of its code as it is, so it stays off."));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // The same word on another status is not this refusal, and any other failure is the generic line.
    server.use(http.post("/api/tricks/lodge/legs/switch", () => HttpResponse.json({ error: "not-whole", message: "x" }, { status: 500 })));
    await user.click(screen.getByRole("switch", { name: "Browser leg" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("Could not switch Browser leg. Try again."));
    server.use(http.post("/api/tricks/lodge/legs/switch", () => HttpResponse.json({ error: "busy", message: "x" }, { status: 409 })));
    await user.click(screen.getByRole("switch", { name: "Browser leg" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("Could not switch Browser leg. Try again."));
  });

  it("on Windows a shell run line is refused at switch-on with the one sentence (fault d), and the phone's copy is the bridge's words", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/tricks/lodge/legs/switch", () => HttpResponse.json({ error: "windows-shell", message: TRICKS_WINDOWS_SHELL_LINE }, { status: 409 })));
    renderCard(await storeWith([{ ...LEGS, on: false, state: "off" }]));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe(TRICKS_WINDOWS_SHELL_LINE));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
  });

  it("an official add refused for a POSIX trick on Windows says the same sentence (fault d, review D item 5)", async () => {
    server.use(http.post("/api/tricks/official/legs/add", () => HttpResponse.json({ error: "windows-shell", message: TRICKS_WINDOWS_SHELL_LINE }, { status: 409 })));
    let line = "";
    try {
      await addOfficialTrick("legs", "add");
    } catch (thrown) {
      line = officialFailureLine(thrown, "add", "Legs");
    }
    expect(line).toBe(TRICKS_WINDOWS_SHELL_LINE);
  });

  it("the wire keeps approves only as 64 hex", () => {
    expect(readTrick(JSON.parse(JSON.stringify({ ...LEGS, approves: "b".repeat(64) })))?.approves).toBe("b".repeat(64));
    expect(readTrick(JSON.parse(JSON.stringify({ ...LEGS, approves: "nope" })))?.approves).toBeUndefined();
  });
});

// Tricks switched off as a whole (components/tricks-switch-card.tsx): the list stays readable, every control
// that writes is disabled, and one line says why.
describe("tricks switched off as a whole", () => {
  const AUTO: WireTrickInfo = { ...LEGS, auto: true, autoAt: "2026-11-08T09:30:00Z" };

  function renderOff(store: TricksStore, loader?: () => object, tricksOff?: boolean) {
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={NO_OFFICIAL} tricksOff={tricksOff} />, loader }], { initialEntries: ["/"] });
    return render(<RouterProvider router={router} />);
  }

  it("on: the switches are enabled and the line is absent", async () => {
    const store = await storeWith([AUTO, TRACKER]);
    renderOff(store);
    await findRow("legs");
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeEnabled();
    expect(document.querySelector('[data-line="tricks-off"]')).toBeNull();
  });

  it("the snapshot's tricksOff: every switch and Undo is disabled, one line says why, once, at the top", async () => {
    const store = await storeWith([AUTO, TRACKER]);
    renderOff(store, () => ({ tricksOff: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-line="tricks-off"]')).not.toBeNull());
    await findRow("legs");
    const lines = document.querySelectorAll('[data-line="tricks-off"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe("Tricks are switched off on this machine; switch them on in Settings, Experiments.");
    expect(screen.getByTestId("tricks-settings").firstElementChild).toBe(lines[0]);
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeDisabled();
    expect(rowOf("legs").querySelector('[data-slot="trick-undo"]')).toBeDisabled();
    // The rows stay readable: a trick's own position is shown as it was kept.
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Tracker" })).not.toBeChecked();
  });

  it("the reply's off: the same", async () => {
    const reply: TricksReply = { rev: 5, tricks: [LEGS], parts: [], present: [], off: true };
    const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
    await store.syncTricks(5);
    renderOff(store);
    await findRow("legs");
    expect(document.querySelector('[data-line="tricks-off"]')).not.toBeNull();
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeDisabled();
  });

  it("the About sheet still opens, and its take-changes switch is disabled", async () => {
    const store = await storeWith([AUTO]);
    renderOff(store, undefined, true);
    const row = await findRow("legs");
    await userEvent.click(within(row).getByRole("button", { name: /Browser leg/ }));
    const auto = await screen.findByRole("switch", { name: "Take changes without asking" });
    expect(auto).toBeDisabled();
  });

  it("Add is disabled on an official entry", async () => {
    const store = await storeWith([]);
    const entry = { id: "morph", name: "Morph", description: "Shapes things.", repo: "https://example.test/morph", repoName: "owner/morph", commit: "a".repeat(40), state: "absent" } as const;
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={async () => ({ tricks: [entry] })} tricksOff /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("button", { name: "Add Morph" })).toBeDisabled();
  });
});

describe("TricksSettingsCard: one request id per settings edit (review G, point 6)", () => {
  const WITH_FIELDS: WireTrickInfo = { ...LEGS, fields: [{ key: "repo", kind: "text", label: "Repository" }] };

  it("a retry of the same edit reuses its id, a new value or a later edit after the write took gets a new one", async () => {
    const user = userEvent.setup();
    const rids: string[] = [];
    let fail = true;
    const onSetValue = vi.fn(async (_host: string, _id: string, body: { rid: string; key: string; value: string | number | boolean | null }) => {
      rids.push(body.rid);
      if (fail) throw new Error("offline");
      return WITH_FIELDS;
    });
    const store = await storeWith([WITH_FIELDS]);
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={NO_OFFICIAL} onSetValue={onSetValue} /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
    const dialog = screen.getByRole("dialog", { name: "Browser leg" });
    const box = within(dialog).getByLabelText(/Repository/);
    // The write fails and the box goes back to the saved text: the same value typed again is a retry of the same edit.
    await user.type(box, "lodge/workshop");
    await user.tab();
    expect(rids).toHaveLength(1);
    fail = false;
    await user.type(box, "lodge/workshop");
    await user.tab();
    expect(rids).toHaveLength(2);
    expect(rids[1]).toBe(rids[0]);
    // A new edit (another value) gets a new id.
    await user.clear(box);
    await user.type(box, "lodge/other");
    await user.tab();
    expect(rids).toHaveLength(3);
    expect(rids[2]).not.toBe(rids[0]);
  });

  it("writes a value on a plain-HTTP page, where crypto.randomUUID does not exist", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const user = userEvent.setup();
      const rids: string[] = [];
      const onSetValue = vi.fn(async (_host: string, _id: string, body: { rid: string; key: string; value: string | number | boolean | null }) => {
        rids.push(body.rid);
        return WITH_FIELDS;
      });
      const store = await storeWith([WITH_FIELDS]);
      const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onOfficialList={NO_OFFICIAL} onSetValue={onSetValue} /> }], { initialEntries: ["/"] });
      render(<RouterProvider router={router} />);
      await user.click(await screen.findByRole("button", { name: "About Browser leg" }));
      await user.type(within(screen.getByRole("dialog", { name: "Browser leg" })).getByLabelText(/Repository/), "lodge/workshop");
      await user.tab();
      expect(rids).toHaveLength(1);
      expect(rids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
