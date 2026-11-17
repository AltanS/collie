import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALM_HOLD_MS } from "@/hooks/use-bounded-hold";
import { __resetTelemetryRead, useTelemetryNoticeRead } from "@/hooks/use-telemetry-notice";
import { server } from "@/test/setup";
import {
  __reloadTelemetryNotice,
  __resetTelemetryNotice,
  shouldShowTelemetryNotice,
  telemetryNoticeKind,
  type TelemetryNoticeKind,
} from "@/lib/telemetry-notice";
import type { TelemetryView } from "@/lib/types";
import { TelemetryNotice } from "./telemetry-notice";

// The one-time install-count notice (M86 spec 02): shown once on the dashboard while the count is on
// by default, gone when it is off, gone for good once dismissed.

const BODY = "Collie 1.27.0 sends anonymous telemetry once a day. Turn it off in Settings.";
const UPDATE_BODY =
  "Collie's daily count now also names a dialog it could not read, by a short code made from the dialog's key hints, never from your text.";
const DOCS = "https://colliepwa.dev/docs/security#what-leaves-your-machine";
const KEY = "collie.telemetryNotice.v1";

const view = (over: Partial<TelemetryView> = {}): TelemetryView => ({ on: true, decidedBy: "default", setting: null, next: null, ...over });

