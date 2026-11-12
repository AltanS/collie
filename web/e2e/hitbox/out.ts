import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ONE FILE, TWO WRITERS. The census and the Dashboard experiments each own a key of the same JSON
// file, which the playground reads. A writer reads what is there, replaces its own key and writes the
// rest back, so running one half again keeps the other's numbers.

// `HITBOX_OUT` points a run at another file, so two runs side by side never write one file.
export const OUT = process.env.HITBOX_OUT ?? fileURLToPath(new URL("../../src/playground/fixtures/hitbox-census.json", import.meta.url));

/** What a JSON file holds. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function writeKey(key: string, value: Json): void {
  mkdirSync(dirname(OUT), { recursive: true });
  const held: { [key: string]: Json } = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  held[key] = value;
  writeFileSync(OUT, `${JSON.stringify(held)}\n`);
}
