import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCost, hasFigure, hasGauge, isHot, MODEL_TAG_ROOM, ModelTag, modelTagShows } from "./model-tag";
import type { StatusItem } from "./trick-status-item";
import { UsageRowControl } from "./usage-row-control";

afterEach(() => localStorage.clear());

describe("ModelTag", () => {
  it("draws the short model name, named for a screen reader, and takes no touch", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    // The eye reads the short name; the screen reader reads the sentence from the dictionary.
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5");
    expect(tag?.className).toContain("pointer-events-none");
    // Absolute and owning no line, so it arriving or leaving moves nothing (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the effort after the model, in the harness's own word, for the eye and the screen reader", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · high");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5 · high");
  });

  it("an empty or hostile effort draws the model alone, and an effort never draws without a model", () => {
    const alone = (effort: string | undefined) =>
      render(<ModelTag model="claude-opus-5-5" effort={effort} />).container.querySelector("[aria-hidden]")?.textContent;
    expect(alone(undefined)).toBe("Opus 5.5");
    expect(alone("  ")).toBe("Opus 5.5");
    expect(alone("\u001b[31m\u0007")).toBe("Opus 5.5");
    expect(alone(`  ${"x".repeat(40)} `)).toBe(`Opus 5.5 · ${"x".repeat(15)}…`);
    expect(render(<ModelTag model={undefined} effort="high" />).container.innerHTML).toBe("");
  });

  it("draws nothing at all without a model", () => {
    expect(render(<ModelTag model={undefined} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model="  " />).container.innerHTML).toBe("");
  });
});

describe("isHot, the one red rule", () => {
  it("is the whole percentage as written, 80 or more, for every gauge and both modes", () => {
    expect([0, 79, 79.4].map(isHot)).toEqual([false, false, false]);
    expect([79.5, 80, 81, 100, 130].map(isHot)).toEqual([true, true, true, true, true]);
    expect([-4, Number.NaN].map(isHot)).toEqual([false, false]);
  });

  it("turns the number and the lit dots red together, in ctx, 5h and 7d", () => {
    const usage = { context: 79.6, limits: [{ window: "5h" as const, used: 80 }, { window: "7d" as const, used: 79 }] };
    for (const mode of ["percent", "dots"] as const) {
      const { container } = render(<ModelTag model={undefined} usage={usage} usageRow={mode} />);
      const hot = [...container.querySelectorAll("[data-gauge]")].map((g) => g.querySelector("[data-hot]") !== null);
      expect(hot).toEqual([true, true, false]);
    }
    const { container } = render(<ModelTag model={undefined} usage={{ context: 85 }} usageRow="dots" />);
    const lit = [...container.querySelectorAll("[data-slot='usage-dots'] > span")];
    expect(lit.filter((d) => d.className.includes("bg-status-blocked"))).toHaveLength(4);
    expect(lit.some((d) => d.className.includes("bg-status-working"))).toBe(false);
  });
});

describe("ModelTag usage dots (the Dots choice)", () => {
  const usage = { context: 42, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 81 }] };

  it("draws a gauge per reported number after the model, five dots each, and says the figures", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" usage={usage} usageRow="dots" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · highctx5h7d");
    const gauges = [...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"));
    expect(gauges).toEqual(["context", "5h", "7d"]);
    const dots = [...container.querySelectorAll("[data-slot='usage-dots']")];
    expect(dots.map((d) => d.getAttribute("data-lit"))).toEqual(["2", "2", "4"]);
    expect(dots.every((d) => d.children.length === 5)).toBe(true);
    // 80% and up is red; under it is not.
    expect(dots.map((d) => d.hasAttribute("data-hot"))).toEqual([false, false, true]);
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(
      "Model Opus 5.5 · high. Context 42% used. 5-hour limit 58% used. 7-day limit 81% used",
    );
    // Still absolute and still no touch with the dots in it (DESIGN.md §2).
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("draws the dots alone while the screen names the model, and only the gauges reported", () => {
    const { container } = render(<ModelTag model={undefined} effort="high" usage={{ context: 7 }} usageRow="dots" />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("ctx");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Context 7% used");
  });

  it("draws nothing for an empty reading", () => {
    expect(render(<ModelTag model={undefined} usage={{}} />).container.innerHTML).toBe("");
    expect(render(<ModelTag model={undefined} usage={{ limits: [] }} />).container.innerHTML).toBe("");
  });

  it("lights one dot per full fifth, so only 100% lights the fifth", () => {
    const lit = (context: number) =>
      render(<ModelTag model={undefined} usage={{ context }} usageRow="dots" />).container.querySelector("[data-slot='usage-dots']")?.getAttribute("data-lit");
    // One dot per FULL fifth: only a full window lights the fifth dot.
    expect(lit(0)).toBe("0");
    expect(lit(19)).toBe("0");
    expect(lit(20)).toBe("1");
    expect(lit(81)).toBe("4");
    expect(lit(99)).toBe("4");
    expect(lit(100)).toBe("5");
  });
});

