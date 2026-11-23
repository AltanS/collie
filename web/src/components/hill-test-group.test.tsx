import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HillDetail } from "@/components/hill-page";
import { HillTestGroup, hillTestSentence } from "@/components/hill-test-group";
import { useHillTest, type HillTestControl, type HillTestResult } from "@/hooks/use-hill-test";
import { en } from "@/lib/i18n/messages/en";
import { SETTINGS } from "@/lib/settings/registry";

// "Try it" on the Hill's page: the group and its words, each result sentence from each code, the disabled states, the slot
// that keeps its height, and the hook that holds the button for the seconds the bridge named.

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), sendHillTest: sendMock }));

afterEach(() => {
  sendMock.mockReset();
  vi.useRealTimers();
});

const idle = (over: Partial<HillTestControl> = {}): HillTestControl => ({ result: null, busy: false, send: vi.fn(() => Promise.resolve()), ...over });
const sent = (rings: string | null, seconds = 20): HillTestResult => ({ kind: "sent", seconds, rings });
const group = (props: { on?: boolean; disabled?: boolean; test?: HillTestControl } = {}) => render(<HillTestGroup on={props.on ?? true} disabled={props.disabled ?? false} test={props.test ?? idle()} />);

describe("the group", () => {
  it("has the heading, the line and the button, with the words of the catalog", () => {
    const view = group();
    expect(view.container.querySelector('[data-section="test"]')).not.toBeNull();
    expect(screen.getByText("Try it")).toBeInTheDocument();
    expect(screen.getByText("Collie sends one test ask marked Now. You see the card arrive, and your phone gets a notification.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Send a test ask" });
    expect(button).toBeEnabled();
    expect(button.className).toContain("h-11");
  });

  it("sits between 'If nothing arrives' and 'Where it comes from' on the page, and is a registered setting the search finds", () => {
    const page = render(<HillDetail on disabled={false} waiting={0} onToggle={() => {}} />);
    expect([...page.container.querySelectorAll("[data-section]")].map((el) => el.getAttribute("data-section"))).toEqual(["head", "about-group", "about", "who", "rings", "quiet", "test", "from"]);
    const row = SETTINGS.find((setting) => setting.id === "tricks.hill.test");
    expect(row).toMatchObject({ kind: "action", page: "tricks", below: "asks", label: "settings.hill.test.button" });
    expect(en[row!.label]).toBe("Send a test ask");
    expect(page.container.querySelector('[data-setting="tricks.hill.test"]')).not.toBeNull();
  });

  it("calls send on a tap", () => {
    const test = idle();
    group({ test });
    fireEvent.click(screen.getByRole("button", { name: "Send a test ask" }));
    expect(test.send).toHaveBeenCalledTimes(1);
  });
});

