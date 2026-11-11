import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";

import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { PRESENCE_MS } from "@/components/ui/presence";
import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";
import { HILL_ACK_MS } from "@/lib/hill/motion";
import type { HillDecision, HillGroupAnswer, HillReceipt } from "@/lib/hill/wire";
import { groupDecision, hillDecision, hillReceipt, trickDecision } from "@/test/hill-fixtures";

import { versionRules } from "@/playground/fixtures/hill/decisions";
import { DecisionCard } from "./decision-card";
import { VIEW_CAP_PX, foldCut } from "./decision-view";

// The Decision card (M96): what it shows, that nothing is chosen for the person, the numbered options,
// More and Add a note, the arm on a confirm option and on Dismiss, the gate on a required answer, and
// what it says after each tap.
// Cases read the card through its data-slot hooks inside the render's own container (DESIGN.md §9).

function renderCard(decision: HillDecision, answer: HillAnswerState = HILL_IDLE) {
  const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
  const view = render(<DecisionCard decision={decision} answer={answer} onSend={onSend} />);
  const slot = (name: string) => view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const option = (intent: string) => {
    const el = view.container.querySelector<HTMLButtonElement>(`[data-slot="decision-option"][data-intent="${intent}"]`);
    if (el === null) throw new Error(`no option ${intent}`);
    return el;
  };
  /** Opens an optional note by its "Add a note" tap, the way a person does, and hands back the field. */
  const openNote = () => {
    fireEvent.click(slot("decision-note")!);
    return slot("decision-text")!;
  };
  return { ...view, onSend, slot, option, openNote };
}

const answered = (receipt: HillReceipt, intent = "yes", text: string | null = null): HillAnswerState => ({ phase: "answered", intent, text, receipt });

/** The words an option shows now: its label, or the confirm word while armed (both sit in one slot, one shown). */
const shownLabel = (option: HTMLElement) => option.querySelector("[data-active]")?.textContent ?? "";

const withConfirm = () =>
  hillDecision({
    options: [
      { intent: "keep", label: "Keep it as it is" },
      { intent: "reset", label: "Reset to main", detail: "Drops the two local commits.", confirm: "Reset now" },
    ],
  });

describe("the Decision card, at rest", () => {
  it("says so in words when the person wrote to the session after it asked, and stays answerable (1.29.0)", () => {
    const { slot, option } = renderCard(hillDecision({ spokeAfter: 2_000 }));
    expect(slot("decision-spoke")).toHaveTextContent("You wrote to this session after it asked.");
    expect(option("yes")).toBeEnabled();
    const fresh = renderCard(hillDecision());
    expect(fresh.slot("decision-spoke")).toBeNull();
  });

  it("shows the meta line, the title and the summary", () => {
    const { slot } = renderCard(hillDecision({ priority: "now", title: "Merge it?", summary: "CI is green." }));
    expect(slot("decision-priority")).toHaveTextContent("Now");
    // The three peaks, all filled, named with the priority's word.
    const glyph = slot("decision-priority")!.querySelector('[data-slot="peak-glyph"]')!;
    expect(glyph).toHaveAttribute("data-filled", "3");
    expect(glyph).toHaveAttribute("aria-label", "Now");
    expect(slot("decision-meta")).toHaveTextContent("collie lead");
    expect(slot("decision-meta")).toHaveTextContent("lodge");
    expect(slot("decision-title")).toHaveTextContent("Merge it?");
    expect(slot("decision-summary")).toHaveTextContent("CI is green.");
  });

  it("marks the recommended option but never selects or focuses it", () => {
    const { slot, option, container } = renderCard(hillDecision({ recommends: { intent: "yes", why: "Edge reaches testers first." } }));
    expect(slot("decision-recommends")).toHaveTextContent("collie lead suggests Yes, Edge first");
    expect(slot("decision-recommends")).toHaveTextContent("“Edge reaches testers first.”");
    // A screen reader hears which option it is beside the options.
    expect(slot("decision-options")).toHaveTextContent("Recommended: Yes, Edge first");
    // Both stars wear the warm accent, as the chosen option B1 draws them (DESIGN.md §4).
    const mark = option("yes").querySelector('[data-slot="decision-recommended-mark"]')!;
    expect(mark.closest("span")?.className).toContain("text-status-working");
    expect(container.querySelector('[data-slot="decision-recommends"] figcaption [data-icon="recommended"]')?.getAttribute("class")).toContain("text-status-working");
    expect(option("yes").querySelector('[data-slot="decision-recommended-mark"]')).not.toBeNull();
    expect(option("no").querySelector('[data-slot="decision-recommended-mark"]')).toBeNull();
    for (const intent of ["yes", "no"]) {
      expect(option(intent)).not.toHaveAttribute("aria-pressed", "true");
      expect(option(intent)).not.toHaveAttribute("aria-checked", "true");
      expect(option(intent)).not.toHaveFocus();
    }
  });

  it("opens the body and the links, each with its label and host, behind More", () => {
    const { slot, container } = renderCard(
      hillDecision({ body: "What **changes**.", links: [{ label: "CI run 4821", href: "https://ci.example.com/runs/4821" }] }),
    );
    const more = slot("decision-more")!;
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(slot("decision-body")).toHaveTextContent("What changes.");
    const link = container.querySelector<HTMLAnchorElement>('[data-slot="decision-link"]')!;
    expect(link).toHaveAttribute("href", "https://ci.example.com/runs/4821");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("CI run 4821");
    expect(link).toHaveTextContent("ci.example.com");
  });

  it("shows the address beside a named link in the body, and nothing beside a bare address", () => {
    const body = [
      "See [the CI run](https://ci.example/run/123) and https://plain.example/a and [https://good.com](https://evil.example).",
      "",
      "Or [trick](https://good.com@evil.example/login).",
    ].join("\n");
    const { slot } = renderCard(hillDecision({ body, links: [] }));
    fireEvent.click(slot("decision-more")!);
    const targets = [...slot("decision-body")!.querySelectorAll('[data-slot="link-target"]')];
    // The bare address and the link's own words are the address already; the other two name a host the label hides.
    expect(targets.map((el) => el.textContent)).toEqual([" (ci.example/run/123)", " (evil.example)", " (evil.example/login)"]);
    // The link's name stays its label, and the address is not tappable.
    const named = within(slot("decision-body")!).getByRole("link", { name: "the CI run" });
    expect(named).toHaveAttribute("href", "https://ci.example/run/123");
    for (const el of targets) expect(el.closest("a")).toBeNull();
  });

  it("sets the why between muted quote marks, the marks out of the reader's way", () => {
    const { slot } = renderCard(hillDecision({ recommends: { intent: "yes", why: "Edge first." } }));
    const marks = [...slot("decision-recommends")!.querySelectorAll('blockquote > span[aria-hidden="true"]')];
    expect(marks.map((m) => m.textContent)).toEqual(["“", "”"]);
    for (const m of marks) expect(m.className).toContain("text-muted-foreground");
  });

  it("shows three lines of the summary until More opens the rest (B1)", () => {
    const { slot } = renderCard(hillDecision({ body: "More words." }));
    expect(slot("decision-summary")!.className).toMatch(/\bline-clamp-3\b/u);
    fireEvent.click(slot("decision-more")!);
    expect(slot("decision-summary")!.className).not.toMatch(/\bline-clamp-3\b/u);
  });

  it("has no More without a body or links", () => {
    expect(renderCard(hillDecision()).slot("decision-more")).toBeNull();
  });

  it("offers More whenever the three lines hide some of the summary, with no body and no links (2026-11-10)", () => {
    // The summary's clamped box is shorter than its words: the cut the owner saw end in "…".
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(72);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const { slot } = renderCard(hillDecision({ body: "", links: [] }));
    const more = slot("decision-more")!;
    expect(more).not.toBeNull();
    fireEvent.click(more);
    // With no body, More opens the summary itself.
    expect(more).toHaveAttribute("aria-controls", slot("decision-summary")!.id);
    expect(slot("decision-summary")!.className).not.toMatch(/\bline-clamp-3\b/u);
    // Open, the summary hides nothing, and Less is still there to fold it again.
    expect(slot("decision-more")).toHaveAttribute("aria-expanded", "true");
  });

  it("reads the summary again once the page's fonts are ready, so a late font that adds a line brings More", async () => {
    let ready: () => void = () => undefined;
    const fonts = { ready: new Promise<void>((resolve) => (ready = resolve)) };
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const tall = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(72);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(72);
    onTestFinished(() => {
      vi.restoreAllMocks();
      Reflect.deleteProperty(document, "fonts");
    });
    const { slot } = renderCard(hillDecision({ body: "", links: [] }));
    expect(slot("decision-more")).toBeNull();
    tall.mockReturnValue(120);
    await act(async () => {
      ready();
      await fonts.ready;
    });
    expect(slot("decision-more")).not.toBeNull();
  });

  it("numbers the options 1, 2, 3 like the terminal menu, for the eye only", () => {
    const { option } = renderCard(withConfirm());
    expect(option("keep").querySelector('[aria-hidden="true"]')).toHaveTextContent("1");
    expect(option("reset").querySelector('[aria-hidden="true"]')).toHaveTextContent("2");
    // The number is not part of the button's name.
    expect(option("keep")).not.toHaveAttribute("aria-label");
  });

  it("says where the answer goes, and that the target runs without prompts", () => {
    const { slot } = renderCard(hillDecision({ target: { label: "m96-hill", host: "workshop", unattended: true } }));
    expect(slot("decision-target")).toHaveTextContent("Your answer goes to m96-hill on workshop");
    expect(slot("decision-target")).toHaveTextContent("runs without prompts");
  });

  it("turns spellcheck off and says the placeholder for the mode", () => {
    const optional = renderCard(hillDecision());
    const note = optional.openNote();
    expect(note).toHaveAttribute("spellcheck", "false");
    expect(note).toHaveAttribute("placeholder", "Add a note");
    optional.unmount();
    const required = renderCard(hillDecision({ text: "required" }));
    expect(required.slot("decision-text")).toHaveAttribute("placeholder", "Write your answer");
  });

  it("draws no field when the decision takes no words", () => {
    const { slot } = renderCard(hillDecision({ text: "none" }));
    expect(slot("decision-text")).toBeNull();
    expect(slot("decision-note")).toBeNull();
  });
});

