import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetOperatorBusy } from "@/lib/busy";
import { clearStatus } from "@/lib/status";
import { CollieHome } from "./collie-home";

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
