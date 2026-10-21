import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MarkdownText } from "@/components/markdown-text";
import { WalkyLogProvider, WalkyOpenProvider } from "@/components/walky-log";
import { fixtureWalkyAgent, fixtureWalkyOperator } from "@/test/handlers";
import { WALKY_LIST_LIMIT, type WalkyRow } from "@/lib/walky";

import { WalkyIdChip, WalkyIds } from "./walky-id-chip";

// A message id in text is a chip that opens the Messages sheet, only where the pane's log holds it
// (M62). The text is the agent's; the log is the fact.

const ID = fixtureWalkyAgent.id;
const OTHER = "wt_zzzzzzzzzzzz";

function prose(text: string, rows: readonly WalkyRow[] | null | "none" = [fixtureWalkyAgent], open: ((id: string) => void) | null = vi.fn()) {
  const view = <MarkdownText text={text} />;
  return render(
    rows === "none" ? (
      view
    ) : (
      <WalkyLogProvider rows={rows}>
        <WalkyOpenProvider open={open}>{view}</WalkyOpenProvider>
      </WalkyLogProvider>
    ),
  );
}

const chips = () => [...document.querySelectorAll<HTMLElement>('[data-slot="walky-id-chip"]')];

describe("an id in agent prose", () => {
  it("is a chip when the log holds it, and the words around it are untouched", () => {
    const { container } = prose(`I replied to ${ID} just now.`);
    expect(chips().map((c) => c.textContent)).toEqual([ID]);
    expect(container.textContent).toBe(`I replied to ${ID} just now.`);
  });

  it("opens the sheet on that id when tapped", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    prose(`See ${ID}.`, [fixtureWalkyAgent], open);
    await user.click(screen.getByRole("button", { name: `Open message ${ID}` }));
    expect(open).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("stays plain text for an id the log lacks, whether the list was read whole, cut or not read", () => {
    prose(`gone ${OTHER}`);
    expect(chips()).toHaveLength(0);
    const full: WalkyRow[] = Array.from({ length: WALKY_LIST_LIMIT }, (_, i) => ({ ...fixtureWalkyOperator, id: `wt_${String(i).padStart(12, "0")}` }));
    prose(`cut ${OTHER}`, full);
    expect(chips()).toHaveLength(0);
    prose(`unread ${ID}`, null);
    expect(chips()).toHaveLength(0);
  });

  it("stays plain text where there is no Messages sheet to open, and with no provider", () => {
    prose(`no sheet ${ID}`, [fixtureWalkyAgent], null);
    expect(chips()).toHaveLength(0);
    prose(`no provider ${ID}`, "none");
    expect(chips()).toHaveLength(0);
    expect(screen.getByText(`no provider ${ID}`)).toBeInTheDocument();
  });

  it("chips two ids in one line and leaves a third the log lacks", () => {
    prose(`${ID} then ${fixtureWalkyOperator.id} then ${OTHER}`, [fixtureWalkyAgent, fixtureWalkyOperator]);
    expect(chips().map((c) => c.textContent)).toEqual([ID, fixtureWalkyOperator.id]);
  });

  it("does not chip an id inside a longer word or a longer id", () => {
    prose(`x${ID} ${ID}9 ${ID}_`);
    expect(chips()).toHaveLength(0);
  });

  it("does not put a button inside a link", () => {
    prose(`[the log for ${ID}](https://example.com/log)`);
    expect(chips()).toHaveLength(0);
    expect(screen.getByRole("link")).toHaveTextContent(ID);
  });

  it("turns a code span that is only a held id into the chip, and keeps any other code span as code", () => {
    prose(`run \`${ID}\` or \`collie walky inbox ${ID}\``);
    expect(chips().map((c) => c.textContent)).toEqual([ID]);
    expect(document.querySelectorAll("code")).toHaveLength(1);
    expect(document.querySelector("code")).toHaveTextContent(`collie walky inbox ${ID}`);
  });

  it("keeps a code span with an id the log lacks as code", () => {
    prose(`\`${OTHER}\``);
    expect(chips()).toHaveLength(0);
    expect(document.querySelector("code")).toHaveTextContent(OTHER);
  });
});

describe("WalkyIdChip", () => {
  it("is a button, mono, with a hit area taller than its drawn box and a name that says the act", () => {
    render(<WalkyIdChip id={ID} onOpen={vi.fn()} />);
    const chip = screen.getByRole("button", { name: `Open message ${ID}` });
    expect(chip).toHaveAttribute("type", "button");
    expect(chip.className).toContain("font-mono");
    expect(chip.className).toContain("before:-inset-y-3");
    expect(chip.className).toContain("whitespace-nowrap");
    expect(chip.className).not.toMatch(/(^|\s)dark:/);
  });

  it("takes the mirror's own colours on the dark ground, with no token", () => {
    render(<WalkyIdChip id={ID} onOpen={vi.fn()} onDark />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("border-white/20");
    expect(cls).not.toContain("text-muted-foreground");
  });
});

describe("WalkyIds", () => {
  it("returns the text as it came when no chip can be drawn", () => {
    const { container } = render(<WalkyIds text={`plain ${ID}`} />);
    expect(container.textContent).toBe(`plain ${ID}`);
    expect(chips()).toHaveLength(0);
  });
});