describe("the poster's view", () => {
  const gate: HillDecision["view"] = [
    { kind: "bar", kids: [{ kind: "chip", text: "unit", attrs: { tone: "ok" } }, { kind: "chip", text: "e2e", attrs: { tone: "danger" } }] },
    { kind: "para", kids: [{ kind: "run", text: "see " }, { kind: "link", text: "the run", attrs: { href: "https://ci.example.com/run/7" } }] },
  ];

  afterEach(() => vi.restoreAllMocks());

  it("draws the view under the summary in its own frame, captioned with the sender, and no button in it", () => {
    const { slot } = renderCard(hillDecision({ view: gate }));
    const frame = slot("decision-view")!;
    expect(within(frame).getByText("From collie lead")).toBeInTheDocument();
    expect(within(frame).getByText("unit")).toBeInTheDocument();
    expect(within(frame).getByText("e2e")).toBeInTheDocument();
    expect(frame.querySelector("button")).toBeNull();
    // A bar wraps in a view, so seven chips keep their words on a phone: no fixed line, nothing clipped.
    const bar = frame.querySelector<HTMLElement>('[data-trick-node="bar"]')!;
    expect(bar.className).toContain("flex-wrap");
    expect(bar.style.height).toBe("");
    // Under the summary, and above the options.
    expect(slot("decision-summary")!.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(slot("decision-options")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws under the images when there are some", () => {
    const media = [{ id: "im_aaaaaaaaaaaaaaaa", kind: "image" as const, mime: "image/png" as const, bytes: 10, width: 390, height: 240 }];
    const { container, slot } = renderCard(hillDecision({ view: gate, media }));
    const strip = container.querySelector('[data-slot="image-strip"]');
    expect(strip).not.toBeNull();
    expect(strip!.compareDocumentPosition(slot("decision-view")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no frame without a view", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("decision-view")).toBeNull();
  });

  it("shows a link's host and opens it in a new tab, the phone staying where it is", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { slot } = renderCard(hillDecision({ view: gate }));
    const frame = slot("decision-view")!;
    expect(frame.querySelector("[data-trick-link-host]")).toHaveTextContent("ci.example.com");
    fireEvent.click(within(frame).getByText("the run"));
    expect(open).toHaveBeenCalledWith("https://ci.example.com/run/7", "_blank", "noopener,noreferrer");
  });

  it("a row with a web href shows its host in the end slot and opens in a new tab; it stays one tap target", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const rows: HillDecision["view"] = [
      {
        kind: "list",
        kids: [
          { kind: "row", text: "Where", attrs: { href: "http://lodge:8788/settings/tricks" } },
          { kind: "row", text: "With an end", attrs: { href: "https://ci.example.com/run/7", end: "1 of 18" } },
          { kind: "row", text: "No link", attrs: { end: "x" } },
        ],
      },
    ];
    const { slot } = renderCard(hillDecision({ view: rows }));
    const frame = slot("decision-view")!;
    const hosts = [...frame.querySelectorAll("[data-trick-link-host]")].map((el) => el.textContent);
    expect(hosts).toEqual(["lodge:8788", "ci.example.com"]);
    const first = frame.querySelectorAll('[data-slot="trick-row"]')[0]!;
    expect(first.querySelectorAll("a")).toHaveLength(1);
    expect(first.querySelector("button")).toBeNull();
    expect(first.querySelector("a")).toHaveTextContent("lodge:8788");
    // The end slot keeps its own words beside the host.
    expect(frame.querySelectorAll('[data-slot="trick-row"]')[1]).toHaveTextContent("1 of 18");
    expect(frame.querySelectorAll('[data-slot="trick-row"]')[2]!.querySelector("[data-trick-link-host]")).toBeNull();
    fireEvent.click(within(frame).getByText("Where"));
    expect(open).toHaveBeenCalledWith("http://lodge:8788/settings/tricks", "_blank", "noopener,noreferrer");
  });

  it("a link in a group draws as a block, with its host, and opens in a new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view: HillDecision["view"] = [{ kind: "group", attrs: { label: "Proof" }, kids: [{ kind: "link", text: "the run", attrs: { href: "https://ci.example.com/run/7" } }] }];
    const { slot } = renderCard(hillDecision({ view }));
    const frame = slot("decision-view")!;
    expect(frame.querySelector("[data-trick-link-host]")).toHaveTextContent("ci.example.com");
    fireEvent.click(within(frame).getByText("the run"));
    expect(open).toHaveBeenCalledWith("https://ci.example.com/run/7", "_blank", "noopener,noreferrer");
  });

  it("a view that throws while it draws takes only itself: the placeholder, and the options stay", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing: HillDecision["view"] = [
      {
        kind: "para",
        get text(): string {
          throw new Error("boom");
        },
      },
    ];
    const { slot, option } = renderCard(hillDecision({ view: throwing }));
    expect(slot("decision-view")).not.toBeNull();
    expect(slot("decision-view")!.querySelector('[data-trick-node="placeholder"]')).not.toBeNull();
    expect(option("yes")).toBeEnabled();
  });

  it("folds past the cap behind Show all, clipped with no scroller inside; a short view has no toggle", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VIEW_CAP_PX + 160);
    const tall = renderCard(hillDecision({ view: gate }));
    const body = tall.slot("decision-view-body")!;
    expect(body).toHaveAttribute("data-clipped");
    expect(body.style.maxHeight).toBe(`${VIEW_CAP_PX}px`);
    expect(body.className).toContain("overflow-hidden");
    expect(body.className).not.toMatch(/overflow-(auto|scroll|y-auto)/u);
    const more = tall.slot("decision-view-more")!;
    expect(more).toHaveTextContent("Show all");
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    fireEvent.click(more);
    // It eases open on the presence curve: clipped at the full height while it moves, then free.
    expect(body).not.toHaveAttribute("data-clipped");
    expect(body.style.maxHeight).toBe(`${VIEW_CAP_PX + 160}px`);
    expect(body.className).toContain("transition-[max-height]");
    expect(more).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(body.style.maxHeight).toBe("");
    expect(body.className).not.toContain("overflow-hidden");
    // And back: pinned at the full height for two frames, then eased to the cut.
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(body.style.maxHeight).toBe(`${VIEW_CAP_PX + 160}px`);
    act(() => vi.advanceTimersByTime(48));
    expect(body.style.maxHeight).toBe(`${VIEW_CAP_PX}px`);
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(body).toHaveAttribute("data-clipped");
    vi.useRealTimers();
    tall.unmount();
    vi.restoreAllMocks();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VIEW_CAP_PX - 40);
    const short = renderCard(hillDecision({ view: gate }));
    expect(short.slot("decision-view-more")).toBeNull();
    expect(short.slot("decision-view-body")).not.toHaveAttribute("data-clipped");
  });

  it("puts Show all under a rule of its own, so it never reads as the list's next row", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VIEW_CAP_PX + 160);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const { slot } = renderCard(hillDecision({ view: gate }));
    const fold = slot("decision-view-fold")!;
    expect(fold.className).toContain("border-t");
    expect(fold.querySelector('[data-slot="decision-view-more"]')).not.toBeNull();
  });
});

