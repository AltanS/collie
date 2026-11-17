// The bridge answers every generated answer suite meets alike (M102 spec 15, part 1b): the HTTP
// statuses with each body shape, the broken links, bodies of older and newer bridges. Pure data: a
// suite turns each into a stubbed fetch or an msw handler.

import type { JsonValue } from "@/lib/json";

export const STATUSES = [400, 404, 409, 500, 502, 503, 504] as const;

/** One generated answer: how the stubbed fetch behaves. */
export type Answer =
  | { readonly kind: "status"; readonly status: number; readonly body: string; readonly label: string }
  | { readonly kind: "throw"; readonly error: () => Error; readonly label: string };

export const json = (value: JsonValue): string => JSON.stringify(value);
export const HTML = "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>";

/** The failures every route meets alike: statuses with each body shape, the broken links, bodies of other bridges. */
export function commonAnswers(): Answer[] {
  const out: Answer[] = [];
  for (const status of STATUSES) {
    out.push({ kind: "status", status, body: json({ ok: false, error: "The bridge refused.", code: "unknown_code_from_a_newer_bridge" }), label: `${String(status)} json` });
    out.push({ kind: "status", status, body: HTML, label: `${String(status)} html` });
    out.push({ kind: "status", status, body: "", label: `${String(status)} empty` });
  }
  out.push({ kind: "throw", error: () => new DOMException("The operation timed out.", "TimeoutError"), label: "time-out" });
  out.push({ kind: "throw", error: () => new DOMException("The operation was aborted.", "AbortError"), label: "abort" });
  out.push({ kind: "throw", error: () => new TypeError("Failed to fetch"), label: "link dropped" });
  out.push({ kind: "status", status: 200, body: "this is not json", label: "200 not json" });
  out.push({ kind: "status", status: 200, body: json({}), label: "200 empty object (older bridge)" });
  out.push({ kind: "status", status: 200, body: json({ surprise: true, version: 99 }), label: "200 unknown fields only (newer bridge)" });
  out.push({ kind: "status", status: 200, body: "null", label: "200 null" });
  return out;
}

