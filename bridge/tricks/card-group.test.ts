import { describe, expect, test } from "bun:test";

import { parseJson } from "../../web/src/lib/json.ts";
import { DECISION_VIEW_LIMITS, DIFF_LIMITS, parseDecisionView, type View, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import {
  addedDiff,
  codeGroup,
  GROUP_CARD_CODE_BYTES,
  GROUP_CODE_BYTES,
  GROUP_CODE_CARDS,
  GROUP_MASKED,
  GROUP_MASKED_NOTE,
  GROUP_NOT_TEXT,
  GROUP_SEAM_LAST,
  GROUP_SEAM_NEXT,
  GROUP_TOO_LARGE,
  GROUP_WRAP,
  groupOrder,
  wrapRow,
} from "./card-group.ts";

// A GROUP OF CARDS (crew slice 8): the code cards show every line, in a fixed order, within the view cap.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Every diff row on the cards, in order, with the file each sits in. */
function rowsOf(cards: readonly View[]): { file: string; row: string }[] {
  return cards.flatMap((card) => card.flatMap((node: ViewNode) => (node.kind === "diff" && "text" in node && node.text !== undefined ? node.text.split("\n").map((row) => ({ file: String(node.attrs?.file ?? ""), row })) : [])));
}

/** A file of `lines` numbered lines, each `width` characters. */
function lines(count: number, width = 60): string {
  return Array.from({ length: count }, (_, i) => `${String(i).padStart(5, "0")} ${"x".repeat(width)}`).join("\n") + "\n";
}

describe("the order of the files", () => {
  test("trick.toml first, then the run file, then by path in byte order", () => {
    const files = ["b.ts", "Z.ts", "trick.toml", "a/x.ts", "run.sh"].map((rel) => ({ rel }));
    expect(groupOrder(files, "./run.sh --fast").map((file) => file.rel)).toEqual(["trick.toml", "run.sh", "Z.ts", "a/x.ts", "b.ts"]);
    expect(groupOrder(files, "bun b.ts").map((file) => file.rel)).toEqual(["trick.toml", "b.ts", "Z.ts", "a/x.ts", "run.sh"]);
  });
});

describe("every line on a card", () => {
  test("three files over three cards: every row once, in order, a seam where a file goes on, each card within the cap", () => {
    const files = [
      { rel: "trick.toml", bytes: enc('id = "legs"\nrun = "./legs.sh"\n') },
      { rel: "legs.sh", bytes: enc(lines(120)) },
      { rel: "lib/util.ts", bytes: enc(lines(40)) },
    ];
    const diff = addedDiff(files);
    const group = codeGroup(diff.files, "./legs.sh", "refuse");
    if (!group.ok) throw new Error(group.error);
    expect(group.cards.length).toBeGreaterThanOrEqual(2);
    // Every row of every file, in the group's order, nothing dropped or doubled.
    const want = diff.files.flatMap((file) => (file.hunk ?? []).map((row) => ({ file: file.rel, row })));
    expect(rowsOf(group.cards)).toEqual(want);
    for (const [i, card] of group.cards.entries()) {
      expect(new TextEncoder().encode(JSON.stringify(card)).byteLength).toBeLessThanOrEqual(DECISION_VIEW_LIMITS.bytes);
      expect(parseDecisionView(parseJson(JSON.stringify(card))).refusals).toEqual([]);
      const text = JSON.stringify(card);
      // A card that ends inside a file says so, and the next one says where it came from.
      if (text.includes(GROUP_SEAM_NEXT)) expect(JSON.stringify(group.cards[i + 1])).toContain(GROUP_SEAM_LAST);
    }
    expect(JSON.stringify(group.cards)).toContain(GROUP_SEAM_NEXT);
    expect(group.places.get("trick.toml")).toEqual({ first: 2, last: 2 });
    expect(group.places.get("legs.sh")?.last).toBeGreaterThan(2);
  });

  test("a line longer than a row goes on in the rows after it, each marked, and no character is lost", () => {
    const long = `+${"a".repeat(450)}`;
    const rows = wrapRow(long);
    expect(rows.length).toBe(3);
    expect(rows.every((row) => [...row].length <= DIFF_LIMITS.lineChars)).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith(`+${GROUP_WRAP}`))).toBe(true);
    expect(rows[0]! + rows.slice(1).map((row) => row.slice(2)).join("")).toBe(long);
  });
});

describe("what a group cannot show", () => {
  test("more than seven cards of code is too large", () => {
    expect(GROUP_CODE_CARDS).toBe(7);
    expect(GROUP_CODE_BYTES).toBe(7 * GROUP_CARD_CODE_BYTES);
    const diff = addedDiff([{ rel: "big.ts", bytes: enc(lines(800)) }]);
    expect(codeGroup(diff.files, null, "refuse")).toEqual({ ok: false, code: "too_large", error: GROUP_TOO_LARGE });
  });

  test("a masked line refuses a proposal; a version made by hand shows it masked, and its card says so", () => {
    const diff = addedDiff([{ rel: "key.ts", bytes: enc(`const KEY = "sk-or-v1-your-key-here-placeholder00";\n${lines(150)}`) }]);
    expect(diff.files[0]?.cut).toBe(true);
    expect(codeGroup(diff.files, null, "refuse")).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
    const shown = codeGroup(diff.files, null, "show");
    if (!shown.ok) throw new Error(shown.error);
    expect(JSON.stringify(shown.cards[0])).toContain(GROUP_MASKED_NOTE);
    expect(JSON.stringify(shown.cards)).not.toContain("your-key-here-placeholder00");
  });

  test("a file that is not UTF-8 text cannot show", () => {
    const diff = addedDiff([{ rel: "a.bin", bytes: new Uint8Array([0xff, 0xfe, 0x00]) }]);
    expect(codeGroup(diff.files, null, "refuse")).toEqual({ ok: false, code: "cannot_show", error: GROUP_NOT_TEXT });
  });
});