describe("where a folded view is cut", () => {
  it("cuts at the bottom of the last whole node or row under the cap, never through one", () => {
    // A strip ending at 32, rows ending at 177 and 238, the next at 282: the cut is under the row at 238.
    expect(foldCut([32, 124, 444, 177, 238, 282], 240)).toBe(238);
  });

  it("cuts at the cap when nothing ends between half of it and the cap", () => {
    expect(foldCut([30, 600], 240)).toBe(240);
    expect(foldCut([], 240)).toBe(240);
  });
});

describe("Add a note", () => {
  it("keeps an optional note behind its tap, and opens the field, the hint and Send", () => {
    const { slot } = renderCard(hillDecision());
    const toggle = slot("decision-note")!;
    expect(toggle).toHaveTextContent("Add a note");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(slot("decision-text")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", slot("decision-note-panel")!.id);
    expect(slot("decision-text")).not.toBeNull();
    expect(slot("decision-note-hint")).toHaveTextContent("The note goes with the option you tap.");
    expect(slot("decision-send")).toBeDisabled();
  });

  it("keeps a note with words in it open, so the words never ride on a tap unseen", () => {
    const { slot, openNote } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "after the leg" } });
    expect(slot("decision-note")).toBeDisabled();
    fireEvent.change(slot("decision-text")!, { target: { value: "  " } });
    expect(slot("decision-note")).toBeEnabled();
  });

  it("draws a required answer open, with no tap in front of it", () => {
    const { slot } = renderCard(hillDecision({ text: "required" }));
    expect(slot("decision-note")).toBeNull();
    expect(slot("decision-text")).not.toBeNull();
  });

  it("draws the words of a Decision with no options open: they are the answer", () => {
    const { slot } = renderCard(hillDecision({ options: [], text: "optional" }));
    expect(slot("decision-note")).toBeNull();
    expect(slot("decision-text")).not.toBeNull();
    expect(slot("decision-send")).toHaveTextContent("Send answer");
  });

  it("takes no note on a card that takes no answers", () => {
    const { slot } = renderCard(hillDecision(), { phase: "sending", intent: "yes", text: null });
    expect(slot("decision-note")).toBeDisabled();
  });
});

