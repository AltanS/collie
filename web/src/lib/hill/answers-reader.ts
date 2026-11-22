// What `POST /api/hill/answers` answers, read field by field (Asks, 2026-11-23). The body is the bridge's, but a
// proxy's page or an older bridge is not, so nothing is taken on trust: a body that does not fit reads as null.
// The shapes are `HillAnswersResult` and `HillAnswersRefusal` in wire.ts.

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import { HILL_STATES, type HillAnswersItem, type HillAnswersRefusal, type HillAnswersRefusalCode, type HillAnswersResult } from "./wire";

const DELIVERIES: readonly HillAnswersResult["delivery"][] = ["typed", "held", "unknown", "none"];
const REFUSAL_CODES: readonly HillAnswersRefusalCode[] = ["too_long", "mixed_sessions", "not_an_ask", "bad_answer", "not_answering", "not_typed", "rid_reused"];

/** One item of a Send, or null when it does not fit. */
function readItem(value: JsonValue | undefined): HillAnswersItem | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const id = asJsonString(o.id);
  const code = o.code === "ok" || o.code === "gone" ? o.code : undefined;
  const reason = o.reason === null || o.reason === undefined ? null : asJsonString(o.reason);
  const state = o.state === null || o.state === undefined ? null : HILL_STATES.find((s) => s === o.state);
  if (id === undefined || code === undefined || reason === undefined || state === undefined) return null;
  return { id, code, reason, state };
}

/** The 200 body of a Send, or null when it does not fit. */
export function readAnswersResult(value: JsonValue | undefined): HillAnswersResult | null {
  const o = asJsonObject(value);
  if (o === undefined || !Array.isArray(o.items)) return null;
  const rid = asJsonString(o.rid);
  const at = asJsonNumber(o.at);
  const delivery = DELIVERIES.find((d) => d === o.delivery);
  if (rid === undefined || at === undefined || delivery === undefined) return null;
  const items: HillAnswersItem[] = [];
  for (const raw of o.items) {
    const item = readItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  const result: HillAnswersResult = { rid, items, delivery, at };
  return o.unconfirmed === true ? { ...result, unconfirmed: true } : result;
}

/** The body of a refused Send, or null for a refusal that is no JSON of this shape (a proxy's page, an older bridge). */
export function readAnswersRefusal(value: JsonValue | undefined): HillAnswersRefusal | null {
  const o = asJsonObject(value);
  if (o === undefined) return null;
  const code = REFUSAL_CODES.find((c) => c === o.code);
  const error = asJsonString(o.error);
  if (code === undefined || error === undefined) return null;
  const refusal: HillAnswersRefusal = { code, error };
  const over = asJsonNumber(o.over);
  const id = asJsonString(o.id);
  const machine = asJsonString(o.machine);
  if (over !== undefined) refusal.over = over;
  if (id !== undefined) refusal.id = id;
  if (machine !== undefined) refusal.machine = machine;
  return refusal;
}