describe("the sentence under the button", () => {
  const PRE = "A test ask arrives in 20 seconds. No notification is sent, because ";
  const cases: Array<[string, string]> = [
    ["push_off", `${PRE}notifications are not set up on this Collie.`],
    ["no_devices", `${PRE}no device has notifications switched on.`],
    ["pref_off", `${PRE}the notification for an ask marked Now is switched off.`],
    ["snoozed", `${PRE}notifications are snoozed.`],
    ["crew_member", `${PRE}this machine is a crew member, and the lead sends the notifications.`],
    ["quiet", `${PRE}your crew state is Quiet.`],
    ["away", `${PRE}your crew state is Away.`],
    ["rate", `${PRE}too many notifications for asks went out in the last hour.`],
  ];

  it("says the notification is on its way, with the seconds in place", () => {
    expect(hillTestSentence(true, sent(null))).toBe("A test ask arrives in 20 seconds. Leave the app now to get the notification on your phone.");
    expect(hillTestSentence(true, sent(null, 9))).toBe("A test ask arrives in 9 seconds. Leave the app now to get the notification on your phone.");
  });

  it.each(cases)("for the code %s names its reason in a whole sentence", (code, sentence) => {
    expect(hillTestSentence(true, sent(code))).toBe(sentence);
    group({ test: idle({ result: sent(code), busy: true }) });
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it("reads a code from a newer bridge as 'may not be sent'", () => {
    expect(hillTestSentence(true, sent("something_new"))).toBe("A test ask arrives in 20 seconds. A notification may not be sent.");
  });

  it("says a failure in one line, and 'Switch Asks on first.' while Asks is off, whatever the result", () => {
    expect(hillTestSentence(true, { kind: "failed" })).toBe("Could not send the test. Try again.");
    expect(hillTestSentence(false, null)).toBe("Switch Asks on first.");
    expect(hillTestSentence(false, sent(null))).toBe("Switch Asks on first.");
    expect(hillTestSentence(true, null)).toBe("");
  });

  it("never says ring, in any sentence of the group", () => {
    for (const [key, words] of Object.entries(en)) {
      if (key.startsWith("settings.hill.test.") || key.startsWith("settings.hill.rings.")) expect(words).not.toMatch(/\brings?\b|\brang\b/iu);
    }
  });
});

describe("the disabled states", () => {
  it("disables the button while the Hill is off, and the slot says to switch it on", () => {
    group({ on: false });
    expect(screen.getByRole("button", { name: "Send a test ask" })).toBeDisabled();
    expect(screen.getByText("Switch Asks on first.")).toBeInTheDocument();
  });

  it("disables it where the device may not write", () => {
    group({ disabled: true });
    expect(screen.getByRole("button", { name: "Send a test ask" })).toBeDisabled();
  });

  it("disables it while a request runs or the seconds the bridge named have not passed", () => {
    group({ test: idle({ busy: true }) });
    expect(screen.getByRole("button", { name: "Send a test ask" })).toBeDisabled();
  });
});

describe("the reserved slot", () => {
  it("is there before any press and keeps one element through every outcome, so the page does not jump", () => {
    const view = group();
    const slot = view.container.querySelector('[data-line="test-result"]')!;
    expect(slot).toHaveTextContent("");
    expect(slot.className).toContain("min-h-12");
    view.rerender(<HillTestGroup on disabled={false} test={idle({ result: sent("crew_member"), busy: true })} />);
    expect(view.container.querySelector('[data-line="test-result"]')).toBe(slot);
    view.rerender(<HillTestGroup on={false} disabled={false} test={idle()} />);
    expect(view.container.querySelector('[data-line="test-result"]')).toBe(slot);
    expect(slot.getAttribute("aria-live")).toBe("polite");
  });
});

describe("the hook", () => {
  function Probe() {
    const test = useHillTest();
    return <HillTestGroup on disabled={false} test={test} />;
  }

  it("sends once, keeps the sentence, holds the button for the seconds the bridge named, then frees it", async () => {
    vi.useFakeTimers();
    sendMock.mockResolvedValue({ inSeconds: 20, rings: null });
    render(<Probe />);
    const button = screen.getByRole("button", { name: "Send a test ask" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A test ask arrives in 20 seconds. Leave the app now to get the notification on your phone.")).toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(sendMock).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(19_999));
    expect(button).toBeDisabled();
    act(() => vi.advanceTimersByTime(1));
    expect(button).toBeEnabled();
    // The sentence stays after the button comes back.
    expect(screen.getByText(/A test ask arrives in 20 seconds/u)).toBeInTheDocument();
  });

  it("a failed call says so, keeps the button enabled, and a second tap tries again", async () => {
    sendMock.mockRejectedValueOnce(new Error("409")).mockResolvedValueOnce({ inSeconds: 3, rings: "quiet" });
    render(<Probe />);
    const button = screen.getByRole("button", { name: "Send a test ask" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText("Could not send the test. Try again.")).toBeInTheDocument();
    expect(button).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText("A test ask arrives in 3 seconds. No notification is sent, because your crew state is Quiet.")).toBeInTheDocument();
  });
});
