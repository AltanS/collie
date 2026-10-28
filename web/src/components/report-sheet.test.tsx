import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { BUILD } from "@/lib/build";
import { fitLink, reportFields, reportText, type ReportContext, type ReportInput } from "@/lib/report/body";
import type { SendReceiptRow } from "@/lib/surface/send";
import { server } from "@/test/setup";
import { ReportSheet, ReportSheetView, reportedSends } from "./report-sheet";

const CONTEXT: ReportContext = { collie: "1.24.1", line: "stable", os: "linux", arch: "x64", mux: "herdr", harness: "claude", screenable: true };

function row(n: number, extra: Partial<SendReceiptRow> = {}): SendReceiptRow {
  return {
    requestId: `sheet-${String(n).padStart(5, "0")}`,
    at: Date.parse("2026-10-25T18:00:00Z") + n * 1000,
    mode: "send",
    outcome: "unknown",
    reason: "no_evidence",
    keys: ["Enter"],
    gapsMs: { s2: 3000 },
    harness: "claude",
    version: "2.1.291",
    ...extra,
  };
}

const SENDS = [row(3, { line: "ship it" }), row(2), row(1)];

function preview(container: HTMLElement): string {
  return container.querySelector('[data-slot="report-preview"]')?.textContent ?? "";
}

function base(extra: Partial<ReportInput> = {}): ReportInput {
  return { context: CONTEXT, sends: SENDS, episodes: [], note: "", includeTyped: false, screen: null, app: BUILD.version, ...extra };
}

describe("ReportSheetView (ADR 0123)", () => {
  it("the preview is the exact text the link carries, and Open on GitHub is that link", () => {
    const { container } = render(<ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={vi.fn()} />);
    const link = fitLink(reportFields(base()));
    expect(preview(container)).toBe(reportText(link.fields));
    const open = container.querySelector<HTMLAnchorElement>('[data-slot="report-open"]');
    expect(open?.getAttribute("href")).toBe(link.url);
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toContain("noopener");
    expect(preview(container)).not.toContain("ship it");
    expect(container).toHaveTextContent("The issue is public on GitHub. Read it before you send.");
  });

  it("the line and both switches change the body; both switches start off", async () => {
    const user = userEvent.setup();
    const loadScreen = vi.fn(async () => "❯ hello\n• masked •");
    const { container, getByRole, getByPlaceholderText } = render(
      <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={loadScreen} />,
    );
    const typed = getByRole("switch", { name: "Include what I typed" });
    const screenSwitch = getByRole("switch", { name: "Include the screen" });
    expect(typed).toHaveAttribute("aria-checked", "false");
    expect(screenSwitch).toHaveAttribute("aria-checked", "false");
    expect(loadScreen).not.toHaveBeenCalled();

    await user.type(getByPlaceholderText("Optional"), "replying to claude");
    await user.click(typed);
    expect(preview(container)).toContain("### What happened\n\nreplying to claude");
    expect(preview(container)).toContain("typed: ship it");

    await user.click(screenSwitch);
    await waitFor(() => expect(preview(container)).toContain("### The screen\n\n❯ hello\n• masked •"));
    expect(loadScreen).toHaveBeenCalledTimes(1);
    expect(preview(container)).toBe(reportText(fitLink(reportFields(base({ note: "replying to claude", includeTyped: true, screen: "❯ hello\n• masked •" }))).fields));

    await user.click(screenSwitch);
    expect(preview(container)).not.toContain("### The screen");
  });

  it("hides Include what I typed when no send kept a line, and Include the screen on a pane with no screen", () => {
    const { queryByRole } = render(
      <ReportSheetView context={{ ...CONTEXT, screenable: false }} contextError={null} rows={[row(1)]} episodes={[]} fromSettings={false} loadScreen={vi.fn()} />,
    );
    expect(queryByRole("switch", { name: "Include what I typed" })).toBeNull();
    expect(queryByRole("switch", { name: "Include the screen" })).toBeNull();
  });

  it("says what the link left out, when the screen does not fit", async () => {
    const user = userEvent.setup();
    const long = Array.from({ length: 40 }, (_, i) => `row ${String(i)} ${"x".repeat(200)}`).join("\n");
    const { container, getByRole } = render(
      <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => long} />,
    );
    await user.click(getByRole("switch", { name: "Include the screen" }));
    await waitFor(() => expect(container.querySelector('[data-slot="report-cut"]')).toHaveTextContent("The screen was cut to fit the link. Copy report has all of it."));
    const href = container.querySelector<HTMLAnchorElement>('[data-slot="report-open"]')?.getAttribute("href") ?? "";
    expect(href.length).toBeLessThanOrEqual(6000);
  });

  it("a screen that cannot be read turns the switch back off and says why", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => Promise.reject(new Error("herdr read failed"))} />,
    );
    await user.click(getByRole("switch", { name: "Include the screen" }));
    await waitFor(() => expect(container.querySelector('[data-slot="report-screen-hint"]')).toHaveTextContent("Collie did not answer"));
    expect(getByRole("switch", { name: "Include the screen" })).toHaveAttribute("aria-checked", "false");
  });

  it("Copy report copies the whole report, nothing cut, even when the link had to cut the screen", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const long = Array.from({ length: 40 }, (_, i) => `row ${String(i)} ${"x".repeat(200)}`).join("\n");
      const { getByRole, container } = render(
        <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => long} />,
      );
      await user.click(getByRole("switch", { name: "Include the screen" }));
      await waitFor(() => expect(container.querySelector('[data-slot="report-cut"]')).not.toBeNull());
      await user.click(getByRole("button", { name: "Copy report" }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(reportText(reportFields(base({ screen: long }))));
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("from Settings it says where a pane's own report lives", () => {
    const { container } = render(<ReportSheetView context={{ ...CONTEXT, harness: null, screenable: false }} contextError={null} rows={[]} episodes={[]} fromSettings loadScreen={vi.fn()} />);
    expect(container).toHaveTextContent("To report one pane, open its menu.");
  });
});