describe("answering", () => {
  it("sends an option without a confirm on the first tap, with the note", () => {
    const { option, openNote, onSend } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "  after the leg  " } });
    fireEvent.click(option("no"));
    expect(onSend).toHaveBeenCalledWith("no", "after the leg");
  });

  it("sends words alone with Send answer, which waits for words", () => {
    const { slot, onSend } = renderCard(hillDecision({ options: [], text: "required" }));
    expect(slot("decision-send")).toBeDisabled();
    fireEvent.change(slot("decision-text")!, { target: { value: "Lead with the zoom fix." } });
    expect(slot("decision-send")).toBeEnabled();
    fireEvent.click(slot("decision-send")!);
    expect(onSend).toHaveBeenCalledWith("answer", "Lead with the zoom fix.");
  });

  it("holds the options while a required answer has no words, and says why", () => {
    const { option, slot, onSend } = renderCard(hillDecision({ text: "required" }));
    expect(slot("decision-required-hint")).toHaveTextContent("Write your answer first.");
    expect(option("yes")).toBeDisabled();
    expect(option("yes")).toHaveAttribute("aria-describedby", slot("decision-required-hint")!.id);
    fireEvent.click(option("yes"));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(slot("decision-text")!, { target: { value: "Because main builds." } });
    expect(option("yes")).toBeEnabled();
    fireEvent.click(option("yes"));
    expect(onSend).toHaveBeenCalledWith("yes", "Because main builds.");
  });
});

describe("lists the card keys by place and value", () => {
  it("draws two options and two links that repeat a value without a key collision", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const same = { label: "CI", href: "https://ci.example.com/a" };
    const { container, slot } = renderCard(
      hillDecision({
        options: [
          { intent: "yes", label: "Yes" },
          { intent: "yes", label: "Yes, again" },
        ],
        links: [same, same],
        body: "More.",
      }),
    );
    fireEvent.click(slot("decision-more")!);
    expect(container.querySelectorAll('[data-slot="decision-option"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="decision-link"]')).toHaveLength(2);
    expect(error.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual([]);
    error.mockRestore();
  });
});

describe("arm, then send", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms a confirm option on the first tap, with the confirm word and the armed tint", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(shownLabel(option("reset"))).toBe("Reset now");
    expect(option("reset")).toHaveAttribute("aria-label", "Reset now: tap again to confirm");
    expect(option("reset").className).toContain("border-destructive/40");
  });

  it("ignores a second tap inside the dwell, and sends on one after it", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS - 100));
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(option("reset"));
    expect(onSend).toHaveBeenCalledWith("reset", null);
  });

  it("lapses after ARM_MS, back to the label", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    act(() => vi.advanceTimersByTime(ARM_MS));
    expect(shownLabel(option("reset"))).toBe("Reset to main");
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(shownLabel(option("reset"))).toBe("Reset now");
  });

  it("drops the arm when another option is tapped", () => {
    const { option, onSend } = renderCard(withConfirm());
    fireEvent.click(option("reset"));
    fireEvent.click(option("keep"));
    expect(onSend).toHaveBeenCalledWith("keep", null);
    expect(shownLabel(option("reset"))).toBe("Reset to main");
  });

  it("drops the arm when the answer's words change, so the second tap needs a new first one", () => {
    const { slot, option, openNote, onSend } = renderCard(withConfirm());
    fireEvent.change(openNote(), { target: { value: "Because." } });
    fireEvent.click(option("reset"));
    expect(shownLabel(option("reset"))).toBe("Reset now");
    fireEvent.change(slot("decision-text")!, { target: { value: "Because main builds." } });
    expect(shownLabel(option("reset"))).toBe("Reset to main");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(option("reset"));
    expect(onSend).not.toHaveBeenCalled();
    expect(shownLabel(option("reset"))).toBe("Reset now");
  });

  it("reserves the larger of the label and the confirm word, so arming never changes the row", () => {
    const { option } = renderCard(withConfirm());
    const layers = () => [...option("reset").querySelectorAll("[data-active], [aria-hidden='true'][inert]")].map((el) => el.textContent);
    expect(layers()).toEqual(expect.arrayContaining(["Reset to main", "Reset now"]));
    const before = option("reset").childElementCount;
    fireEvent.click(option("reset"));
    expect(option("reset").childElementCount).toBe(before);
    expect(layers()).toEqual(expect.arrayContaining(["Reset to main", "Reset now"]));
  });

  it("asks for a second tap on Dismiss too", () => {
    const { slot, onSend } = renderCard(hillDecision());
    const dismiss = slot("decision-dismiss")!;
    fireEvent.click(dismiss);
    expect(onSend).not.toHaveBeenCalled();
    expect(dismiss.className).toContain("text-destructive");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(dismiss);
    expect(onSend).toHaveBeenCalledWith("dismiss", null);
  });

  it("sends a dismiss with no text even when the field holds words: the bridge refuses a dismiss that carries text", () => {
    const { slot, openNote, onSend } = renderCard(hillDecision());
    fireEvent.change(openNote(), { target: { value: "never mind, not now" } });
    const dismiss = slot("decision-dismiss")!;
    fireEvent.click(dismiss);
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    fireEvent.click(dismiss);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("dismiss", null);
  });
});

