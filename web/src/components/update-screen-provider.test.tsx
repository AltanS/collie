import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  UpdateScreenProvider,
  useOptionalUpdateScreen,
  useUpdateScreenValue,
} from "./update-screen-provider";
import type { UpdateScreen } from "@/hooks/use-update-screen";
import { __resetUpdateRunStore } from "@/lib/update-run-store";

// ONE READING, HANDED TO BOTH SIDES OF THE ROUTER.
//
// The sheet is mounted outside the router and the band is inside it, and `useUpdateScreen` holds
// per-document state — the ways out taken, a badge opened by hand, the end announced. Two calls
// would be two copies of those, which is two opinions about one screen. A green suite does not prove
// the provider prevents that; these cases do.

const seen: UpdateScreen[] = [];

function Consumer({ label }: { label: string }) {
  const reading = useUpdateScreenValue();
  seen.push(reading);
  return <p>{`${label}:${reading.mode}`}</p>;
}

function Bare() {
  return <p>{`bare:${String(useOptionalUpdateScreen())}`}</p>;
}

describe("the one reading", () => {
  it("is the SAME object in two consumers, so neither can hold its own copy of the state", () => {
    seen.length = 0;
    __resetUpdateRunStore();
    render(
      <UpdateScreenProvider>
        <Consumer label="sheet" />
        <Consumer label="band" />
      </UpdateScreenProvider>,
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Identity, not equality: two hook instances would produce two objects that happen to agree
    // right now and diverge the moment either one's `setExpanded` is called.
    expect(seen.at(-1)).toBe(seen.at(-2));
    __resetUpdateRunStore();
  });

  it("is null outside a provider, which is the right answer for a tree with no App above it", () => {
    render(<Bare />);
    expect(screen.getByText("bare:null")).toBeInTheDocument();
  });

  it("throws for the consumer that is only ever mounted under one, rather than inventing a reading", () => {
    expect(() => render(<Consumer label="sheet" />)).toThrow(/UpdateScreenProvider/);
  });
});
