import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { deltaE, type Rgb } from "./colour";
import type { Break, Sample } from "./r5";

// THE STATES ALTAN APPROVED, HELD. On 2026-11-21 Altan looked at the Collie theme and said its hover states, its focus
// rings and its three planes are right. `collie-states.json` holds every state colour R5 painted in Collie light and
// Collie dark on that day (the hover fill, the selected and the open fill, the ring, the recess, the paper), but only
// the ones that passed R5: a state that broke a floor is a defect, and fixing it moves it. A derived state layer may
// change how a colour is made; in Collie it must still paint within STATE_HOLD of the colour he saw.
//
//     cd web && bun e2e/themes/states-write.ts <out-dir>     (writes the file from a run's THEMES_OUT; only on purpose)

export const STATE_HOLD = 0.02;
export const HELD_LOOKS = new Set(["collie-light", "collie-dark"]);

/** Per case key, the held samples by `rule el #n` (the n-th sample of that rule and element on the page). */
export type HeldStates = Record<string, Record<string, string>>;

export const STATES_PATH = fileURLToPath(new URL("./collie-states.json", import.meta.url));

export function readHeldStates(): HeldStates {
  try {
    // SAFETY: collie-states.json is written only by e2e/themes/states.ts, from a `HeldStates` value.
    return JSON.parse(readFileSync(STATES_PATH, "utf8")) as HeldStates;
  } catch {
    return {};
  }
}

/** The samples of one page by their stable name, `rule el #n`. */
export function namedSamples(samples: readonly Sample[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const s of samples) {
    const base = `${s.rule} ${s.el}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(`${base} #${String(n)}`, s.colour);
  }
  return out;
}

/** The samples that passed R5: a sample of an element that also stands in a break of the same rule is left out. */
export function passingSamples(samples: readonly Sample[], breaks: readonly Break[]): Map<string, string> {
  // A selected break names the pair, `<el> vs <peer>`; the sample names the selected element alone.
  const broken = new Set(breaks.map((b) => `${b.rule} ${b.rule === "selected" ? (b.el.split(" vs ")[0] ?? b.el) : b.el}`));
  const named = namedSamples(samples);
  for (const k of named.keys()) if (broken.has(k.slice(0, k.lastIndexOf(" #")))) named.delete(k);
  return named;
}

function rgb(h: string): Rgb {
  return [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
}

/** The held states this page moved by more than STATE_HOLD, or no longer paints, as lines. */
export function movedStates(key: string, samples: readonly Sample[]): string[] {
  const held = readHeldStates()[key];
  if (held === undefined) return [];
  const now = namedSamples(samples);
  const lines: string[] = [];
  for (const [name, was] of Object.entries(held)) {
    const is = now.get(name);
    if (is === undefined) {
      lines.push(`${key} ${name}: held ${was}, not painted any more`);
      continue;
    }
    const d = deltaE(rgb(was), rgb(is));
    if (d > STATE_HOLD) lines.push(`${key} ${name}: ${was} -> ${is}, ${d.toFixed(3)} in OKLab, over the ${String(STATE_HOLD)} Altan's approval allows`);
  }
  return lines;
}
