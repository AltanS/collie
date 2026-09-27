import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// ── Issue 302: a rewrapped row does not strand its last word ────────────────────────────────────
//
// The wrap path of the mirror `<pre>` carries `text-pretty` (`components/ansi-output.tsx`
// `preClass`). A unit test can only see the class; this case sees the line boxes, in the shipped
// bundle, in each engine the projects run.
//
// THE ROW IS BUILT FOR THE PHONE IT RUNS ON. The mirror's face is the system monospace
// (`--font-mono`), so the column count at 390px differs between a Fedora laptop, the CI runner and
// WebKit. A fixed row would orphan on one machine and not on the next, and the case would pass
// without testing anything. So the first load measures the columns, and the second load renders a
// row whose first line nearly fills them and whose last word, `tail`, cannot fit beside it: greedy
// breaking strands `tail` alone, and pretty pulls a word down to keep it company.
//
// THE COUNTERFACTUAL IS CHECKED IN THE SAME PAGE. The case turns `text-wrap-style` back to `auto`
// on the element and asserts that `tail` IS alone, so a row that stops orphaning under greedy
// breaking fails here instead of passing for the wrong reason.
//
// WHAT THIS DOES NOT CLAIM. WebKit (26.5, Playwright's build) drops `pretty` for the whole `<pre>`
// as soon as any row in it overflows the line: a rule wider than the phone, a status line padded
// with spaces, a table run. A real screen nearly always holds one, so on an iPhone the class is
// mostly inert (`preClass` has the numbers). This screen holds prose only, on purpose: it proves the
// class reaches the element and acts, not how often Safari lets it.
test.use({ serviceWorkers: "block" });

const PANE_ID = fixtureSnapshot.agents[0]!.paneId;
const PANE_URL = `/pane/${encodeURIComponent(PANE_ID)}`;
const PANE_ROUTE = new RegExp(`/api/pane/${encodeURIComponent(PANE_ID)}(?:\\?.*)?$`);

/** A row of one repeated character, long enough to measure a cell and short enough never to wrap. */
const PROBE = "x".repeat(24);
/** The word greedy breaking strands. */
const TAIL = "tail";

/**
 * One row whose first line is `columns - 2` wide, followed by ` tail`.
 *
 * Four-letter words, the first one stretched to make the sum exact. The two spare cells are slack:
 * a line that really holds one cell more or fewer than the measure said still fits the first line
 * and still has no room for ` tail`, so greedy breaking puts `tail` alone on line two either way.
 */
function orphanRow(columns: number): string {
  const width = columns - 2;
  const words = Math.floor((width + 1) / 5);
  const first = "a".repeat(width - 5 * (words - 1));
  return [first, ...Array.from({ length: words - 1 }, () => "word"), TAIL].join(" ");
}

async function servePane(page: Page, text: () => string): Promise<void> {
  await page.route(PANE_ROUTE, (route) =>
    route.fulfill({ json: { paneId: PANE_ID, text: text(), truncated: false, revision: 1 } }),
  );
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("states"),
    "this case drives the app bundle, not the playground",
  );
  await installApiStub(page);
});

test("a rewrapped row keeps its last word company", async ({ page }) => {
  let screen = PROBE;
  await servePane(page, () => screen);

  // Load one: how many cells fit on a line of this mirror, at this viewport, in this engine.
  await page.goto(PANE_URL);
  const probe = page.getByText(PROBE, { exact: true });
  await expect(probe).toBeVisible();
  const columns = await probe.evaluate((span) => {
    const pre = span.closest("pre")!;
    const style = getComputedStyle(pre);
    const content = pre.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const range = document.createRange();
    range.selectNodeContents(span);
    const cell = range.getBoundingClientRect().width / (span.textContent ?? "").length;
    return Math.floor(content / cell + 1e-3);
  });
  expect(columns).toBeGreaterThan(20);

  // Load two: the row built for that width.
  const row = orphanRow(columns);
  screen = row;
  await page.goto(PANE_URL);
  const rowSpan = page.getByText(row, { exact: true });
  await expect(rowSpan).toBeVisible();

  const lines = await rowSpan.evaluate((span) => {
    const pre = span.closest("pre")!;
    // The row's words, grouped by the line box each one sits on.
    const read = (): string[] => {
      const node = span.firstChild;
      if (!(node instanceof Text)) throw new Error("the row renders as a single text node");
      const range = document.createRange();
      const out: { top: number; words: string[] }[] = [];
      for (const m of node.data.matchAll(/\S+/g)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const top = Math.round(range.getClientRects()[0]!.top);
        const last = out.at(-1);
        if (last && last.top === top) last.words.push(m[0]);
        else out.push({ top, words: [m[0]] });
      }
      return out.map((l) => l.words.join(" "));
    };
    const pretty = { style: getComputedStyle(pre).getPropertyValue("text-wrap-style"), lines: read() };
    pre.style.setProperty("text-wrap-style", "auto");
    const greedy = { style: getComputedStyle(pre).getPropertyValue("text-wrap-style"), lines: read() };
    pre.style.removeProperty("text-wrap-style");
    return { pretty, greedy };
  });

  // The counterfactual: greedy breaking strands the tail, so this row is a real orphan case here.
  expect(lines.greedy.style).toBe("auto");
  expect(lines.greedy.lines).toHaveLength(2);
  expect(lines.greedy.lines.at(-1)).toBe(TAIL);

  // The fix: same number of lines, and the tail shares its line with the word before it.
  expect(lines.pretty.lines).toHaveLength(2);
  expect(lines.pretty.lines.at(-1)).not.toBe(TAIL);
  expect(lines.pretty.lines.at(-1)!.endsWith(` ${TAIL}`)).toBe(true);
  expect(lines.pretty.style).toBe("pretty");

  // Line breaking only: the text a copy or a find reads is the row as the agent printed it.
  await expect(rowSpan).toHaveText(row);
});
