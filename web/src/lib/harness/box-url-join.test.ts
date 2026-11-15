import { describe, expect, it } from "vitest";

import { joinBrokenUrls } from "./box-url-join";

const CODE_URL = "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH";

const rowsOf = (width: number, ...texts: string[]): string[] => texts.map((text) => text.padEnd(width));

describe("joining a URL the box broke at its right edge", () => {
  it("joins a URL broken inside the device code to its continuation, adding and removing no character", () => {
    const rows = rowsOf(57, "https://example.awsapps.com/start/#/device?user_code=ABCD", "-EFGH >>> One-tap login URL");
    expect(rows[0]).toHaveLength(57);
    expect(joinBrokenUrls(rows, 57)).toEqual([rows[0]! + rows[1]!]);
  });

  it("joins a URL broken inside the host", () => {
    const rows = rowsOf(57, `code pre-filled: ${"".padEnd(30)}https://ex`, "ample.awsapps.com/start/#/device?user_code=ABCD-EFGH");
    expect(rows[0]).toHaveLength(57);
    expect(joinBrokenUrls(rows, 57)).toEqual([rows[0]! + rows[1]!]);
  });

  it("joins a URL broken before the last character of the device code", () => {
    const rows = rowsOf(55, "https://example.awsapps.com/start/#/device?user_code=AB", "CD-EFGH Alternatively");
    expect(rows[0]).toHaveLength(55);
    expect(joinBrokenUrls(rows, 55)).toEqual([rows[0]! + rows[1]!]);
  });

  it("joins a URL spread over three rows into one line", () => {
    const rows = rowsOf(25, "https://example.awsapps.c", "om/start/#/device?user_co", "de=ABCD-EFGH");
    expect(joinBrokenUrls(rows, 25)).toEqual([rows.join("")]);
    expect(rows.join("").trimEnd()).toBe(CODE_URL);
  });

  it("counts the URL's length from the row it starts on, not from the row it was last joined on", () => {
    const rows = rowsOf(36, "https://example.awsapps.com/start/#/", "device/", "abcdefghij");
    expect(rows[0]).toHaveLength(36);
    expect(joinBrokenUrls(rows, 36)).toEqual([rows[0]! + "device/" + rows[2]!]);
    expect(joinBrokenUrls(rows, 36)[0]!.trimEnd()).toBe("https://example.awsapps.com/start/#/device/abcdefghij");
  });

  it("joins a row that continues one URL and starts the next, and the row after it as well", () => {
    const rows = rowsOf(
      57,
      "https://example.awsapps.com/start/#/device?user_code=ABCD",
      "-EFGH >>> One-tap login URL (code pre-filled): https://ex",
      "ample.awsapps.com/start/#/device?user_code=ABCD-EFGH",
    );
    expect(joinBrokenUrls(rows, 57)).toEqual([rows.join("")]);
  });

  it("joins the first break and keeps the row break after a URL that ends on its row", () => {
    const rows = rowsOf(
      57,
      "https://example.awsapps.com/start/#/device?user_code=ABCD",
      "-EFGH >>> then open",
      "the docs",
    );
    expect(joinBrokenUrls(rows, 57)).toEqual([rows[0]! + rows[1]!, rows[2]]);
  });

  it("joins a break in the path and in the query alike, whatever the continuation looks like", () => {
    const path = rowsOf(31, "see https://example.awsapps.com", "/start/#/device?user_code=AB");
    expect(path[0]).toHaveLength(31);
    expect(joinBrokenUrls(path, 31)).toEqual([path[0]! + path[1]!]);
    const query = rowsOf(30, "see https://example.com/a?bcd=", "efghijklmnopqrstuvwx");
    expect(query[0]).toHaveLength(30);
    expect(joinBrokenUrls(query, 30)).toEqual([query[0]! + query[1]!]);
  });

  it("joins a URL whose scheme is upper or mixed case exactly as it joins a lower-case one", () => {
    const upper = rowsOf(57, "HTTPS://example.awsapps.com/start/#/device?user_code=ABCD", "-EFGH >>> One-tap login URL");
    expect(upper[0]).toHaveLength(57);
    expect(joinBrokenUrls(upper, 57)).toEqual([upper[0]! + upper[1]!]);
    const mixed = rowsOf(57, "Https://example.awsapps.com/start/#/device?user_code=ABCD", "-EFGH >>> One-tap login URL");
    expect(joinBrokenUrls(mixed, 57)).toEqual([mixed[0]! + mixed[1]!]);
    const shortOfEdge = rowsOf(36, "see HTTP://example.awsapps.com/ab/", "cdefghijklmnopqrstu");
    expect(joinBrokenUrls(shortOfEdge, 36)).toEqual([shortOfEdge[0]!.trimEnd() + shortOfEdge[1]!]);
  });

  it("joins a URL the box broke right after a slash one column short of the edge, dropping the unused column", () => {
    const rows = rowsOf(48, "code upon loading: https://example.awsapps.com/", "start/#/device?user_code=ABCD-EFGH >>> One-tap");
    expect(rows[0]!.trimEnd()).toHaveLength(47);
    expect(joinBrokenUrls(rows, 48)).toEqual([rows[0]!.trimEnd() + rows[1]!]);
  });

  it("joins a URL the box broke before a slash that starts the next row, one column short of the edge", () => {
    const rows = rowsOf(36, "https://example.awsapps.com/start/#", "/device?user_code=ABCD-EFGH See");
    expect(rows[0]!.trimEnd()).toHaveLength(35);
    expect(joinBrokenUrls(rows, 36)).toEqual([rows[0]!.trimEnd() + rows[1]!]);
  });

  it("joins a slash-adjacent break that stops several columns short of the edge", () => {
    const rows = rowsOf(36, "see https://example.awsapps.com/ab/", "cdefghijklmnopqrstu");
    expect(rows[0]!.trimEnd()).toHaveLength(35);
    expect(joinBrokenUrls(rows, 36)).toEqual([rows[0]!.trimEnd() + rows[1]!]);
    const shorter = rowsOf(36, "https://example.awsapps.com/start/", "device?user_code=ABCD-EFGH");
    expect(shorter[0]!.trimEnd()).toHaveLength(34);
    expect(joinBrokenUrls(shorter, 36)).toEqual([shorter[0]!.trimEnd() + shorter[1]!]);
  });
});

