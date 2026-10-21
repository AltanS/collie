import { render } from "@testing-library/react";

import { AnsiOutput } from "@/components/ansi-output";
import { WalkyLogProvider } from "@/components/walky-log";
import { fixtureWalkyAgent } from "@/test/handlers";
import type { WalkyRow } from "@/lib/walky";

// The mirror's walky row style (M62 spec 05): a row-level tag on the envelope's header line, never a
// Block kind and never a harness grammar. It earns the style only when the pane's log holds the id.

const HEADER = "[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, collie-workspace#fix-465)";
const SCREEN = ["some earlier output", `❯ ${HEADER}`, "Tests are green on fix-465. You can merge.", "next row"].join("\n");

function mirror(rows: readonly WalkyRow[] | null | "none", text = SCREEN) {
  const view = <AnsiOutput text={text} />;
  return render(rows === "none" ? view : <WalkyLogProvider rows={rows}>{view}</WalkyLogProvider>);
}

function tagged(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="walky-row"]')];
}

describe("the mirror's walky row", () => {
  it("tags the header row, and only that row, when the log holds its id", () => {
    const { container } = mirror([fixtureWalkyAgent]);
    const rows = tagged(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(`❯ ${HEADER}`);
  });

  it("changes no text: the pre reads the same with and without the tag", () => {
    const plain = mirror("none");
    const before = plain.container.querySelector("pre")?.textContent;
    plain.unmount();
    const { container } = mirror([fixtureWalkyAgent]);
    expect(container.querySelector("pre")?.textContent).toBe(before);
  });

  it("takes no room: no border, padding, margin or dark: variant on the tag", () => {
    const { container } = mirror([fixtureWalkyAgent]);
    const cls = tagged(container)[0]?.className ?? "";
    expect(cls).toMatch(/shadow-\[/);
    expect(cls).not.toMatch(/(^|\s)(border|p[xytrbl]?-|m[xytrbl]?-|dark:)/);
  });

  it("tags nothing for an id the log does not hold", () => {
    const { container } = mirror([{ ...fixtureWalkyAgent, id: "wt_zzzzzzzzzzzz" }]);
    expect(tagged(container)).toHaveLength(0);
  });

  it("tags nothing against an empty list, an unread list, or no provider", () => {
    expect(tagged(mirror([]).container)).toHaveLength(0);
    expect(tagged(mirror(null).container)).toHaveLength(0);
    expect(tagged(mirror("none").container)).toHaveLength(0);
  });

  it("tags an indented header row whose id the log holds, and a row of prose that prints the same id", () => {
    const text = `The header looks like ${HEADER} in the log\n  ${HEADER}\nno id on this row`;
    const { container } = mirror([fixtureWalkyAgent], text);
    // The rule is the id: any row that prints an id the log holds is tagged, whatever else is on it.
    expect(tagged(container).map((el) => el.textContent)).toEqual([`The header looks like ${HEADER} in the log`, `  ${HEADER}`]);
  });

  it("tags the agent's own send output, one row for each id the log holds", () => {
    const text = ["$ collie walky send bluefin/w1:p1 hi", "wt_k3f9x2m8q1a0", "to bluefin/w1:p1, claude, repo#x", "typed into the pane"].join("\n");
    const { container } = mirror([fixtureWalkyAgent], text);
    expect(tagged(container).map((el) => el.textContent)).toEqual(["wt_k3f9x2m8q1a0"]);
  });

  it("tags no row whose id the log lacks, even when it is printed like a send's output", () => {
    const { container } = mirror([fixtureWalkyAgent], "wt_zzzzzzzzzzzz\nwt_k3f9x2m8q1a0b");
    expect(tagged(container)).toHaveLength(0);
  });
});