describe("after the tap", () => {
  it("says Sending… in the options' place and locks the card while the answer is in flight", () => {
    const { slot } = renderCard(hillDecision(), { phase: "sending", intent: "yes", text: null });
    expect(slot("decision-status")).toHaveTextContent("Sending…");
    expect(slot("decision-answer")!.contains(slot("decision-status"))).toBe(true);
    expect(slot("decision-options")).toBeNull();
    expect(slot("decision-dismiss")).toBeDisabled();
  });

  describe("the moment of answering", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const sending: HillAnswerState = { phase: "sending", intent: "yes", text: null };

    it("shows the chosen option in place first, the others dimmed, and moves nothing yet", () => {
      const view = renderCard(hillDecision());
      view.rerender(<DecisionCard decision={hillDecision()} answer={sending} onSend={view.onSend} />);
      // Acknowledge: the options are still there, the tapped one in the chosen tone, all locked.
      expect(view.option("yes").className).toContain("border-primary");
      expect(view.option("no")).toBeDisabled();
      expect(view.slot("decision-status")).toBeNull();
      act(() => vi.advanceTimersByTime(HILL_ACK_MS - 1));
      expect(view.slot("decision-status")).toBeNull();
      // Settle: the status line takes the options' band, and the options leave it (held, out of reach).
      act(() => vi.advanceTimersByTime(1));
      expect(view.slot("decision-status")).toHaveTextContent("Sending…");
      const leaving = view.container.querySelector('[data-swap-layer="answer"]')!;
      expect(leaving).toHaveAttribute("inert");
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(view.container.querySelector('[data-swap-layer="answer"]')).toBeNull();
      expect(view.slot("decision-options")).toBeNull();
    });

    it("never shows the status under the options while it acknowledges", () => {
      const view = renderCard(hillDecision());
      view.rerender(<DecisionCard decision={hillDecision()} answer={sending} onSend={view.onSend} />);
      act(() => vi.advanceTimersByTime(HILL_ACK_MS / 2));
      expect(view.container.querySelectorAll('[data-slot="decision-status"]')).toHaveLength(0);
    });

    it("trades Sending… for the receipt in the same band", () => {
      const view = renderCard(hillDecision());
      view.rerender(<DecisionCard decision={hillDecision()} answer={sending} onSend={view.onSend} />);
      // Two steps: the settle's timer starts only once the acknowledge has rendered.
      act(() => vi.advanceTimersByTime(HILL_ACK_MS));
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      view.rerender(<DecisionCard decision={hillDecision()} answer={answered(hillReceipt())} onSend={view.onSend} />);
      expect(view.container.querySelector('[data-swap-layer="receipt"]')).toHaveAttribute("data-active");
      expect(view.slot("decision-receipt")).toHaveTextContent("Sent to collie lead");
      // The "Sending…" layer fades out on top, held and out of reach.
      expect(view.container.querySelector('[data-swap-layer="sending"]')).toHaveAttribute("inert");
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(view.container.querySelector('[data-swap-layer="sending"]')).toBeNull();
    });

    it("gives the options back with the error under them when the send fails, and Try again sends again", () => {
      const view = renderCard(hillDecision());
      view.rerender(<DecisionCard decision={hillDecision()} answer={sending} onSend={view.onSend} />);
      // Two steps: the settle's timer starts only once the acknowledge has rendered.
      act(() => vi.advanceTimersByTime(HILL_ACK_MS));
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(view.slot("decision-options")).toBeNull();
      view.rerender(<DecisionCard decision={hillDecision()} answer={{ phase: "failed", intent: "yes", text: null }} onSend={view.onSend} />);
      // The band swaps back at once, no acknowledge delay on the way back.
      expect(view.container.querySelector('[data-swap-layer="answer"]')).toHaveAttribute("data-active");
      expect(view.option("yes")).toBeEnabled();
      const status = view.container.querySelectorAll<HTMLElement>('[data-slot="decision-status"]');
      expect([...status].some((el) => el.textContent?.includes("Not sent."))).toBe(true);
      act(() => vi.advanceTimersByTime(PRESENCE_MS));
      expect(view.container.querySelector('[data-swap-layer="sending"]')).toBeNull();
      fireEvent.click(view.slot("decision-retry")!);
      expect(view.onSend).toHaveBeenCalledWith("yes", null);
    });

    it("keeps Dismiss in its chosen tint, undimmed, while the dismiss is sent", () => {
      const view = renderCard(hillDecision());
      view.rerender(<DecisionCard decision={hillDecision()} answer={{ phase: "sending", intent: "dismiss", text: null }} onSend={view.onSend} />);
      const dismiss = view.slot("decision-dismiss")!;
      expect(dismiss).toBeDisabled();
      expect(dismiss.className).toContain("text-destructive");
      expect(dismiss.className).toContain("disabled:opacity-100");
    });
  });

  it.each<[string, HillReceipt, string, string]>([
    ["typed", hillReceipt(), "yes", "Sent to collie lead"],
    ["held", hillReceipt({ delivery: "held" }), "yes", "Sent. collie lead gets it when its turn ends"],
    ["unknown delivery", hillReceipt({ delivery: "unknown" }), "yes", "Sent, not confirmed"],
    ["unknown", hillReceipt({ code: "unknown", state: null, delivery: null }), "yes", "Sent, not confirmed"],
    ["dismissed", hillReceipt({ delivery: "none", state: "dismissed" }), "dismiss", "Dismissed"],
    ["rejected", hillReceipt({ code: "rejected", state: null, delivery: null, reason: "text is required" }), "yes", "Not accepted: an answer in words is required"],
    ["gone, ended", hillReceipt({ code: "gone", state: null, delivery: null, reason: "target session ended" }), "yes", "The session that asked has ended"],
    ["denied", hillReceipt({ code: "denied", state: null, delivery: null }), "yes", "This device may not answer"],
  ])("says the %s receipt in words", (_name, receipt, intent, words) => {
    const { slot } = renderCard(hillDecision(), answered(receipt, intent));
    expect(slot("decision-receipt")).toHaveTextContent(words);
  });

  it("says what Collie did for its own Decision, wears the app's mark, and says nothing of a trick", () => {
    const from: HillDecision["from"] = { kind: "collie", address: null, trickId: null, trickKey: null, memberId: "lodge", harness: null, label: "Collie", host: "lodge", trickHost: null, ref: { type: "version", id: "legs", hash: "a".repeat(64) } };
    const decision = hillDecision({ from, target: null, options: [{ intent: "use", label: "Use the new version" }, { intent: "keep", label: "Keep the old version" }] });
    const used = renderCard(decision, answered(hillReceipt({ delivery: "none" }), "use"));
    expect(used.slot("decision-receipt")?.textContent).toBe("Now running the new version.");
    expect(used.container.querySelector('[data-slot="decision-collie-mark"]')).not.toBeNull();
    expect(used.container.querySelector('[data-slot="decision-trick-word"]')).toBeNull();
    used.unmount();
    const kept = renderCard(decision, answered(hillReceipt({ delivery: "none" }), "keep"));
    expect(kept.slot("decision-receipt")?.textContent).toBe("Kept the old version.");
    kept.unmount();
    const moved = renderCard(decision, answered(hillReceipt({ code: "rejected", state: "open", delivery: null, reason: "The trick changed again. A new card replaces this one." }), "use"));
    expect(moved.slot("decision-receipt")?.textContent).toBe("Not accepted: The trick changed again. A new card replaces this one.");
    expect(moved.option("use")).toBeEnabled();
  });

  it("says an answer to a crew machine that is not answering was not sent, and keeps the card answerable", () => {
    const offline = hillReceipt({ code: "rejected", state: "open", delivery: null, reason: "laptop is not answering. Your answer was not sent.", machine: "laptop" });
    const { slot, option } = renderCard(hillDecision(), answered(offline));
    expect(slot("decision-receipt")?.textContent).toBe("laptop is not answering. Your answer was not sent.");
    expect(option("yes")).toBeEnabled();
  });

  it("says a dismiss closed the card while the session's machine was away, and that the session was not told", () => {
    const untold = hillReceipt({ code: "ok", state: "dismissed", delivery: "none", machine: "laptop" });
    const { slot } = renderCard(hillDecision(), answered(untold, "dismiss"));
    expect(slot("decision-receipt")?.textContent).toBe("Dismissed. laptop is not answering, so the session was not told.");
  });

  it("locks the card after an answer that landed, and keeps it open after a refusal", () => {
    const landed = renderCard(hillDecision(), answered(hillReceipt()));
    // The receipt holds the options' place: nothing is left to tap.
    expect(landed.slot("decision-options")).toBeNull();
    expect(landed.slot("decision-dismiss")).toBeDisabled();
    landed.unmount();
    const refused = renderCard(hillDecision(), answered(hillReceipt({ code: "rejected", state: null, delivery: null })));
    expect(refused.option("yes")).toBeEnabled();
  });

  it("keeps the card answerable after a denied answer, with the notice that says it was not accepted", () => {
    const denied = renderCard(hillDecision(), answered(hillReceipt({ code: "denied", state: null, delivery: null })));
    expect(denied.slot("decision-receipt")).toHaveTextContent("This device may not answer");
    expect(denied.option("yes")).toBeEnabled();
    expect(denied.slot("decision-dismiss")).toBeEnabled();
  });

  it("keeps the words of a gone answer on screen with Copy", () => {
    // Copy draws only where the page can copy; jsdom has no clipboard of its own.
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    onTestFinished(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    });
    const { slot } = renderCard(hillDecision(), answered(hillReceipt({ code: "gone", state: null, delivery: null }), "yes", "Not before the leg."));
    const kept = slot("decision-kept")!;
    expect(kept).toHaveTextContent("Your answer, not delivered");
    expect(kept).toHaveTextContent("Not before the leg.");
    expect(within(kept).getByRole("button", { name: "Copy your answer" })).toBeInTheDocument();
  });

  it("keeps nothing for a gone answer without words", () => {
    const { slot } = renderCard(hillDecision(), answered(hillReceipt({ code: "gone", state: null, delivery: null })));
    expect(slot("decision-kept")).toBeNull();
  });

  it("says Not sent. and retries the same attempt", () => {
    const { slot, onSend } = renderCard(hillDecision(), { phase: "failed", intent: "no", text: "later" });
    expect(slot("decision-status")).toHaveTextContent("Not sent.");
    fireEvent.click(slot("decision-retry")!);
    expect(onSend).toHaveBeenCalledWith("no", "later");
  });
});

