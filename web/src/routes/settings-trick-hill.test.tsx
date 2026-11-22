import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HILL_DOCS_URL, HILL_POST_COMMAND, HillDetail, SKILL_STATUS_COMMAND } from "@/components/hill-page";
import { ARM_DWELL_MS } from "@/lib/arm";
import { en } from "@/lib/i18n/messages/en";
import { HILL_DETAIL_KEY, readTrickDetailKey, trickDetailPath } from "@/lib/nav";
import { RESERVED_TRICK_IDS, type TricksReply, type WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { renderTricksPages } from "@/test/tricks-pages";

// THE HILL'S DETAILS PAGE, `settings/tricks/hill` (2026-11-22): one page in the family of a trick's details, with the answers a
// person needs when the Hill is on and no Decision arrives. The route opens it with the Tricks switch on and off, on a store
// that holds no reply, and never redirects; the key cannot be a trick's.

const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: false, state: "off", places: ["belt"], provenance: { via: "agent" } };

async function storeWith(tricks: WireTrickInfo[]): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

const detail = () => document.querySelector<HTMLElement>('[data-slot="trick-detail"]')!;
const section = (slot: string) => detail().querySelector<HTMLElement>(`[data-section="${slot}"]`)!;

/** The page over props, in a router, for the cases that need a value of their own. */
function page(props: { on?: boolean; disabled?: boolean; waiting?: number; onToggle?: (next: boolean) => void }) {
  return render(
    <MemoryRouter>
      <HillDetail on={props.on ?? true} disabled={props.disabled ?? false} waiting={props.waiting ?? 0} onToggle={props.onToggle ?? (() => {})} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("the address settings/tricks/hill", () => {
  it("draws the Hill's page with tricks on, titled and headed The Hill", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), entries: [trickDetailPath(HILL_DETAIL_KEY)] });
    expect(await screen.findByRole("heading", { name: "The Hill" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["The Hill"]);
    expect(document.querySelector('[data-slot="settings-page-title"]')).toHaveTextContent("Trick details");
    expect(detail().getAttribute("data-detail-hill")).toBe("");
  });

  it("draws it with tricks switched off as a whole, with no redirect", async () => {
    const router = renderTricksPages({ store: await storeWith([LEGS]), loader: () => ({ tricksOff: true }), entries: ["/settings/tricks/hill"] });
    expect(await screen.findByRole("heading", { name: "The Hill" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/tricks/hill");
  });

  it("draws it where the phone holds no tricks reply yet", async () => {
    const store = createTricksStore({ fetchTricks: async () => ({ rev: 1, tricks: [], parts: [], present: [] }), tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
    renderTricksPages({ store, entries: ["/settings/tricks/hill"] });
    expect(await screen.findByRole("heading", { name: "The Hill" })).toBeInTheDocument();
  });

  it("is never a trick's page: the key is reserved, and a trick on a machine keeps its own host:id key", async () => {
    expect(RESERVED_TRICK_IDS).toContain(HILL_DETAIL_KEY);
    expect(readTrickDetailKey("lodge:hill")).toEqual({ kind: "trick", host: "lodge", id: "hill" });
    renderTricksPages({ store: await storeWith([LEGS]), entries: ["/settings/tricks/lodge%3Alegs"] });
    expect(await screen.findByRole("heading", { name: "Browser leg" })).toBeInTheDocument();
    expect(detail().getAttribute("data-detail-hill")).toBeNull();
  });

  it("Back goes up to the Tricks page", async () => {
    const router = renderTricksPages({ store: await storeWith([LEGS]), entries: ["/settings/tricks", "/settings/tricks/hill"] });
    await screen.findByRole("heading", { name: "The Hill" });
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
  });
});

describe("the page's words", () => {
  it("heads it with the mountain, the three labels and the switch with its state in words", () => {
    page({ on: true });
    const head = section("head");
    expect(head.querySelector('[data-slot="trick-detail-name"]')).toHaveTextContent("The Hill");
    const labels = head.querySelector('[data-slot="trick-detail-labels"]')!;
    expect(labels).toHaveTextContent("Built in");
    expect(labels.querySelector('[data-slot="experimental-badge"]')).not.toBeNull();
    expect(labels.querySelector('[data-slot="token-use"]')).toHaveTextContent("Uses agent tokens");
    expect(within(head).getByRole("switch", { name: "The Hill" })).toBeChecked();
    expect(head).toHaveTextContent("On");
  });

  it("says Off in the head when the Hill is off", () => {
    page({ on: false });
    expect(section("head")).toHaveTextContent("Off");
  });

  it("About holds the three paragraphs and no note that the trick's author wrote them", () => {
    page({});
    const about = section("about-group");
    expect(within(about).getByText("About")).toBeInTheDocument();
    expect([...about.querySelectorAll("p")].map((p) => p.textContent)).toEqual([en["settings.hill.about.1"], en["settings.hill.about.2"], en["settings.hill.about.3"]]);
    expect(detail().querySelector('[data-line="author-note"]')).toBeNull();
    expect(en["settings.hill.about.1"]).toContain("one question from an agent or a trick, with up to five answers");
  });

  it("names who can ask, with the command on a chip", () => {
    page({});
    const who = section("who");
    expect(within(who).getByText("Who can ask")).toBeInTheDocument();
    const agent = who.querySelector('[data-line="who-agent"]')!;
    expect(agent.textContent).toBe("An agent posts with the command collie hill post. It learns that command from Collie's skill, and the skill holds the Hill's lines only while the Hill is on.");
    expect(agent.querySelector('[data-slot="trick-value"]')?.textContent).toBe(HILL_POST_COMMAND);
    expect(who.querySelector('[data-line="who-trick"]')).toHaveTextContent("A trick posts when its code does.");
    expect(who.querySelector('[data-line="who-collie"]')).toHaveTextContent("Collie posts its own cards: a trick that an agent proposes, and a new version of a trick's code.");
  });

  it("says when a notification is sent, and names the Notifications page and its row by their own words", () => {
    page({});
    const rings = section("rings");
    expect(within(rings).getByText("When you get a notification")).toBeInTheDocument();
    expect(rings.querySelector('[data-line="rings-now"]')).toHaveTextContent("Only a Decision marked Now sends a notification.");
    expect(rings.querySelector('[data-line="rings-state"]')).toHaveTextContent("While your crew state is Quiet or Away, no notification is sent.");
    // The page's name and the row's label are the catalog's own, so the sentence never drifts from the page it points at.
    expect(rings.querySelector('[data-line="rings-setting"]')?.textContent).toBe(`The notification has its own switch in Settings, ${en["settings.page.notifications.title"]}: ${en["settings.notify.decisionNow.label"]}.`);
    expect(en["settings.page.notifications.title"]).toBe("Notifications");
  });

  it("says what to do when nothing arrives, including how to see that the skill is installed", () => {
    page({});
    const quiet = section("quiet");
    expect(within(quiet).getByText("If nothing arrives")).toBeInTheDocument();
    expect(quiet.querySelector('[data-line="quiet-choice"]')).toHaveTextContent("An agent decides by itself when to post.");
    expect(quiet.querySelector('[data-line="quiet-tell"]')?.textContent).toBe("To get more questions here, tell your agents to post them to the Hill, for example in your project's AGENTS.md or CLAUDE.md.");
    expect(quiet.querySelector('[data-line="quiet-fresh"]')).toHaveTextContent("Start a new session.");
    expect(quiet.querySelector('[data-line="quiet-skill"]')?.textContent).toBe("Collie's skill must be installed for your agent. Check with collie skill status.");
    expect(SKILL_STATUS_COMMAND).toBe("collie skill status");
  });

  it("says where it comes from and that it is an experiment, then offers the docs", () => {
    page({});
    const from = section("from");
    expect(within(from).getByText("Where it comes from")).toBeInTheDocument();
    expect(from.querySelector('[data-line="from"]')).toHaveTextContent("The Hill ships with Collie. There is nothing to add or to update.");
    expect(from.querySelector('[data-line="experiment"]')).toHaveTextContent("An experiment: it may change, lose settings, or be withdrawn in a patch release.");
    const docs = screen.getByRole("link", { name: "Read more in the docs" });
    expect(docs.getAttribute("href")).toBe(HILL_DOCS_URL);
    expect(HILL_DOCS_URL).toBe("https://colliepwa.dev/docs/hill");
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("holds the sections in order and none of a trick's own: no Updates, no code folds, no Remove, no rules", () => {
    page({});
    expect([...detail().querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section"))).toEqual(["head", "about-group", "about", "who", "rings", "quiet", "test", "from"]);
    expect(screen.queryByText(/Update this trick/)).toBeNull();
    expect(detail().querySelector('[data-slot="trick-remove"], [data-section="code"], [data-section="remove"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });
});

describe("the head's switch", () => {
  it("turns on with one tap and never asks", () => {
    const onToggle = vi.fn();
    page({ on: false, waiting: 3, onToggle });
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("turns off at once when no Decision waits", () => {
    const onToggle = vi.fn();
    page({ onToggle });
    fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("arms the first tap off while Decisions wait, shows the row's warning line, and the second tap switches off", () => {
    const onToggle = vi.fn();
    page({ waiting: 3, onToggle });
    const sw = screen.getByRole("switch", { name: "The Hill" });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    // The note sits below the switch and is drawn only while armed: no slot is held before the tap.
    expect(document.querySelector('[data-line="armed"], [data-slot="armed-slot"]')).toBeNull();
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
    expect(sw).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 questions wait on the Hill. You cannot answer them while it is off.");
    clock.mockReturnValue(t0 + ARM_DWELL_MS + 200);
    act(() => fireEvent.click(sw));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
    clock.mockRestore();
  });

  it("draws the note below the switch while armed and takes it away when the arm lapses, with no ghost left", () => {
    vi.useFakeTimers();
    try {
      page({ waiting: 2 });
      const head = section("head");
      fireEvent.click(screen.getByRole("switch", { name: "The Hill" }));
      const note = head.querySelector('[data-line="armed"]')!;
      expect(note.getAttribute("aria-hidden")).toBeNull();
      expect(note.className).not.toContain("invisible");
      // The switch's row comes first; the note follows it in the head.
      expect(head.querySelector('[data-slot="trick-detail-switch"]')!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      act(() => vi.advanceTimersByTime(5000));
      expect(head.querySelector('[data-line="armed"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is disabled where the device may not write", () => {
    page({ disabled: true });
    expect(screen.getByRole("switch", { name: "The Hill" })).toBeDisabled();
  });
});
