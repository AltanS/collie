import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BottomSheet } from "./sheet";

// Stacked sheets (ADR 0173): Escape closes only the top one. The `form` dialog's Tab trap
// needs real layout (jsdom has none); e2e/wide-new.spec.ts walks it.

afterEach(() => {
  cleanup();
});

describe("stacked sheets", () => {
  it("Escape closes the top sheet only", () => {
    const under = vi.fn();
    const top = vi.fn();
    render(
      <>
        <BottomSheet open onClose={under} title="Under">
          <p>under</p>
        </BottomSheet>
        <BottomSheet open onClose={top} title="Top">
          <p>top</p>
        </BottomSheet>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(top).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });
});