describe("a trick's decision", () => {
  const m96 = { label: "m96-hill", host: "lodge", unattended: false } as const;

  it("names the trick and the word trick on the meta line, in the poster's slot", () => {
    const { slot } = renderCard(trickDecision());
    expect(slot("decision-meta")?.textContent).toMatch(/Look\s*trick/);
    expect(slot("decision-trick-word")?.querySelector('[data-icon="mod-icon-plug"]')).not.toBeNull();
    expect(slot("decision-meta")).not.toHaveTextContent("collie lead");
  });

  it("shows the machine's name on the meta line, never the routing host", () => {
    const base = trickDecision();
    const { slot } = renderCard({ ...base, from: { ...base.from, host: "lodge", trickHost: "collie-7k2m9q" } });
    expect(slot("decision-meta")?.textContent).toMatch(/Look\s*trick\s*lodge/);
    expect(slot("decision-host")).toHaveTextContent("lodge");
    expect(slot("decision-meta")).not.toHaveTextContent("collie-7k2m9q");
  });

  it("leaves an agent's meta line without the word trick", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("decision-meta")?.textContent).not.toContain("trick");
  });

  it("says the answer goes to the trick when nothing else gets it", () => {
    const { slot } = renderCard(trickDecision());
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to the Look trick");
  });

  it("names the target and the trick when the trick set a reply target", () => {
    const { slot } = renderCard(trickDecision({ target: m96 }));
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to m96-hill on lodge and to the Look trick");
  });

  it("drops the machine when the bridge names none", () => {
    const { slot } = renderCard(trickDecision({ target: { ...m96, host: null } }));
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to m96-hill and to the Look trick");
  });

  it("keeps an agent's target line as it was", () => {
    const { slot } = renderCard(hillDecision());
    expect(slot("decision-target")?.textContent).toBe("Your answer goes to collie lead on lodge");
  });

  it.each<[string, HillDecision, HillReceipt, string, string]>([
    ["typed and ran", trickDecision({ target: m96 }), hillReceipt({ trick: "ran" }), "yes", "Sent to m96-hill · recorded by Look"],
    ["held and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "held", trick: "ran" }), "yes", "Sent. m96-hill gets it when its turn ends · recorded by Look"],
    ["unconfirmed and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "unknown", trick: "ran" }), "yes", "Sent, not confirmed · recorded by Look"],
    ["no target and ran", trickDecision(), hillReceipt({ delivery: "none", trick: "ran" }), "yes", "Recorded by Look"],
    ["dismissed and ran", trickDecision({ target: m96 }), hillReceipt({ delivery: "none", state: "dismissed", trick: "ran" }), "dismiss", "Recorded by Look"],
    ["failed, with a target", trickDecision({ target: m96 }), hillReceipt({ trick: "failed" }), "yes", "Sent, but Look did not take it"],
    ["failed, no target", trickDecision(), hillReceipt({ delivery: "none", trick: "failed" }), "yes", "Sent, but Look did not take it"],
    ["an agent's, typed", hillDecision(), hillReceipt(), "yes", "Sent to collie lead"],
    ["an agent's, dismissed", hillDecision(), hillReceipt({ delivery: "none", state: "dismissed" }), "dismiss", "Dismissed"],
  ])("says the receipt of %s", (_name, decision, receipt, intent, words) => {
    const { slot } = renderCard(decision, answered(receipt, intent));
    expect(slot("decision-receipt")?.textContent).toBe(words);
  });

  it("still names a refusal the way it did", () => {
    const refused = hillReceipt({ code: "rejected", state: null, delivery: null, trick: null, reason: "text is required" });
    const { slot } = renderCard(trickDecision(), answered(refused));
    expect(slot("decision-receipt")?.textContent).toBe("Not accepted: an answer in words is required");
  });
});