describe("keeping the row break where the box ended the line itself", () => {
  it("does not join a URL that ends before the last column with other words after it", () => {
    const rows = rowsOf(57, "https://example.awsapps.com/start/#/device Then enter the", "code: ABCD-EFGH");
    expect(joinBrokenUrls(rows, 57)).toEqual(rows);
  });

  it("does not join a short URL that ends on the last column when it plus the next word fits the width", () => {
    const rows = rowsOf(57, "Open the page: https://example.awsapps.com/start/#/device", "Then enter the code: ABCD-EFGH");
    expect(rows[0]!.trimEnd()).toHaveLength(57);
    expect(joinBrokenUrls(rows, 57)).toEqual(rows);
  });

  it("joins when the URL plus the next word is one column over the width, and not when it is exactly the width", () => {
    const over = rowsOf(20, "go https://example.c", "mmmm");
    expect(over[0]).toHaveLength(20);
    expect(joinBrokenUrls(over, 20)).toEqual([over.join("")]);
    const exact = rowsOf(20, "go https://example.c", "mmm");
    expect(joinBrokenUrls(exact, 20)).toEqual(exact);
  });

  it("does not join a long word that is not an address, even when it fills the row", () => {
    const rows = rowsOf(20, "abcdefghijklmnopqrst", "uvwxyz and more");
    expect(joinBrokenUrls(rows, 20)).toEqual(rows);
  });

  it("does not join a row of plain prose that ends on the last column", () => {
    const rows = rowsOf(57, "Alternatively, you may visit the following page, then the", "code: ABCD-EFGH");
    expect(rows[0]!.trimEnd()).toHaveLength(57);
    expect(joinBrokenUrls(rows, 57)).toEqual(rows);
  });

  it("does not join a blank row onto a URL that ends on the last column", () => {
    const rows = rowsOf(25, "https://example.awsapps.c", "om/start/#/device?user_co", "", "next");
    expect(joinBrokenUrls(rows, 25)).toEqual([rows[0]! + rows[1]!, rows[2], rows[3]]);
  });

  it("keeps the row break of text the box split outside a URL, a device code standing alone included", () => {
    const rows = rowsOf(57, "Then enter the code:", "ABCD-EFGH", "", "Alternatively, you may visit");
    expect(joinBrokenUrls(rows, 57)).toEqual(rows);
  });

  it("returns the rows unchanged when no row holds an address", () => {
    const rows = rowsOf(30, "", "Another process is running", "your command.");
    expect(joinBrokenUrls(rows, 30)).toEqual(rows);
    expect(joinBrokenUrls([], 30)).toEqual([]);
  });

  it("does not join a URL that ends short of the edge with no slash on either side of the break, whatever the length", () => {
    const rows = rowsOf(36, "https://example.awsapps.com/start/x", "device?user_code=ABCD-EFGH See");
    expect(rows[0]!.trimEnd()).toHaveLength(35);
    expect(joinBrokenUrls(rows, 36)).toEqual(rows);
  });

  it("does not join a slash-adjacent break when the URL plus the next word fits the width, the row's unused columns not counted", () => {
    const afterSlash = rowsOf(36, "Open: https://example.com/start/", "pending now");
    expect(joinBrokenUrls(afterSlash, 36)).toEqual(afterSlash);
    const beforeSlash = rowsOf(36, "Open: https://example.com/start", "/device ok");
    expect(joinBrokenUrls(beforeSlash, 36)).toEqual(beforeSlash);
  });

  it("does not join a row that ends on a slash when its last word is not an address", () => {
    const rows = rowsOf(36, "the files live under src/lib/utils/", "helpers/formatting/dates/today.ts");
    expect(joinBrokenUrls(rows, 36)).toEqual(rows);
  });
});

// The bridge send gate runs this grammar on whatever the box shows, so a staircase of rows that each join the
// one before must not stall the event loop. The 200 ms ceiling sits well over a linear run and under the
// seconds the per-word rescans took at this size.
describe("a box built to join on every row stays fast", () => {
  it("joins a 250-row staircase of 600-column rows into one line in under 200 ms", () => {
    const width = 600;
    const height = 250;
    const rows = ["https://" + "a".repeat(width - 8)];
    for (let k = 1; k < height; k++) {
      const filler = 2 * k + 1;
      rows.push("b".repeat(filler) + " https://" + "a".repeat(width - filler - 9));
    }
    const start = performance.now();
    const joined = joinBrokenUrls(rows, width);
    const elapsed = performance.now() - start;
    expect(joined).toEqual([rows.join("")]);
    expect(elapsed).toBeLessThan(200);
  });
});
