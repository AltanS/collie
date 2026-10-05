import { __resetLocale, setLocale } from "@/lib/i18n";

import { formatBytes, formatLoad, formatBytesOf, formatBytesPerSecond, formatPercent, niceCeiling } from "./machine-units";

beforeEach(() => {
  __resetLocale();
});

describe("formatPercent", () => {
  it("rounds a fraction to a whole percent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.234)).toBe("23%");
    expect(formatPercent(0.996)).toBe("100%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("clamps a value outside 0..1 and never prints NaN", () => {
    expect(formatPercent(4)).toBe("100%");
    expect(formatPercent(-0.2)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("0%");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0%");
  });
});

describe("formatBytes", () => {
  it("picks the unit whose value is at least one", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(7.9 * 1024 ** 3)).toBe("7.9 GB");
    expect(formatBytes(16 * 1024 ** 3)).toBe("16 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3 TB");
  });

  it("stops at TB instead of inventing a unit", () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2,048 TB");
  });

  it("never prints a negative or a non-finite value", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatBytesPerSecond", () => {
  it("adds the per-second suffix to the same unit ladder", () => {
    expect(formatBytesPerSecond(0)).toBe("0 B/s");
    expect(formatBytesPerSecond(1.5 * 1024 ** 2)).toBe("1.5 MB/s");
    expect(formatBytesPerSecond(40 * 1024)).toBe("40 KB/s");
  });
});

describe("formatBytesOf", () => {
  it("prints used and total in the total's unit", () => {
    expect(formatBytesOf(7.4 * 1024 ** 3, 16 * 1024 ** 3)).toBe("7.4 / 16 GB");
    // Under one unit of the total: still GB, not "812 MB / 16 GB".
    expect(formatBytesOf(0.8 * 1024 ** 3, 16 * 1024 ** 3)).toBe("0.8 / 16 GB");
  });
});

describe("formatLoad", () => {
  it("prints two decimals and never a negative", () => {
    expect(formatLoad(1.5)).toBe("1.50");
    expect(formatLoad(0)).toBe("0.00");
    expect(formatLoad(-1)).toBe("0.00");
  });
});

describe("niceCeiling", () => {
  it("rounds up to 1, 2, 5 or 10 times a power of ten in the unit's own scale", () => {
    expect(niceCeiling(1.3 * 1024 ** 2)).toBe(2 * 1024 ** 2);
    expect(niceCeiling(3 * 1024 ** 2)).toBe(5 * 1024 ** 2);
    expect(niceCeiling(6 * 1024)).toBe(10 * 1024);
    expect(niceCeiling(120 * 1024)).toBe(200 * 1024);
  });

  it("gives an idle chart a scale to draw against", () => {
    expect(niceCeiling(0)).toBe(1024);
    expect(niceCeiling(300)).toBe(1024);
  });
});

describe("the locale", () => {
  it("follows the app's locale for the decimal mark, and keeps the unit symbols", async () => {
    setLocale("de");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1,5 GB");
    expect(formatBytesPerSecond(1536)).toBe("1,5 KB/s");
    expect(formatLoad(1.5)).toBe("1,50");
  });
});