describe("who asks, on the first line", () => {
  it("tints the machine's glyph on a crew, and only the glyph", () => {
    const { container } = render(<DecisionCard decision={hillDecision()} answer={HILL_IDLE} onSend={() => {}} hostSlot={6} />);
    const host = container.querySelector('[data-slot="decision-host"]')!;
    expect(host.querySelector('[data-icon="machine"]')?.getAttribute("class")).toContain("text-host-6");
    expect(host.className).not.toContain("text-host");
  });

  it("leaves the glyph muted on a solo install", () => {
    const { container } = render(<DecisionCard decision={hillDecision()} answer={HILL_IDLE} onSend={() => {}} />);
    expect(container.querySelector('[data-slot="decision-host"] [data-icon="machine"]')?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("draws a trick's own icon on a tile, and the default icon for a word it does not know", () => {
    const known = render(<DecisionCard decision={trickDecision()} answer={HILL_IDLE} onSend={() => {}} trickIcon="search" />);
    expect(known.container.querySelector('[data-slot="decision-trick-mark"] [data-icon]')).toHaveAttribute("data-icon", "mod-icon-search");
    known.unmount();
    const unknown = render(<DecisionCard decision={trickDecision()} answer={HILL_IDLE} onSend={() => {}} trickIcon="no-such-word" />);
    expect(unknown.container.querySelector('[data-slot="decision-trick-mark"] svg')).not.toBeNull();
  });
});

// A GROUP OF CARDS (crew slice 8): card 1 first, one card at a time, the yes after every card.
describe("the Decision card, with a group of cards", () => {
  afterEach(() => sessionStorage.clear());
  const words = (container: HTMLElement) => container.querySelector('[data-slot="decision-group"] [data-slot="decision-view"]')?.textContent ?? "";

  it("opens on card 1 with its position and the chip; Back is off on card 1 and Next on the last", () => {
    const { slot, container } = renderCard(groupDecision(3));
    expect(slot("decision-group-count")).toHaveTextContent("3 cards");
    expect(slot("decision-group-position")).toHaveTextContent("Card 1 of 3");
    expect(words(container)).toContain("Card 1 words.");
    expect(slot("decision-group-back")).toBeDisabled();
    fireEvent.click(slot("decision-group-next")!);
    fireEvent.click(slot("decision-group-next")!);
    expect(slot("decision-group-position")).toHaveTextContent("Card 3 of 3");
    expect(words(container)).toContain("Card 3 words.");
    expect(slot("decision-group-next")).toBeDisabled();
    // Back and Next are 44px targets.
    expect(slot("decision-group-back")!.className).toContain("h-11");
    expect(slot("decision-group-next")!.className).toContain("h-11");
  });

  it("before the last card offers only the decline, quiet; the options come on the last card", () => {
    const { slot, container, option } = renderCard(groupDecision(3));
    expect(container.querySelectorAll('[data-slot="decision-option"]')).toHaveLength(1);
    expect(option("later")).toHaveTextContent("Not now");
    expect(container.querySelector('[data-intent="on"]')).toBeNull();
    fireEvent.click(slot("decision-group-next")!);
    fireEvent.click(slot("decision-group-next")!);
    expect(option("on")).toBeEnabled();
    expect(option("later")).toBeEnabled();
    expect(slot("decision-group-unopened")).toBeNull();
  });

  it("the yes waits for every card: the hint and a tap for each card not opened, then it sends the digest and the cards", () => {
    const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
    const decision = groupDecision(3);
    const view = render(<DecisionCard decision={decision} answer={HILL_IDLE} onSend={onSend} playgroundCard={3} />);
    const at = (name: string) => view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
    const yes = () => view.container.querySelector<HTMLButtonElement>('[data-slot="decision-option"][data-intent="on"]')!;
    expect(yes()).toBeDisabled();
    expect(at("decision-group-unopened")).toHaveTextContent("Open all 3 cards first.");
    const gotos = [...view.container.querySelectorAll<HTMLButtonElement>('[data-slot="decision-group-goto"]')];
    expect(gotos.map((b) => b.textContent)).toEqual(["Card 1", "Card 2"]);
    // The decline needs no card opened, and carries what was opened.
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-slot="decision-option"][data-intent="later"]')!);
    expect(onSend).toHaveBeenLastCalledWith("later", null, { digest: "d".repeat(64), opened: [3] });
    fireEvent.click(gotos[0]!);
    expect(at("decision-group-position")).toHaveTextContent("Card 1 of 3");
    fireEvent.click(at("decision-group-next")!);
    fireEvent.click(at("decision-group-next")!);
    expect(at("decision-group-unopened")).toBeNull();
    // "Switch it on" asks twice; the second tap sends the digest and every card.
    vi.useFakeTimers();
    fireEvent.click(yes());
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS + 1));
    fireEvent.click(yes());
    vi.useRealTimers();
    expect(onSend).toHaveBeenLastCalledWith("on", null, { digest: "d".repeat(64), opened: [1, 2, 3] });
  });

  it("a card taller than the screen opens only when its end comes on screen, and never folds (review 7 R1)", () => {
    // Every card is taller than the screen, and far over the fold's cap.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VIEW_CAP_PX * 20);
    const tall = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, window.innerHeight * 3));
    // The hook reads `isIntersecting` alone, so the fake hands it that.
    type Seen = (entries: readonly { isIntersecting: boolean }[]) => void;
    const seen: { callback: Seen; target: Element | null }[] = [];
    class FakeObserver {
      private readonly at: { callback: Seen; target: Element | null };
      constructor(callback: Seen) {
        this.at = { callback, target: null };
        seen.push(this.at);
      }
      observe(target: Element): void {
        this.at.target = target;
      }
      disconnect(): void {
        this.at.target = null;
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      const onSend = vi.fn<(intent: string, text: string | null, group?: HillGroupAnswer) => void>();
      const view = render(<DecisionCard decision={groupDecision(2)} answer={HILL_IDLE} onSend={onSend} />);
      const at = (name: string) => view.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
      // No fold on a group's card: no clip, no Show all.
      expect(at("decision-view-more")).toBeNull();
      expect(at("decision-view-body")).not.toHaveAttribute("data-clipped");
      // The end mark is what is watched.
      const watched = () => seen.filter((one) => one.target !== null);
      expect(watched().map((one) => one.target?.getAttribute("data-slot"))).toEqual(["decision-view-end"]);
      // Paging past card 1 without its end on screen leaves it unopened.
      fireEvent.click(at("decision-group-next")!);
      expect([...view.container.querySelectorAll('[data-slot="decision-group-goto"]')].map((b) => b.textContent)).toEqual(["Card 1", "Card 2"]);
      expect(view.container.querySelector('[data-slot="decision-option"][data-intent="on"]')).toBeDisabled();
      // Card 2's end comes on screen: card 2 opens, card 1 still waits.
      const end = watched()[0]!;
      act(() => end.callback([{ isIntersecting: true }]));
      expect([...view.container.querySelectorAll('[data-slot="decision-group-goto"]')].map((b) => b.textContent)).toEqual(["Card 1"]);
      fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-slot="decision-option"][data-intent="later"]')!);
      expect(onSend).toHaveBeenLastCalledWith("later", null, { digest: "d".repeat(64), opened: [2] });
    } finally {
      vi.unstubAllGlobals();
      tall.mockRestore();
    }
  });

  it("opens on card 1 again when drawn again, while the cards opened stay opened for this digest", () => {
    const decision = groupDecision(2);
    const first = renderCard(decision);
    fireEvent.click(first.slot("decision-group-next")!);
    first.unmount();
    const again = renderCard(decision);
    expect(again.slot("decision-group-position")).toHaveTextContent("Card 1 of 2");
    fireEvent.click(again.slot("decision-group-next")!);
    expect(again.option("on")).toBeEnabled();
    // Another digest is another group: nothing counts.
    again.unmount();
    const changed = render(<DecisionCard decision={{ ...decision, group: { ...decision.group!, digest: "e".repeat(64) } }} answer={HILL_IDLE} onSend={vi.fn()} playgroundCard={2} />);
    expect(changed.container.querySelector('[data-slot="decision-option"][data-intent="on"]')).toBeDisabled();
  });
});

