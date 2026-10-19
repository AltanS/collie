import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLinksProvider } from "@/components/file-links";
import { testFileOpener } from "@/test/file-links";
import { OutputZoom, type OutputZoomProps } from "./output-zoom";

// Phone width or not, per case: the bottom Back is drawn on a phone only (components/back-bar.tsx).
const media = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => media.phone }));
afterEach(() => {
  media.phone = false;
});

function zoom(over: Partial<OutputZoomProps> = {}) {
  const props: OutputZoomProps = {
    text: "line one\nline two",
    fontSize: 11,
    face: {},
    title: "build pane",
    hand: "right",
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(<OutputZoom {...props} />) };
}

/** The readout doubles as the reset button, and its name carries the scale it shows. */
const readout = () => screen.getByRole("button", { name: /^Reset zoom/ });
const viewport = () => screen.getByRole("dialog", { name: "Zoomed output" }).querySelector<HTMLElement>("[tabindex='-1']")!;

const at = (clientX: number, clientY: number) => ({ clientX, clientY });

function tapAt(el: HTMLElement, x: number, y: number) {
  fireEvent.touchStart(el, { touches: [at(x, y)] });
  fireEvent.touchEnd(el, { touches: [] });
}

describe("OutputZoom", () => {
  it("is a full-screen dialog holding the pane's text and the reading controls, nothing else", () => {
    zoom();
    const dialog = screen.getByRole("dialog", { name: "Zoomed output" });
    expect(dialog.className).toMatch(/(?:^|\s)fixed(?=\s|$)/);
    expect(dialog.className).toMatch(/(?:^|\s)h-\(--app-h\)(?=\s|$)/);
    expect(dialog).toHaveTextContent("line one");
    expect(dialog).toHaveTextContent("line two");
    expect(screen.getByRole("heading", { name: "build pane" })).toBeInTheDocument();
    // No field and no composer control: the view reads, it never types.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Back to the pane",
      "Zoom out",
      "Reset zoom (1×)",
      "Zoom in",
    ]);
  });

  it("opens at 1× with the text laid out as the mirror lays it, and lets the browser pan it", () => {
    zoom();
    expect(readout()).toHaveTextContent("1×");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    // One finger pans natively; the browser's own pinch and double-tap zoom stand down.
    expect(viewport().className).toContain("[touch-action:pan-x_pan-y]");
    expect(viewport().className).toMatch(/(?:^|\s)overflow-auto(?=\s|$)/);
  });

  it("closes on the ✕ and on Escape", async () => {
    const { props } = zoom();
    await userEvent.click(screen.getByRole("button", { name: "Back to the pane" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("steps with the buttons, clamped to 6×, and the readout resets it", async () => {
    zoom();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    await userEvent.click(zoomIn);
    expect(readout()).toHaveTextContent("1.5×");
    for (let i = 0; i < 5; i++) await userEvent.click(zoomIn);
    expect(readout()).toHaveTextContent("6×");
    expect(zoomIn).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(readout()).toHaveTextContent("4×");
    await userEvent.click(readout());
    expect(readout()).toHaveTextContent("1×");
  });

  it("zooms with + and − and resets with 0 from the keyboard", () => {
    zoom();
    fireEvent.keyDown(window, { key: "+" });
    expect(readout()).toHaveTextContent("1.5×");
    fireEvent.keyDown(window, { key: "-" });
    expect(readout()).toHaveTextContent("1×");
    fireEvent.keyDown(window, { key: "=" });
    fireEvent.keyDown(window, { key: "0" });
    expect(readout()).toHaveTextContent("1×");
  });

  it("pinches: two fingers spreading to twice their distance zoom to 2×", () => {
    zoom();
    const vp = viewport();
    fireEvent.touchStart(vp, { touches: [at(100, 300), at(200, 300)] });
    fireEvent.touchMove(vp, { touches: [at(75, 300), at(225, 300)] });
    expect(readout()).toHaveTextContent("1.5×");
    fireEvent.touchMove(vp, { touches: [at(50, 300), at(250, 300)] });
    expect(readout()).toHaveTextContent("2×");
    fireEvent.touchEnd(vp, { touches: [] });
    // The pinch ended where it was; a later move of one finger is a native pan, not a zoom.
    fireEvent.touchStart(vp, { touches: [at(100, 300)] });
    fireEvent.touchMove(vp, { touches: [at(100, 100)] });
    fireEvent.touchEnd(vp, { touches: [] });
    expect(readout()).toHaveTextContent("2×");
  });

  it("refuses the browser's own handling of a two-finger move", () => {
    zoom();
    const vp = viewport();
    fireEvent.touchStart(vp, { touches: [at(100, 300), at(200, 300)] });
    // `fireEvent` answers false when a listener called preventDefault.
    expect(fireEvent.touchMove(vp, { touches: [at(90, 300), at(210, 300)], cancelable: true })).toBe(false);
  });

  it("double tap toggles between 1× and 2.5×; a single tap and a drag do nothing", () => {
    zoom();
    const vp = viewport();
    tapAt(vp, 100, 100);
    expect(readout()).toHaveTextContent("1×");
    tapAt(vp, 102, 101);
    expect(readout()).toHaveTextContent("2.5×");
    tapAt(vp, 100, 100);
    tapAt(vp, 100, 100);
    expect(readout()).toHaveTextContent("1×");
    // A drag between two taps breaks the pair.
    tapAt(vp, 100, 100);
    fireEvent.touchStart(vp, { touches: [at(100, 100)] });
    fireEvent.touchMove(vp, { touches: [at(100, 160)] });
    fireEvent.touchEnd(vp, { touches: [] });
    tapAt(vp, 100, 100);
    expect(readout()).toHaveTextContent("1×");
  });

  it("keeps updating from the live text", () => {
    const { props, rerender } = zoom();
    rerender(<OutputZoom {...props} text={"line one\nline two\nline three"} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("line three");
  });

  it("says so when the pane has printed nothing", () => {
    zoom({ text: "" });
    expect(screen.getByRole("dialog")).toHaveTextContent("(no recent output)");
  });

  it("draws a printed path as text, never as a link: a pinch that starts on one must not open Files", () => {
    const opened: string[] = [];
    render(
      <FileLinksProvider value={testFileOpener(opened)}>
        <OutputZoom text="edited src/lib/nav.ts:12" fontSize={11} face={{}} title="p" hand="right" onClose={vi.fn()} />
      </FileLinksProvider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("src/lib/nav.ts:12");
    expect(dialog.querySelector("a")).toBeNull();
  });

  it("never wraps: each terminal row is one line, as wide as it is, and nothing inside takes a sideways drag", () => {
    // A row far wider than the phone, and a markdown table, which the wrapping mirror pans in a
    // scroller of its own (lib/table-run.ts).
    const wide = `LINE ${"x".repeat(300)} end`;
    const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    zoom({ text: `${wide}\n${table}` });
    const dialog = screen.getByRole("dialog");
    const pre = dialog.querySelector("pre")!;
    expect(pre.className).toMatch(/(?:^|\s)whitespace-pre(?=\s|$)/);
    expect(pre.className).not.toMatch(/(?:^|\s)whitespace-pre-wrap(?=\s|$)/);
    // The <pre> is no scroller of its own and holds no table scroller: the viewport is the one.
    expect(pre.className).toMatch(/(?:^|\s)overflow-visible(?=\s|$)/);
    expect(dialog.querySelectorAll(".overflow-x-auto")).toHaveLength(0);
    // The text box takes the longest row's width, which is what the pan bounds measure.
    expect(pre.parentElement!.style.width).toBe("max-content");
    expect(dialog).toHaveTextContent(wide);
  });

  it("repeats its Back at the bottom on a phone, on the thumb's side, with the ✕'s act and name", async () => {
    media.phone = true;
    const { props } = zoom({ hand: "left" });
    const backs = screen.getAllByRole("button", { name: "Back to the pane" });
    expect(backs).toHaveLength(2);
    const bar = backs[1]!.closest<HTMLElement>('[data-slot="bottom-bar"]')!;
    expect(bar.className).toMatch(/(?:^|\s)justify-start(?=\s|$)/);
    await userEvent.click(backs[1]!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
