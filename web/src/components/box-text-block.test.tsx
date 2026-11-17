import { act, render, screen, waitFor, within } from "@testing-library/react";
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

describe("BoxTextBlock — a sign-in card (Change login, M101)", () => {
  const ADDRESS = "https://claude.com/cai/oauth/authorize?code=true&state=XXXX";
  const SIGN_IN: BoxTextModel = {
    title: "Login",
    phase: "filled",
    text: [[plain("Browser didn't open? Use the url below to sign in (c to copy)")], [], [link(ADDRESS)], [], [plain("Paste code here if prompted >")]],
  };
  const HOSTS = ["claude.com", "platform.claude.com"];

  it("opens a listed https address through one primary button, a plain link with no opener and no referrer", () => {
    render(<BoxTextBlock boxText={SIGN_IN} signInHosts={HOSTS} />);
    const open = screen.getByRole("link", { name: "Open sign-in page" });
    expect(open).toHaveAttribute("href", ADDRESS);
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(open).toHaveAttribute("target", "_blank");
    // The address in the rows is text now: the button is the one way to open it.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
  });

  it("an address on a host the adapter does not list is text to copy, shown once, with no link", () => {
    const other: BoxTextModel = { ...SIGN_IN, text: [[link("https://example.com/oauth?state=X")]] };
    render(<BoxTextBlock boxText={other} signInHosts={HOSTS} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Copy this address into your browser if you trust it.")).toBeInTheDocument();
    expect(screen.getAllByText("https://example.com/oauth?state=X")).toHaveLength(1);
  });

  it("without hosts the card is drawn as before, its links live", () => {
    render(<BoxTextBlock boxText={SIGN_IN} />);
    expect(screen.queryByRole("link", { name: "Open sign-in page" })).toBeNull();
    expect(screen.getByRole("link", { name: ADDRESS })).toHaveAttribute("href", ADDRESS);
  });
});

// CALM LOAD (row 18): the hosts come from a read that ends after the card's first frame. While it is in
// flight the button's row is held open at the button's height with nothing live in it; the read then fills
// it or closes it with `Collapse`.
describe("BoxTextBlock, a sign-in card while its hosts are read", () => {
  const ADDRESS = "https://claude.com/cai/oauth/authorize?code=true&state=XXXX";
  const SIGN_IN: BoxTextModel = {
    title: "Login",
    phase: "filled",
    text: [[plain("Use the url below to sign in")], [link(ADDRESS)], [plain("Paste code here if prompted >")]],
  };
  const HOSTS = ["claude.com"];
  const reserved = () => document.querySelector('[data-slot="sign-in-pending"]');
  const opener = () => screen.queryByRole("link", { name: "Open sign-in page" });

  it("holds the button's row on the first frame, with no live button in it, and the read fills it", () => {
    const { rerender } = render(<BoxTextBlock boxText={SIGN_IN} signInPending />);
    const held = reserved();
    expect(held).not.toBeNull();
    expect(held).toHaveClass("h-11", "w-full");
    expect(held).toHaveAttribute("aria-hidden", "true");
    expect(opener()).toBeNull();
    // The box was open on the first frame, so it is part of it and nothing eased in.
    expect(document.querySelector('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");

    rerender(<BoxTextBlock boxText={SIGN_IN} signInHosts={HOSTS} />);
    expect(opener()).toHaveAttribute("href", ADDRESS);
    expect(opener()).toHaveAttribute("rel", "noopener noreferrer");
    expect(reserved()).toBeNull();
    expect(document.querySelectorAll('[data-slot="collapse"]')).toHaveLength(1);
  });

  it("a read that lists no host closes the held row, and the card is as before", async () => {
    const { rerender } = render(<BoxTextBlock boxText={SIGN_IN} signInPending />);
    expect(reserved()).not.toBeNull();
    rerender(<BoxTextBlock boxText={SIGN_IN} />);
    await waitFor(() => expect(reserved()).toBeNull());
    expect(opener()).toBeNull();
    expect(screen.getByRole("link", { name: ADDRESS })).toHaveAttribute("href", ADDRESS);
  });

  it("a read that lists the host but not this address still fills the row with the copy block", () => {
    const { rerender } = render(<BoxTextBlock boxText={SIGN_IN} signInPending />);
    rerender(<BoxTextBlock boxText={SIGN_IN} signInHosts={["example.org"]} />);
    expect(reserved()).toBeNull();
    expect(opener()).toBeNull();
    expect(screen.getByText("Copy this address into your browser if you trust it.")).toBeInTheDocument();
  });

  it("holds nothing while the card is not waiting on that read, and draws no extra box", () => {
    render(<BoxTextBlock boxText={SIGN_IN} />);
    expect(reserved()).toBeNull();
    expect(document.querySelector('[data-slot="collapse"]')).toBeNull();
  });

  it("with the hosts already known on the first frame the button is there at once, not eased in", () => {
    render(<BoxTextBlock boxText={SIGN_IN} signInHosts={HOSTS} />);
    expect(opener()).toHaveAttribute("href", ADDRESS);
    expect(document.querySelector('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
  });
});