// A SINGLE CARD OF CODE (review 7 R1): Collie's own proposal or version card whose code fits one card is
// held to a group card's rule. It never folds, and its yes waits until its end was on screen.
describe("the Decision card, a single card of Collie's own with code", () => {
  afterEach(() => sessionStorage.clear());
  const collie = (type: "proposal" | "version") => ({
    kind: "collie" as const,
    address: null,
    trickId: null,
    trickKey: null,
    memberId: null,
    harness: null,
    label: "Collie",
    host: "lodge",
    trickHost: null,
    ref: { type, id: "legs", hash: "a".repeat(64) },
  });
  const code: HillDecision["view"] = [{ kind: "diff", text: "@@ -0,0 +1,2 @@\n+console.log(1);\n+console.log(2);", attrs: { file: "program.ts" } }];
  const proposal = (over: Partial<HillDecision> = {}) =>
    hillDecision({
      from: collie("proposal"),
      title: "Switch on the trick legs?",
      target: null,
      text: "none",
      options: [
        { intent: "on", label: "Switch it on", confirm: "Yes, switch on" },
        { intent: "later", label: "Not now" },
      ],
      view: code,
      ...over,
    });

  /** Every view taller than the screen and far over the fold's cap, and an observer the case drives. */
  function tallScreen() {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VIEW_CAP_PX * 20);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, window.innerHeight * 3));
    // The hook reads `isIntersecting` alone, so the fake hands it that.
    type Seen = (entries: readonly { isIntersecting: boolean }[]) => void;
    const seen: { callback: Seen; target: Element | null }[] = [];
    class FakeObserver {
      private readonly at: { callback: Seen; target: Element | null };
      constructor(callback: Seen) {
        this.at = { callback, target: null };
        seen.push(this.at);
      }
      observe(target: Element): void {
        this.at.target = target;
      }
      disconnect(): void {
        this.at.target = null;
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    return () => seen.filter((one) => one.target !== null);
  }

  it("a proposal's single code card never folds, and its yes waits for the end mark; Not now does not", () => {
    const watched = tallScreen();
    const { slot, option, onSend } = renderCard(proposal());
    expect(slot("decision-view-more")).toBeNull();
    expect(slot("decision-view-body")).not.toHaveAttribute("data-clipped");
    expect(watched().map((one) => one.target?.getAttribute("data-slot"))).toEqual(["decision-view-end"]);
    expect(option("on")).toBeDisabled();
    expect(option("later")).toBeEnabled();
    expect(slot("decision-code-unread")).toHaveTextContent("Scroll to the end of the code first.");
    // The end comes on screen: the yes is offered, the hint goes, and the answer names the hash and card 1 (C-A2).
    act(() => watched()[0]!.callback([{ isIntersecting: true }]));
    expect(option("on")).toBeEnabled();
    expect(slot("decision-code-unread")).toBeNull();
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    fireEvent.click(option("on"));
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS + 1));
    fireEvent.click(option("on"));
    expect(onSend).toHaveBeenLastCalledWith("on", null, { digest: "a".repeat(64), opened: [1] });
  });

  it("a version card that shows agent instructions is a single code card too: no fold, Use waits for the end, Keep does not", () => {
    const watched = tallScreen();
    const { slot, option } = renderCard({ ...versionRules, from: collie("version") });
    expect(slot("decision-view-more")).toBeNull();
    expect(slot("decision-view-body")).not.toHaveAttribute("data-clipped");
    expect(option("use")).toBeDisabled();
    expect(option("keep")).toBeEnabled();
    expect(slot("decision-code-unread")).toHaveTextContent("Scroll to the end of the code first.");
    act(() => watched()[0]!.callback([{ isIntersecting: true }]));
    expect(option("use")).toBeEnabled();
  });

  it("a version's single code card waits the same way: Use and Use it and stop asking wait, Keep does not", () => {
    const watched = tallScreen();
    const { slot, option } = renderCard(
      proposal({
        from: collie("version"),
        title: "Use the new version of legs?",
        options: [
          { intent: "use", label: "Use the new version" },
          { intent: "always", label: "Use it and stop asking" },
          { intent: "keep", label: "Keep the old version" },
        ],
      }),
    );
    expect(slot("decision-view-more")).toBeNull();
    expect(option("use")).toBeDisabled();
    expect(option("always")).toBeDisabled();
    expect(option("keep")).toBeEnabled();
    act(() => watched()[0]!.callback([{ isIntersecting: true }]));
    expect(option("use")).toBeEnabled();
    expect(option("always")).toBeEnabled();
  });

  it("a card no taller than the screen counts as read as it draws", () => {
    const { slot, option } = renderCard(proposal());
    expect(option("on")).toBeEnabled();
    expect(slot("decision-code-unread")).toBeNull();
  });

  it("a card with no code folds as before, Collie's own or an agent's, and waits for nothing", () => {
    tallScreen();
    const words: HillDecision["view"] = [{ kind: "para", text: "No code here." }];
    for (const decision of [proposal({ view: words }), hillDecision({ view: code })]) {
      const card = renderCard(decision);
      expect(card.slot("decision-view-more")).not.toBeNull();
      expect(card.slot("decision-code-unread")).toBeNull();
      for (const button of card.container.querySelectorAll<HTMLButtonElement>('[data-slot="decision-option"]')) expect(button).toBeEnabled();
      card.unmount();
    }
  });
});