describe("ModelTag draws the windows the agent reports (M101 spec 02)", () => {
  const text = (container: HTMLElement) => container.querySelector("[aria-hidden]")?.textContent;
  const spoken = (container: HTMLElement) => container.querySelector(".sr-only")?.textContent;

  it("draws a plan that reports one window as one window", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d", used: 12 }] }} />);
    expect(text(container)).toBe("7d12%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["7d"]);
    expect(spoken(container)).toBe("7-day limit 12% used");
  });

  it("draws a model-scoped weekly window as 7d and its label, and says both", () => {
    const usage = { limits: [{ window: "5h", used: 10 }, { window: "7d", used: 20 }, { window: "7d:opus", used: 30, label: "Opus" }] };
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(text(container)).toBe("5h10%7d20%7d Opus30%");
    expect(spoken(container)).toBe("5-hour limit 10% used. 7-day limit 20% used. 7-day Opus limit 30% used");
  });

  it("falls back to the key after 7d: when the label is missing, and cuts a long label", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d:sonnet-4.6", used: 5 }, { window: "7d:x", used: 6, label: "A very long model name" }] }} />);
    expect(text(container)).toBe("7d sonnet-4.65%7d A very lo\u20266%");
    expect(spoken(container)).toContain("7-day A very long model name limit 6% used");
  });

  it("draws any other window by its label, else its key, and no longer skips it", () => {
    const usage = { limits: [{ window: "30d", used: 50 }, { window: "spend", used: 61, label: "Spend" }] };
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(text(container)).toBe("30d50%Spend61%");
    expect(spoken(container)).toBe("30d limit 50% used. Spend limit 61% used");
  });

  it("holds the row to three windows and counts the rest, while the screen reader hears every one", () => {
    const limits = [
      { window: "5h", used: 10 },
      { window: "7d", used: 20 },
      { window: "7d:opus", used: 30, label: "Opus" },
      { window: "7d:sonnet", used: 40, label: "Sonnet" },
    ];
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="high" usage={{ context: 5, limits }} />);
    expect(text(container)).toBe("Opus 5.5 · highctx5%5h10%7d20%7d Opus30%+1");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h", "7d", "7d:opus"]);
    expect(container.querySelector("[data-slot='usage-more']")?.textContent).toBe("+1");
    expect(spoken(container)).toBe(
      "Model Opus 5.5 · high. Context 5% used. 5-hour limit 10% used. 7-day limit 20% used. 7-day Opus limit 30% used. 7-day Sonnet limit 40% used",
    );
    // Three windows draw no counter.
    const three = render(<ModelTag model={undefined} usage={{ limits: limits.slice(0, 3) }} />);
    expect(three.container.querySelector("[data-slot='usage-more']")).toBeNull();
  });

  it("counts a window past the third in dots mode as well", () => {
    const limits = Array.from({ length: 5 }, (_, i) => ({ window: `w${String(i)}`, used: i * 10 }));
    const { container } = render(<ModelTag model={undefined} usage={{ limits }} usageRow="dots" />);
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(3);
    expect(container.querySelector("[data-slot='usage-more']")?.textContent).toBe("+2");
  });

  it("is red from 80% on a scoped or unknown window just as on 5h and 7d", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ limits: [{ window: "7d:opus", used: 90, label: "Opus" }, { window: "30d", used: 10 }] }} />);
    expect([...container.querySelectorAll("[data-slot='usage-percent']")].map((f) => f.hasAttribute("data-hot"))).toEqual([true, false]);
  });

  it("counts any window as a gauge for the caller", () => {
    expect(hasGauge({ limits: [{ window: "30d", used: 50 }] })).toBe(true);
  });
});