describe("reportedSends", () => {
  it("lists the streak's own sends when the bridge still has them, else the recent ones", () => {
    expect(reportedSends(SENDS, ["sheet-00002"])).toEqual([SENDS[1]]);
    expect(reportedSends(SENDS, ["gone-000001"])).toEqual(SENDS);
    expect(reportedSends(SENDS, undefined)).toEqual(SENDS);
  });
});

describe("ReportSheet", () => {
  it("reads the setup and the pane's sends, and asks for no screen until the switch", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/report\/context/, ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json(CONTEXT);
      }),
      http.get(/\/api\/send\/receipts/, () => HttpResponse.json({ receipts: SENDS })),
    );
    const { getByText } = render(<ReportSheet target={{ paneId: "w1:p1", requestIds: ["sheet-00001", "sheet-00002"] }} onClose={() => {}} />);
    await waitFor(() => expect(document.body.querySelector('[data-slot="report-preview"]')).toHaveTextContent("id=sheet-00001"));
    const text = document.body.querySelector('[data-slot="report-preview"]')?.textContent ?? "";
    expect(text).not.toContain("id=sheet-00003");
    expect(text).toContain('"mux": "herdr"');
    expect(asked).toEqual(["?pane=w1%3Ap1"]);
    expect(getByText("Report a problem")).toBeInTheDocument();
  });
});

describe("ReportSheet from the unread-dialog card (amendment 2026-10-28, #554)", () => {
  const DIALOG = { agent: "claude", key: "Escape", verdicts: [{ name: "prompt-select", result: "null" as const }, { name: "menu", result: "found" as const }] };

  it("starts with Include the screen ON, reads the masked screen once, and lists the verdicts and the phone's facts", async () => {
    const asked: string[] = [];
    server.use(
      http.get(/\/api\/report\/context/, ({ request }) => {
        const search = new URL(request.url).search;
        asked.push(search);
        return HttpResponse.json(search.includes("screen=1") ? { ...CONTEXT, screen: "❯ 1. Yes\n  2. No\n  Esc to cancel" } : CONTEXT);
      }),
      http.get(/\/api\/send\/receipts/, () => HttpResponse.json({ receipts: SENDS })),
    );
    const { getByRole } = render(<ReportSheet target={{ paneId: "w1:p1", kind: "unread-dialog", dialog: DIALOG }} onClose={() => {}} />);
    const previewOf = () => document.body.querySelector('[data-slot="report-preview"]')?.textContent ?? "";
    await waitFor(() => expect(previewOf()).toContain("### The screen\n\n❯ 1. Yes\n  2. No\n  Esc to cancel"));
    expect(getByRole("switch", { name: "Include the screen" })).toHaveAttribute("aria-checked", "true");
    expect(asked).toEqual(["?pane=w1%3Ap1", "?pane=w1%3Ap1&screen=1"]);
    const text = previewOf();
    expect(text).toContain("Cannot read a dialog: claude 2.1.291, herdr");
    expect(text).toContain("Collie cannot read this dialog.\n    card key: Escape");
    expect(text).toContain("    prompt-select: null\n    menu: found");
    expect(text).not.toContain("id=sheet-00003");
    expect(text).toContain(`"appBuild": "${BUILD.id}"`);
    expect(text).toContain('"userAgent": ');
    expect(text).toMatch(/"viewport": "\d+x\d+"/u);
    expect(text).toContain('"standalone": "no"');
  });

  it("the person can switch the screen off before anything leaves", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <ReportSheetView context={CONTEXT} contextError={null} rows={[]} episodes={[]} fromSettings={false} loadScreen={async () => "a row"} dialog={DIALOG} />,
    );
    await waitFor(() => expect(preview(container)).toContain("### The screen\n\na row"));
    await user.click(getByRole("switch", { name: "Include the screen" }));
    expect(preview(container)).not.toContain("### The screen");
    expect(container.querySelector<HTMLAnchorElement>('[data-slot="report-open"]')?.getAttribute("href")).not.toContain("screen=");
  });
});
