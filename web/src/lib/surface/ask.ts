// The Ask's wire shapes and its closed lists (M56 spec 08; the contract is in the M56 README, "Ask",
// and experiments/reader-stability/ARCHITECTURE.md section 3). The bridge runs the answer
// (bridge/surface/ask.ts); the phone posts one Answer for a tap on a dialog card and renders the
// reply. Both read the types from here, so the lists cannot drift apart.
//
// An ask id is single use. The bridge mints it bound to the ask's content hash, the pane generation
// and the literal text of the lifted block, never to the read revision (Herdr reads every pane at
// revision 0). Before the first key the bridge reads the screen again and requires the same binding;
// before Enter it reads the pointer back (ADR 0080). An old tap never becomes keys.
//
// Pure: no DOM, no Bun API, no harness name.

import { asJsonObject, asJsonString, type JsonValue } from "../json";
import type { ReadMark } from "./send";
import type { Ask, AskChannel, AskKind, Surface } from "./surface";

/** What the phone posts to `POST /api/ask/<id>`: the contract's Answer, plus the pane it is for. */
export interface Answer {
  readonly askId: string;
  readonly hash: string;
  readonly optionId: string;
  readonly origin: "person_tap";
  /**
   * `hold-card` when the tap came from the hold card of a hook-held permission (M56 spec 12). The
   * bridge takes a tap on a hold with no adopted dialog only from there, never from a screen card.
   */
  readonly via?: "hold-card";
}

/** An answer's request body. The ask id is in the path. */
export interface AnswerBody {
  readonly pane: string;
  readonly hash: string;
  readonly optionId: string;
  readonly origin: "person_tap";
  readonly via?: "hold-card";
}

/** The closed list of outcomes an answer can end in, a subset of the send outcomes. */
export const ASK_OUTCOMES = ["sent", "refused", "unknown"] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];

/**
 * The closed list of reasons. A `refused` answer sent no committing key: before the first key nothing
 * left at all; `ask_mismatch` may have sent the walk's arrows and never the Enter.
 */
export const ASK_REASONS = [
  // refused before any key
  "ask_unknown", // the bridge never minted this id, or forgot it (a restart)
  "ask_answered", // the id was answered before, with another option or hash
  "ask_changed", // the dialog on the screen is not the one the id was minted for
  "ask_gone", // the dialog is gone from the screen, or the ask outlived its lifetime there
  "ask_desk", // a hook-held ask (M56 spec 12): the desk, another hook or another Collie answered first
  "no_plan", // the option has no key plan the bridge sends (a text field, a multi-step flow)
  "busy", // another send or answer holds the pane
  "pane_gone", // the pane holds another program, or cannot be read
  "stale_token", // the key gate refused the token: it is older than its lifetime
  "stale_surface", // the key gate refused the token: the pane moved after the read
  "write_failed", // the multiplexer refused the keys
  // refused after the walk: arrows went, Enter did not
  "ask_mismatch", // the highlighted row is not the chosen option
  // unknown: the request ended without evidence either way
  "bound",
  "crash",
  "no_evidence",
] as const;
export type AskReason = (typeof ASK_REASONS)[number];

/** An ask id as the bridge mints it: `ask-` and 14 hex digits. It names a file. */
export const ASK_ID = /^ask-[0-9a-f]{14}$/;

/**
 * The receipt of one answer, a closed list of fields. It is written to disk beside the send receipts,
 * so it holds no screen text and no label: the option by id, the reads by revision and hash.
 */
export interface AskReceipt {
  readonly askId: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly harness: string;
  readonly kind: AskKind;
  /** The hash the ask was minted with. */
  readonly hash: string;
  readonly optionId: string;
  readonly origin: "person_tap";
  /** The read before the first key, where the hash was compared. */
  readonly check: ReadMark | null;
  /** The read the commit was bound to: after the walk, the one that showed the pointer on the option. */
  readonly readBack: ReadMark | null;
  /** The read after the commit, that showed the dialog had moved on. */
  readonly after: ReadMark | null;
  /** Named keys sent, in order. */
  readonly keys: readonly string[];
  readonly outcome: AskOutcome;
  readonly reason?: AskReason;
  /**
   * How the answer went out, when it is not the screen's keys: `hook` for a hook-held permission (M56
   * spec 12, no key is ever sent, `keys` stays empty), `program` for a program session (M56 spec 14).
   */
  readonly channel?: AskChannel;
  /** The decision that went to the hook, for a hook-held ask that reached it. */
  readonly decision?: "allow" | "deny";
}

/** What `POST /api/ask/<id>` answers. */
export interface AskReply {
  readonly receipt?: AskReceipt;
  /** The ask the bridge reads on the pane now, with its own new id, when the answer was refused for a changed or unknown ask. */
  readonly ask?: Ask;
  /** The Surface of the newest read, when the answer is about the screen. */
  readonly surface?: Surface;
  /** A sentence for the person: what moved, why a step stopped. */
  readonly detail?: string;
  /** True when the same id came back and this is the stored receipt. */
  readonly replayed?: boolean;
}

/** An answer body, checked field by field, or null (a 400). */
export function parseAnswerBody(askId: string, value: JsonValue | undefined): ({ pane: string } & Answer) | null {
  if (!ASK_ID.test(askId)) return null;
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const pane = asJsonString(node.pane);
  const hash = asJsonString(node.hash);
  const optionId = asJsonString(node.optionId);
  if (pane === undefined || pane.length === 0 || pane.length > 256) return null;
  if (hash === undefined || !/^[0-9a-f]{1,64}$/u.test(hash)) return null;
  if (optionId === undefined || !/^[0-9]{1,3}$/u.test(optionId)) return null;
  if (node.origin !== "person_tap") return null;
  if (node.via !== undefined && node.via !== "hold-card") return null;
  return node.via === "hold-card" ? { pane, askId, hash, optionId, origin: "person_tap", via: "hold-card" } : { pane, askId, hash, optionId, origin: "person_tap" };
}
