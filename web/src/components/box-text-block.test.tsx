import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BoxTextBlock } from "@/components/box-text-block";
import type { BoxTextModel } from "@/lib/blocks";

const DEVICE = "https://example.awsapps.com/start/#/device";
const CODED = "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH";

const link = (address: string) => ({ kind: "link", text: address, href: address }) as const;
const plain = (text: string) => ({ kind: "plain", text }) as const;

const FILLED: BoxTextModel = {
  title: "Authentication",
  phase: "filled",
  text: [
    [],
    [plain("Browser will not be automatically opened. Please visit")],
    [link(DEVICE), plain(" Then enter the")],
    [plain("code: ABCD-EFGH Alternatively, you may visit the")],
    [plain("login URL: "), link(CODED)],
  ],
};

const NO_URL: BoxTextModel = {
  title: "Authentication",
  phase: "filled",
  text: [[], [plain("Another Claude Code process is running your awsAuthRefresh command.")]],
};

const WAITING: BoxTextModel = { title: "Authentication", phase: "waiting", text: [] };

describe("BoxTextBlock", () => {
  it("is a group named Login output, headed by the box's printed title", () => {
    render(<BoxTextBlock boxText={FILLED} />);
    const card = screen.getByRole("group", { name: "Login output" });
    expect(within(card).getByText("Authentication")).toBeInTheDocument();
  });

  it("shows the text rows in the box's order, after the heading", () => {
    render(<BoxTextBlock boxText={FILLED} />);
    const shown = screen.getByRole("group", { name: "Login output" }).textContent ?? "";
    const order = [
      "Authentication",
      "Browser will not be automatically opened. Please visit",
      `${DEVICE} Then enter the`,
      "code: ABCD-EFGH Alternatively, you may visit the",
      `login URL: ${CODED}`,
    ].map((row) => shown.indexOf(row));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it("renders each address as a link that opens in a new tab and carries its exact href", () => {
    render(<BoxTextBlock boxText={FILLED} />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([DEVICE, CODED]);
    for (const a of links) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toMatch(/noopener/u);
    }
    expect(screen.getByRole("link", { name: CODED })).toBeInTheDocument();
  });

  it("takes keyboard focus on the links in reading order and activates the focused link on Enter", async () => {
    const user = userEvent.setup();
    render(<BoxTextBlock boxText={FILLED} />);
    const [first, second] = screen.getAllByRole("link");
    const opened: (string | null)[] = [];
    for (const a of [first!, second!]) {
      a.addEventListener("click", (event) => {
        event.preventDefault();
        opened.push(a.getAttribute("href"));
      });
    }
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(opened).toEqual([CODED]);
  });

  it("draws no button and gives no link a disabled state", () => {
    render(<BoxTextBlock boxText={FILLED} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
    for (const a of screen.getAllByRole("link")) {
      expect(a).not.toHaveAttribute("aria-disabled");
      expect(a).not.toHaveAttribute("disabled");
    }
  });

  it("shows the text of a box that holds no address, with no link", () => {
    render(<BoxTextBlock boxText={NO_URL} />);
    expect(screen.getByText("Another Claude Code process is running your awsAuthRefresh command.")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("puts every other character in a text node: markup and script addresses in the text stay literal", () => {
    const hostile: BoxTextModel = {
      title: "Authentication",
      phase: "filled",
      text: [[plain('<img src=x onerror="alert(1)"> <b>bold</b> javascript:alert(1)')]],
    };
    const { container } = render(<BoxTextBlock boxText={hostile} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByText(/<b>bold<\/b> javascript:alert\(1\)/u)).toBeInTheDocument();
  });

  it("shows the box's printed title and the waiting line, with no link and no button, before the command prints", () => {
    render(<BoxTextBlock boxText={WAITING} />);
    const card = screen.getByRole("group", { name: "Login output" });
    expect(within(card).getByText("Authentication")).toBeInTheDocument();
    expect(within(card).getByText("The login command has not printed anything yet.")).toBeInTheDocument();
    expect(within(card).queryAllByRole("link")).toEqual([]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
  });

  it("shows the title as the box printed it, not a translated word", () => {
    render(<BoxTextBlock boxText={{ ...WAITING, title: "Authentifizierung" }} />);
    const card = screen.getByRole("group", { name: "Login output" });
    expect(within(card).getByText("Authentifizierung")).toBeInTheDocument();
  });

  it("shows no waiting line once the box holds text", () => {
    render(<BoxTextBlock boxText={NO_URL} />);
    expect(screen.queryByText("The login command has not printed anything yet.")).toBeNull();
  });

  it("speaks the phone's language in the waiting line and redraws it when the language changes, with no refresh of the pane", async () => {
    vi.resetModules();
    const [{ BoxTextBlock: FreshBlock }, { __resetLocale, setLocale, whenLocaleReady }, { de }, { en }] = await Promise.all([
      import("@/components/box-text-block"),
      import("@/lib/i18n"),
      import("@/lib/i18n/messages/de"),
      import("@/lib/i18n/messages/en"),
    ]);
    const key = "dialog.authBox.waiting";
    const catalog = (messages: Readonly<Record<string, string | undefined>>): string | undefined => messages[key];
    __resetLocale();
    try {
      render(<FreshBlock boxText={WAITING} />);
      expect(screen.getByText("The login command has not printed anything yet.")).toBeInTheDocument();
      await act(async () => {
        setLocale("de");
        await whenLocaleReady("de");
      });
      expect(catalog(en)).toBe("The login command has not printed anything yet.");
      expect(catalog(de)).toEqual(expect.any(String));
      expect(catalog(de)).not.toBe(catalog(en));
      expect(screen.getByText(catalog(de)!)).toBeInTheDocument();
      expect(screen.queryByText(catalog(en)!)).toBeNull();
      expect(screen.getByText("Authentication")).toBeInTheDocument();
    } finally {
      __resetLocale();
    }
  });
});
