// The key a session's pins are filed under (M90). The journal session the Chat reader keys a pane on:
// the harness that wrote it and the ref it reported or discovered. The pane id is NOT in it, because a
// pane id is reused once the pane closes and the pins belong to the conversation.

import { createHash } from "node:crypto";

import type { AgentSessionRef } from "../journal/types.ts";
import { SESSION_KEY } from "./store.ts";

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A piece of a key as it stands when it is already file-safe, else a hash of it (a path ref, say). */
function part(value: string): string {
  if (PLAIN.test(value)) return value;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * `<agent>.<ref>` with the ref kind in front of a hashed value, so an id and a path that happen to
 * read alike never share a file. Always accepted by {@link SESSION_KEY}.
 */
export function pinSessionKey(agent: string, ref: AgentSessionRef): string {
  const key = `${part(agent)}.${ref.kind === "id" ? "" : "p-"}${part(ref.value)}`;
  if (!SESSION_KEY.test(key)) throw new Error(`pin session key out of shape: ${key}`);
  return key;
}