describe("ModelTag usage percent (the default)", () => {
  const usage = { context: 19, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 83 }] };
  const figures = (container: HTMLElement) => [...container.querySelectorAll("[data-slot='usage-percent']")];

  it("draws a whole percentage per gauge, in the same labels and order, and no dots", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" effort="medium" usage={usage} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5 · mediumctx19%5h58%7d83%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h", "7d"]);
    expect(figures(container).map((f) => f.textContent)).toEqual(["19%", "58%", "83%"]);
    expect(container.querySelector("[data-slot='usage-dots']")).toBeNull();
    expect(figures(container).every((f) => f.className.includes("tabular-nums"))).toBe(true);
    // The screen reader keeps the sentence it always had.
    expect(tag?.querySelector(".sr-only")?.textContent).toBe(
      "Model Opus 5.5 · medium. Context 19% used. 5-hour limit 58% used. 7-day limit 83% used",
    );
  });

  it("rounds to a whole number and holds it to 0 to 100", () => {
    const text = (context: number) =>
      render(<ModelTag model={undefined} usage={{ context }} />).container.querySelector("[data-slot='usage-percent']")?.textContent;
    expect(text(0)).toBe("0%");
    expect(text(18.6)).toBe("19%");
    expect(text(41.4)).toBe("41%");
    expect(text(100)).toBe("100%");
    expect(text(130)).toBe("100%");
    expect(text(-4)).toBe("0%");
  });

  it("turns red from 80% and not before, on the number as written", () => {
    const tone = (context: number) => {
      const el = render(<ModelTag model={undefined} usage={{ context }} />).container.querySelector("[data-slot='usage-percent']");
      return [el?.hasAttribute("data-hot"), el?.className.includes("text-status-blocked"), el?.className.includes("text-status-working")];
    };
    expect(tone(79)).toEqual([false, false, false]);
    expect(tone(79.4)).toEqual([false, false, false]);
    expect(tone(79.5)).toEqual([true, true, false]);
    expect(tone(80)).toEqual([true, true, false]);
    expect(tone(100)).toEqual([true, true, false]);
  });

  it("draws nothing for a gauge that is not reported, and never NaN% or 0% for it", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ context: Number.NaN, limits: [{ window: "7d", used: Number.POSITIVE_INFINITY }, { window: "5h", used: 12 }] }} />);
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["5h"]);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(figures(container).map((f) => f.textContent)).toEqual(["12%"]);
    expect(render(<ModelTag model={undefined} usage={{ context: Number.NaN }} />).container.innerHTML).toBe("");
    expect(hasGauge({ context: Number.NaN })).toBe(false);
  });
});

