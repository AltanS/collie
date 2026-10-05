// One formatter for every number the Machines pages print: a fraction as a percent, bytes, and bytes
// per second. A page that formats inline ends up with "7.4 GB" in one card and "7.40GB" in the next,
// and a chart axis that disagrees with the card above it.
//
// Numbers go through `Intl.NumberFormat` on the APP's locale (not the browser's), so a language
// switch changes the decimal mark at once. The unit SYMBOLS (B, KB, MB, GB, TB) are the same in every
// locale on purpose: they are technical symbols, like a key cap, and the app does not translate those.
// Sizes are binary (1024), because memory is sold and reported that way.

import { getLocaleSnapshot } from "./i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const STEP = 1024;

const formats = new Map<string, Intl.NumberFormat>();

/** A cached formatter for the active locale and one fraction-digit rule. */
function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = getLocaleSnapshot().locale;
  const key = `${locale}|${options.style ?? "decimal"}|${options.minimumFractionDigits ?? ""}|${options.maximumFractionDigits ?? ""}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/** A finite, non-negative number, or 0. The wire is checked by the bridge; a chart must still never print NaN. */
function clean(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A 0..1 fraction as a whole-number percent: `0.234` reads "23%". Clamped, so a bad sample cannot print 400%. */
export function formatPercent(fraction: number): string {
  return numberFormat({ style: "percent", maximumFractionDigits: 0 }).format(Math.min(1, clean(fraction)));
}

/** The one-minute load average, two decimals: `1.5` reads "1.50" (and "1,50" in German). */
export function formatLoad(load: number): string {
  return numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(clean(load));
}

/** The index of the unit a byte count reads in: the largest one whose value is at least 1. */
function unitIndex(bytes: number): number {
  let index = 0;
  let value = bytes;
  while (value >= STEP && index < UNITS.length - 1) {
    value /= STEP;
    index += 1;
  }
  return index;
}

/** `bytes` in the unit at `index`: one decimal below 10, none from 10 up, so "7.4 GB" and "16 GB". */
function inUnit(bytes: number, index: number): string {
  const value = bytes / STEP ** index;
  const digits = value < 10 && index > 0 ? 1 : 0;
  return `${numberFormat({ maximumFractionDigits: digits }).format(value)} ${UNITS[index]}`;
}

/** A byte count: `0` reads "0 B", `7.9e9` reads "7.4 GB". */
export function formatBytes(bytes: number): string {
  const n = clean(bytes);
  return inUnit(n, unitIndex(n));
}

/** A rate in bytes per second: `1.5e6` reads "1.4 MB/s". */
export function formatBytesPerSecond(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/**
 * Used and total in ONE unit, the total's: "7.4 / 16 GB". Two units ("812 MB / 16 GB") make the bar
 * and the sentence disagree about how full it is, so the pair shares the unit the total picked.
 */
export function formatBytesOf(used: number, total: number): string {
  const index = unitIndex(clean(total));
  const digits = clean(used) / STEP ** index < 10 && index > 0 ? 1 : 0;
  const usedText = numberFormat({ maximumFractionDigits: digits }).format(clean(used) / STEP ** index);
  return `${usedText} / ${inUnit(clean(total), index)}`;
}

/**
 * The next "round" number at or above `value`, from the 1-2-5 ladder in the unit's own scale: 1.3 MB
 * becomes 2 MB, 6 KB becomes 10 KB. Used for a chart axis that has no fixed top. `0` gives 1 KB, so an
 * idle network chart still has a scale to draw its flat line against.
 */
export function niceCeiling(value: number): number {
  const n = clean(value);
  const index = Math.max(1, unitIndex(n));
  const scaled = n / STEP ** index;
  if (scaled <= 1) return STEP ** index;
  const magnitude = 10 ** Math.floor(Math.log10(scaled));
  const unit = scaled / magnitude;
  const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return step * magnitude * STEP ** index;
}
