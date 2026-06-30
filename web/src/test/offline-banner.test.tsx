import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { OfflineBanner } from "@/components/offline-banner";

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

afterEach(() => {
  setOnline(true);
});

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a disconnected banner while offline", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });
});