describe("ModelTag context with no stated window: the token count", () => {
  const usage = { contextTokens: 222_200, limits: [{ window: "5h" as const, used: 58 }] };

  it("draws the count in the context's place in Percent, in the same label and type, and says it", () => {
    const { container } = render(<ModelTag model="claude-fable-5-2" usage={usage} usageRow="percent" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Fable 5.2ctx222k5h58%");
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["context", "5h"]);
    const count = container.querySelector("[data-slot='usage-tokens'] .tabular-nums");
    expect(count?.textContent).toBe("222k");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Fable 5.2. Context 222k tokens. 5-hour limit 58% used");
  });

  it("is never red, whatever the count", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ contextTokens: 950_000 }} usageRow="percent" />);
    expect(container.querySelector("[data-slot='usage-tokens']")?.textContent).toBe("ctx950k");
    expect(container.querySelector("[data-hot]")).toBeNull();
    expect(container.innerHTML).not.toContain("text-status-blocked");
  });

  it("draws no dot in Dots, since there is no window to take a fifth of, and still says the count", () => {
    const { container } = render(<ModelTag model="claude-fable-5-2" usage={usage} usageRow="dots" />);
    expect([...container.querySelectorAll("[data-gauge]")].map((g) => g.getAttribute("data-gauge"))).toEqual(["5h"]);
    expect(container.querySelector("[data-slot='usage-tokens']")).toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toContain("Context 222k tokens");
    expect(render(<ModelTag model={undefined} usage={{ contextTokens: 5 }} usageRow="dots" />).container.innerHTML).toBe("");
  });

  it("a share wins over the count, and a count that is no number draws nothing", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ context: 22.2, contextTokens: 222_200 }} usageRow="percent" />);
    expect(container.querySelector("[data-slot='usage-percent']")?.textContent).toBe("22%");
    expect(container.querySelector("[data-slot='usage-tokens']")).toBeNull();
    expect(render(<ModelTag model={undefined} usage={{ contextTokens: Number.NaN }} usageRow="percent" />).container.innerHTML).toBe("");
  });

  it("counts as a figure for the caller, so the model name stays beside it", () => {
    expect(hasFigure({ contextTokens: 222_200 })).toBe(true);
    expect(hasGauge({ contextTokens: 222_200 })).toBe(false);
    expect(modelTagShows({ model: undefined, usage: { contextTokens: 222_200 } })).toBe(true);
  });
});

describe("The Usage row setting reaches the tag", () => {
  const usage = { context: 42, limits: [{ window: "7d" as const, used: 81 }] };
  const stored = () => JSON.parse(localStorage.getItem("collie:dash-prefs:v1") ?? "{}");

  it("is Percent on a device that never chose, and on a stored value it does not know", () => {
    expect(render(<ModelTag model={undefined} usage={usage} />).container.querySelector("[data-slot='usage-percent']")).not.toBeNull();
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ usageRow: "bars" }));
    expect(render(<ModelTag model={undefined} usage={usage} />).container.querySelector("[data-slot='usage-dots']")).toBeNull();
  });

  it("draws dots when the device stored Dots", () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ usageRow: "dots" }));
    const { container } = render(<ModelTag model={undefined} usage={usage} />);
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(2);
    expect(container.querySelector("[data-slot='usage-percent']")).toBeNull();
  });

  it("switches a tag that stays mounted when the choice is made in Settings, and stores it", async () => {
    const { container } = render(
      <>
        <ModelTag model={undefined} usage={usage} />
        <UsageRowControl />
      </>,
    );
    expect(screen.getByRole("radiogroup", { name: "Usage row" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Percent" })).toHaveAttribute("aria-checked", "true");
    expect(stored().usageRow).toBeUndefined();
    await userEvent.click(screen.getByRole("radio", { name: "Dots" }));
    expect(stored().usageRow).toBe("dots");
    expect(screen.getByRole("radio", { name: "Dots" })).toHaveAttribute("aria-checked", "true");
    expect(container.querySelectorAll("[data-slot='usage-dots']")).toHaveLength(2);
    expect(container.querySelector("[data-slot='usage-percent']")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Percent" }));
    expect(stored().usageRow).toBe("percent");
    expect(container.querySelectorAll("[data-slot='usage-percent']")).toHaveLength(2);
  });
});

// The caller keeps the model beside the dots while the screen names it, so "a gauge to draw" is one
// answer in one place.
describe("hasGauge", () => {
  it("is true for a context or a window this build draws, false for nothing", () => {
    expect(hasGauge({ context: 0 })).toBe(true);
    expect(hasGauge({ limits: [{ window: "7d", used: 5 }] })).toBe(true);
    expect(hasGauge({})).toBe(false);
    expect(hasGauge(undefined)).toBe(false);
  });
});

describe("formatCost", () => {
  it("writes under a cent as <$0.01, two decimals under $100, whole dollars from there", () => {
    expect(formatCost(0)).toBe("<$0.01");
    expect(formatCost(0.0099)).toBe("<$0.01");
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.114)).toBe("$0.11");
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(99.99)).toBe("$99.99");
    expect(formatCost(100)).toBe("$100");
    expect(formatCost(123.45)).toBe("$123");
    expect(formatCost(1234.5)).toBe("$1235");
  });

  it("never writes $100.00, and reads a value that is no amount as under a cent", () => {
    expect(formatCost(99.996)).toBe("$100");
    expect(formatCost(Number.NaN)).toBe("<$0.01");
    expect(formatCost(-3)).toBe("<$0.01");
  });
});

