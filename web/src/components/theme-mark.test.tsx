import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetOperatorBusy } from "@/lib/busy";
import { SHIPPED_MARKS } from "@/lib/shipped-marks";
import { clearStatus } from "@/lib/status";
import { addImported, removeImported, setActiveTheme } from "@/lib/theme/store";
import { CollieHome } from "./collie-home";
import { MARKS, type MarkProps, type MarkState } from "./marks";
import { CollieMarkAdapter } from "./marks/collie";
import { ThemeMark } from "./theme-mark";

// THE DOG DOES NOT MOVE BY ONE BYTE (M57 spec 09). The header mark's box, `[data-slot='collie-mark']`
// in collie-home.tsx, is read as outer HTML in its three states and held against a fixture taken from
// the parent branch m57-04 (80d54e13) BEFORE the header learned to mount a theme's mark. The fixture
// was committed first, on its own, so this test passed on the old code before it was asked to pass on
// the new one. A class that moves, a class in a new order, an attribute or a wrapper more: each one
// fails here. The fixtures are never regenerated from the new code.
const STATES = {
  idle: <CollieHome trouble={false} />,
  loading: <CollieHome trouble />,
  lost: <CollieHome trouble lost />,
} satisfies Record<"idle" | "loading" | "lost", ReactElement>;

function fixture(state: keyof typeof STATES): string {
  return readFileSync(join(import.meta.dirname, "..", "test", "header-mark", `${state}.html`), "utf8");
}

function headerMarkHtml(element: ReactElement): string {
  const { container } = render(element);
  const box = container.querySelector("[data-slot='collie-mark']");
  if (box === null) throw new Error("no header mark box");
  return box.outerHTML;
}

describe("the header mark", () => {
  beforeEach(() => {
    clearStatus();
    __resetOperatorBusy();
  });
  afterEach(() => cleanup());

  for (const state of ["idle", "loading", "lost"] as const) {
    it(`is byte-identical to the parent's header mark while ${state}`, () => {
      expect(headerMarkHtml(STATES[state])).toBe(fixture(state));
    });
  }
});

// THE CONTRACT, for every mark in the registry. Spec 10's marks replace three entries and must pass
// these as they stand: one inline <svg> of `size` by `size`, nothing beside it, decorative without a
// title, named with one, and all three states drawn.
describe("every shipped mark", () => {
  afterEach(() => cleanup());

  it("has one registry entry per shipped mark id", () => {
    expect(Object.keys(MARKS).toSorted()).toEqual(SHIPPED_MARKS.toSorted());
  });

  for (const id of SHIPPED_MARKS) {
    for (const state of ["idle", "loading", "lost"] as const) {
      it(`${id} draws one svg of its size while ${state}, decorative without a title`, () => {
        const Mark = MARKS[id];
        const { container } = render(<Mark size={24} state={state} weight="header" />);
        expect(container.children).toHaveLength(1);
        const svg = container.firstElementChild;
        expect(svg?.tagName.toLowerCase()).toBe("svg");
        expect(svg?.getAttribute("width")).toBe("24");
        expect(svg?.getAttribute("height")).toBe("24");
        expect(svg?.getAttribute("role")).toBe("presentation");
      });
    }

    it(`${id} is an image when it has a title`, () => {
      const Mark = MARKS[id];
      const { container } = render(<Mark size={40} title="Collie" />);
      expect(container.firstElementChild?.getAttribute("role")).toBe("img");
    });
  }
});

describe("the collie adapter", () => {
  afterEach(() => cleanup());

  function svgOf(props: MarkProps): SVGSVGElement {
    const { container } = render(<CollieMarkAdapter {...props} />);
    const svg = container.querySelector("svg");
    if (svg === null) throw new Error("no svg");
    return svg;
  }

  it("rests while idle, turns while loading, and greys out after the caller's classes while lost", () => {
    expect(svgOf({ state: "idle" }).getAttribute("class")).toBeNull();
    expect(svgOf({ state: "loading" }).getAttribute("class")).toBe("cm-live");
    expect(svgOf({ state: "lost" }).getAttribute("class")).toBe("opacity-40 grayscale");
    expect(svgOf({ state: "lost", className: "transition-opacity" }).getAttribute("class")).toBe(
      "transition-opacity opacity-40 grayscale",
    );
  });

  it("is idle when no state is given", () => {
    // The header weight: the full one carries per-instance gradient ids.
    expect(svgOf({ weight: "header" }).outerHTML).toBe(svgOf({ weight: "header", state: "idle" }).outerHTML);
  });
});

describe("ThemeMark", () => {
  afterEach(() => {
    cleanup();
    setActiveTheme("collie");
    removeImported("owl");
  });

  it("adds no element and no attribute of its own", () => {
    const states: MarkState[] = ["idle", "loading", "lost"];
    for (const state of states) {
      const direct = render(<CollieMarkAdapter size={40} weight="header" state={state} />).container.innerHTML;
      cleanup();
      const { container } = render(<ThemeMark size={40} weight="header" state={state} />);
      expect(container.innerHTML).toBe(direct);
      cleanup();
    }
  });

  it("draws the registry entry for the active theme's mark", () => {
    const before = MARKS.nightwatch;
    MARKS.nightwatch = function Probe({ size }: MarkProps) {
      return <svg data-probe="nightwatch" width={size} height={size} role="presentation" />;
    };
    try {
      expect(
        addImported({ version: 1, id: "owl", name: "Owl", light: { background: "#ffffff" }, mark: "nightwatch" }),
      ).toEqual({ ok: true });
      const { container, rerender } = render(<ThemeMark size={40} />);
      expect(container.querySelector("[data-probe]")).toBeNull();
      act(() => setActiveTheme("owl"));
      rerender(<ThemeMark size={40} />);
      expect(container.querySelector("[data-probe='nightwatch']")).not.toBeNull();
    } finally {
      MARKS.nightwatch = before;
    }
  });
});
