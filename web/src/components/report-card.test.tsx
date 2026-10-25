import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReportCard } from "./report-card";

describe("ReportCard (ADR 0123)", () => {
  it("says how many sends failed, and Report and the cross each call their own handler", async () => {
    const user = userEvent.setup();
    const onReport = vi.fn();
    const onClose = vi.fn();
    const { container, getByRole } = render(<ReportCard count={3} onReport={onReport} onClose={onClose} />);
    const card = container.querySelector('[data-slot="report-card"]');
    expect(card).toHaveTextContent("Sending failed 3 times. This may be a bug.");
    await user.click(getByRole("button", { name: "Report this problem" }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(getByRole("button", { name: "Close the report offer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stands on the floating card, which holds no space in the layout", () => {
    const { container } = render(<ReportCard count={4} onReport={() => {}} onClose={() => {}} />);
    const card = container.querySelector('[data-slot="report-card"]');
    expect(card).toHaveTextContent("Sending failed 4 times.");
    expect(card?.className).toContain("pointer-events-auto");
    expect(card?.className).toContain("shadow-md");
  });
});