describe("ModelTag session cost", () => {
  it("draws the cost after the last gauge, as a figure and not a gauge, and says it", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ context: 42, cost: 0.1137 }} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5ctx42%$0.11");
    const cost = container.querySelector("[data-slot='usage-cost']");
    expect(cost?.textContent).toBe("$0.11");
    expect(cost?.className).toContain("tabular-nums");
    expect(cost?.className).not.toContain("status-working");
    expect(cost?.querySelector("[data-slot='usage-dots']")).toBeNull();
    expect(container.querySelectorAll("[data-gauge]")).toHaveLength(1);
    expect(cost?.previousElementSibling?.getAttribute("data-gauge")).toBe("context");
    expect(tag?.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Context 42% used. Session cost $0.11");
  });

  it("draws <$0.01 for a cost under a cent", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.002 }} />);
    expect(container.querySelector("[data-slot='usage-cost']")?.textContent).toBe("<$0.01");
  });

  it("draws no cost span when none is reported, or when the number is not an amount", () => {
    for (const usage of [undefined, { context: 5 }, { cost: Number.NaN }, { cost: -1 }]) {
      const { container } = render(<ModelTag model="claude-opus-5-5" usage={usage} />);
      expect(container.querySelector("[data-slot='usage-cost']")).toBeNull();
      expect(container.querySelector(".sr-only")?.textContent).not.toContain("Session cost");
    }
  });

  it("draws a tag for a cost alone while the screen names the model, and hasGauge ignores the cost", () => {
    const { container } = render(<ModelTag model={undefined} usage={{ cost: 12.5 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("$12.50");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Session cost $12.50");
    expect(hasGauge({ cost: 12.5 })).toBe(false);
  });

  it("a cost counts like a gauge for the caller: hasFigure keeps the model name beside it", () => {
    expect(hasFigure({ cost: 0.11 })).toBe(true);
    expect(hasFigure({ context: 3 })).toBe(true);
    expect(hasFigure({ cost: Number.NaN })).toBe(false);
    expect(hasFigure({})).toBe(false);
    expect(hasFigure(undefined)).toBe(false);
    // The caller (agent-chat.tsx) passes the model whenever hasFigure is true, so the cost never floats alone.
    const { container } = render(<ModelTag model="claude-opus-5-5" usage={{ cost: 0.11 }} />);
    expect(container.querySelector("[aria-hidden]")?.textContent).toBe("Opus 5.5$0.11");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Model Opus 5.5. Session cost $0.11");
  });
});

describe("ModelTag trick status items", () => {
  const items: StatusItem[] = ["a", "b", "c"].map((id) => ({ id, trick: id, face: <span data-w="60">{`item ${id}`}</span> }));

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ["offsetWidth", "scrollWidth", "clientWidth"]) Reflect.deleteProperty(HTMLElement.prototype, name);
  });

  /** jsdom has no layout: each element is as wide as its `data-w`, else 5px a character, else its first child's. */
  function stubLayout() {
    const width = (el: HTMLElement): number => {
      const own = el.dataset.w;
      if (own !== undefined) return Number(own);
      const child = el.firstElementChild;
      if (child instanceof HTMLElement && child.dataset.w !== undefined) return Number(child.dataset.w);
      return (el.textContent ?? "").length * 5;
    };
    for (const name of ["offsetWidth", "scrollWidth", "clientWidth"]) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return width(this); } });
    }
  }
  const hidden = (container: HTMLElement) => [...container.querySelectorAll("[data-status-item]")].filter((el) => el.hasAttribute("data-hidden")).map((el) => el.getAttribute("data-status-item"));

  it("draws the items after Collie's own, in order, and a lone item draws the tag with no model", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" trailing={items} />);
    const row = container.querySelector("[data-slot='model-tag']")?.textContent;
    expect(row).toContain("Opus 5.5item aitem bitem c");
    expect(container.querySelectorAll("[data-status-item]")).toHaveLength(3);
    expect(render(<ModelTag model={undefined} trailing={items.slice(0, 1)} />).container.querySelector("[data-slot='model-tag']")?.textContent).toBe("item a");
    expect(render(<ModelTag model={undefined} trailing={[]} />).container.innerHTML).toBe("");
  });

  it("keeps the tag a box of no line and the tag itself touch-free", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" trailing={items} />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.className).toContain("pointer-events-none");
    expect(tag?.className).toContain("absolute");
    expect(tag?.className).not.toMatch(/(^|\s)(flex|block|relative|static)(\s|$)/);
  });

  it("hides the newest items first when the row is wider than its room, inert and invisible, still in the tree", () => {
    stubLayout();
    // The mirror box is 280px: 70% is 196, less 8 of padding, 188. "Opus 5.5" is 40, each item 60, gaps of 6:
    // 40 + 6 + 60 + 6 + 60 = 172 fits two; the third would make 238.
    const { container } = render(
      <div data-w="280">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(container)).toEqual(["c"]);
    const c = container.querySelector("[data-status-item='c']");
    expect(c?.className).toContain("invisible");
    expect(c?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("[data-status-item='a']")?.hasAttribute("inert")).toBe(false);
  });

  it("hides every item before it lets the model name shrink, and hides none with room to spare", () => {
    stubLayout();
    const narrow = render(
      <div data-w="100">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(narrow.container)).toEqual(["a", "b", "c"]);
    expect(narrow.container.querySelector("[data-slot='usage-own']")?.textContent).toBe("Opus 5.5");
    const wide = render(
      <div data-w="600">
        <ModelTag model="claude-opus-5-5" trailing={items} />
      </div>,
    );
    expect(hidden(wide.container)).toEqual([]);
  });
});

