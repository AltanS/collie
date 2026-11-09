import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