function Where() {
  const { pathname, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${hash}`}</p>;
}

function renderNotice(initial: TelemetryView | "fail") {
  let reads = 0;
  server.use(
    http.get("/api/telemetry", () => {
      reads += 1;
      return initial === "fail" ? HttpResponse.json({ error: "x" }, { status: 500 }) : HttpResponse.json(initial);
    }),
  );
  const router = createMemoryRouter(
    [
      { path: "/", element: <TelemetryNotice /> },
      { path: "/settings/system/install-count", element: <Where /> },
    ],
    { initialEntries: ["/"] },
  );
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, router, reads: () => reads };
}

beforeEach(() => {
  __resetTelemetryNotice();
  __resetTelemetryRead();
});

describe("shouldShowTelemetryNotice", () => {
  it("is true only while a notice is owed and the count is on by default", () => {
    for (const kind of ["first", "update"] as const) {
      expect(shouldShowTelemetryNotice({ kind, view: view() })).toBe(true);
      expect(shouldShowTelemetryNotice({ kind, view: null })).toBe(false);
      expect(shouldShowTelemetryNotice({ kind, view: view({ on: false, decidedBy: "settings" }) })).toBe(false);
      expect(shouldShowTelemetryNotice({ kind, view: view({ on: true, decidedBy: "env" }) })).toBe(false);
      expect(shouldShowTelemetryNotice({ kind, view: view({ on: true, decidedBy: "config" }) })).toBe(false);
      expect(shouldShowTelemetryNotice({ kind, view: view({ on: true, decidedBy: "settings" }) })).toBe(false);
    }
    expect(shouldShowTelemetryNotice({ kind: "none", view: view() })).toBe(false);
  });
});

describe("the stored revision", () => {
  const kindFor = (stored: string | null): TelemetryNoticeKind => {
    if (stored === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, stored);
    __reloadTelemetryNotice();
    return telemetryNoticeKind();
  };

  it("owes the 1.27.0 notice to a device that read nothing, the update to \"1\", and nothing to \"2\"", () => {
    expect(kindFor(null)).toBe("first");
    expect(kindFor("1")).toBe("update");
    expect(kindFor("2")).toBe("none");
  });

  it("reads a value it does not know as nothing read, and a newer one as everything read", () => {
    expect(kindFor("junk")).toBe("first");
    expect(kindFor("0")).toBe("first");
    expect(kindFor("3")).toBe("none");
  });
});

describe("the install-count notice", () => {
  it("shows when the count is on by default", async () => {
    renderNotice(view());
    expect(await screen.findByText(BODY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toBeInTheDocument();
  });

  it.each<Partial<TelemetryView>>([
    { on: false, decidedBy: "settings", setting: "off" },
    { on: false, decidedBy: "env" },
    { on: false, decidedBy: "config" },
    { on: false, decidedBy: "do_not_track" },
    { on: false, decidedBy: "ci" },
    { on: false, decidedBy: "mirror" },
    { on: false, decidedBy: "dev_build" },
    { on: true, decidedBy: "settings", setting: "on" },
    { on: true, decidedBy: "env" },
  ])("is not shown when the machine says %j", async (over) => {
    const { reads } = renderNotice(view(over));
    await waitFor(() => expect(reads()).toBe(1));
    // Give the read time to land and the notice time to (not) open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("draws nothing when the read fails", async () => {
    const { reads } = renderNotice("fail");
    await waitFor(() => expect(reads()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("the X spends it on this device: it closes, is kept, and a later open asks nothing", async () => {
    const user = userEvent.setup();
    const first = renderNotice(view());
    await screen.findByText(BODY);
    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => expect(screen.queryByText(BODY)).toBeNull());
    expect(localStorage.getItem(KEY)).toBe("2");
    first.unmount();

    // A fresh page load reads the key back: no notice, and no request for it.
    __reloadTelemetryNotice();
    const second = renderNotice(view());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(BODY)).toBeNull();
    expect(second.reads()).toBe(0);
  });

  it("a reload without a tap shows it again: only the operator's own act spends it", async () => {
    const first = renderNotice(view());
    await screen.findByText(BODY);
    expect(localStorage.getItem(KEY)).toBeNull();
    first.unmount();
    __reloadTelemetryNotice();
    renderNotice(view());
    expect(await screen.findByText(BODY)).toBeInTheDocument();
  });

  it("the button opens the card on its page in Settings, System, and spends the notice", async () => {
    const user = userEvent.setup();
    renderNotice(view());
    await user.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/settings/system/install-count");
    expect(localStorage.getItem(KEY)).toBe("2");
  });
});

describe("the update notice (revision 1 to 2)", () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.setItem(KEY, "1");
    __reloadTelemetryNotice();
    open = vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => open.mockRestore());

  it("shows once, with the docs button only, and not the 1.27.0 text", async () => {
    renderNotice(view());
    expect(await screen.findByText(UPDATE_BODY)).toBeInTheDocument();
    expect(screen.queryByText(BODY)).toBeNull();
    expect(screen.getByRole("button", { name: "What is sent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("stands under the same rule: not when the count is off or not by default", async () => {
    const { reads } = renderNotice(view({ on: false, decidedBy: "settings", setting: "off" }));
    await waitFor(() => expect(reads()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(UPDATE_BODY)).toBeNull();
  });

  it("the button opens the docs in a new tab, without opener, and spends it", async () => {
    const user = userEvent.setup();
    renderNotice(view());
    await user.click(await screen.findByRole("button", { name: "What is sent" }));
    expect(open).toHaveBeenCalledWith(DOCS, "_blank", "noopener,noreferrer");
    expect(localStorage.getItem(KEY)).toBe("2");
    await waitFor(() => expect(screen.queryByText(UPDATE_BODY)).toBeNull());
  });

  it("the X spends it without opening anything, and a reload asks nothing", async () => {
    const user = userEvent.setup();
    const first = renderNotice(view());
    await user.click(await screen.findByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => expect(screen.queryByText(UPDATE_BODY)).toBeNull());
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("2");
    first.unmount();

    __reloadTelemetryNotice();
    const second = renderNotice(view());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(UPDATE_BODY)).toBeNull();
    expect(second.reads()).toBe(0);
  });

  it("a reload without a tap shows it again", async () => {
    const first = renderNotice(view());
    await screen.findByText(UPDATE_BODY);
    first.unmount();
    __reloadTelemetryNotice();
    renderNotice(view());
    expect(await screen.findByText(UPDATE_BODY)).toBeInTheDocument();
  });
});

// CALM LOAD (row 16): the route keeps the list unseen for at most 400 ms while the one read answers, and the
// notice is handed over already open in the frame the list appears. Past the bound it does not open on this load.
describe("the notice and the list, on a cold load", () => {
  /** The route's half, as routes/home.tsx wires it: the scroller is unseen while `held`; every render is noted. */
  function renderPage(frames: string[]) {
    function Page() {
      const read = useTelemetryNoticeRead();
      frames.push(`${read.held ? "held" : "shown"}:${read.view === null ? "no-notice" : "notice"}`);
      return (
        <div data-testid="scroller" className={read.held ? "invisible" : ""}>
          <TelemetryNotice read={read} />
          <main data-testid="list" />
        </div>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Page /> }], { initialEntries: ["/"] });
    return render(<RouterProvider router={router} />);
  }

  /** The machine's answer, held until `release()`, after `delay` ms. */
  function slowRead(answer: TelemetryView, delay = 0) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get("/api/telemetry", async () => {
        await gate;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return HttpResponse.json(answer);
      }),
    );
    return release;
  }

  it("keeps the list unseen, then shows the list and the open notice in one frame", async () => {
    const release = slowRead(view());
    const frames: string[] = [];
    renderPage(frames);
    expect(screen.getByTestId("scroller")).toHaveClass("invisible");
    expect(screen.queryByText(BODY)).toBeNull();
    release();
    expect(await screen.findByText(BODY)).toBeInTheDocument();
    expect(screen.getByTestId("scroller")).not.toHaveClass("invisible");
    // The notice came with the list: no frame showed the list without it.
    expect(frames).not.toContain("shown:no-notice");
    expect(frames.at(-1)).toBe("shown:notice");
    // The notice stands before the list, where it always stood.
    const scroller = screen.getByTestId("scroller");
    expect(scroller.firstElementChild).not.toBe(screen.getByTestId("list"));
    expect(scroller.lastElementChild).toBe(screen.getByTestId("list"));
  });

  it("shows the list at once, with no notice, when the answer inside the bound says there is none", async () => {
    const release = slowRead(view({ on: false, decidedBy: "settings", setting: "off" }));
    renderPage([]);
    expect(screen.getByTestId("scroller")).toHaveClass("invisible");
    release();
    await waitFor(() => expect(screen.getByTestId("scroller")).not.toHaveClass("invisible"));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("waits no longer than the bound, and an answer past it opens nothing on this load", async () => {
    const release = slowRead(view());
    renderPage([]);
    expect(screen.getByTestId("scroller")).toHaveClass("invisible");
    await waitFor(() => expect(screen.getByTestId("scroller")).not.toHaveClass("invisible"), { timeout: CALM_HOLD_MS * 4 });
    release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("a later mount of the page draws the notice in its first frame and holds nothing", async () => {
    const first = slowRead(view());
    const one = renderPage([]);
    first();
    await screen.findByText(BODY);
    one.unmount();
    const frames: string[] = [];
    renderPage(frames);
    expect(frames[0]).toBe("shown:notice");
    expect(screen.getByTestId("scroller")).not.toHaveClass("invisible");
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it("holds nothing on a device that spent the notice, and asks nothing", async () => {
    localStorage.setItem(KEY, "2");
    __reloadTelemetryNotice();
    let reads = 0;
    server.use(
      http.get("/api/telemetry", () => {
        reads += 1;
        return HttpResponse.json(view());
      }),
    );
    renderPage([]);
    expect(screen.getByTestId("scroller")).not.toHaveClass("invisible");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(0);
  });
});