// THE ROOM THE TAG TAKES FROM THE TAIL (#759): the scrollers under it keep this much clear below the last
// line while a tag shows. `modelTagShows` is the caller's copy of the tag's own "nothing to say" test.
describe("modelTagShows", () => {
  it("agrees with the tag: it shows for a model, a figure or a trick item, and for nothing else", () => {
    const shows = (props: Parameters<typeof modelTagShows>[0]): boolean => render(<ModelTag {...props} />).container.innerHTML !== "";
    const item: StatusItem = { id: "t", trick: "t", face: <span>x</span> };
    const cases: Parameters<typeof modelTagShows>[0][] = [
      { model: undefined },
      { model: "  " },
      { model: "claude-opus-5-5" },
      { model: undefined, usage: { context: 40 } },
      { model: undefined, usage: { cost: 0.5 } },
      { model: undefined, usage: {} },
      { model: undefined, trailing: [item] },
      { model: undefined, trailing: [] },
    ];
    for (const props of cases) expect(modelTagShows(props), JSON.stringify(props)).toBe(shows(props));
  });

  it("the room is the tag's top edge above the box bottom (bottom-1 plus its 12px line) and a little air", () => {
    const { container } = render(<ModelTag model="claude-opus-5-5" />);
    const tag = container.querySelector("[data-slot='model-tag']");
    expect(tag?.className).toContain("bottom-1");
    expect(tag?.className).toContain("text-[10px]/3");
    expect(MODEL_TAG_ROOM).toBeGreaterThanOrEqual(4 + 12);
  });
});
