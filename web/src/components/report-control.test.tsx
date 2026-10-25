import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { reportOfferOf, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useReportTarget } from "@/lib/report/store";
import { ReportControl } from "./report-control";

let target: ReturnType<typeof useReportTarget> = null;
let offer = true;
function Probe() {
  target = useReportTarget();
  offer = reportOfferOf(useDisplayPrefs().prefs);
  return null;
}

describe("ReportControl (ADR 0123)", () => {
  it("the offer is on by default, and the switch turns it off for this device", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(<ReportControl />);
    const toggle = getByRole("switch", { name: "Offer a report when sending fails" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    const { unmount } = render(<Probe />);
    expect(offer).toBe(false);
    unmount();
  });

  it("Report a problem opens the sheet with no pane", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(
      <>
        <ReportControl />
        <Probe />
      </>,
    );
    await user.click(getByRole("button", { name: "Report a problem" }));
    act(() => {});
    expect(target).toEqual({});
  });
});
