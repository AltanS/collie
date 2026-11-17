// THE SIGN-IN ADDRESS an agent prints in its sign-in card, checked before the phone opens it (Change
// login, M101). The card (harness/sign-in-card.ts) already joins the address the agent wrapped over
// several rows into one link run; this module takes that run and decides one thing: may the "Open
// sign-in page" button open it, or is it text to copy.
//
// It opens only an `https:` address on a host the agent's adapter lists (bridge/account-adapters.ts
// `signInHosts`, sent on `GET /api/accounts`), with no user name or password in it, no port, no space
// or control character, and at most MAX_ADDRESS_CHARS characters. Anything else is text to copy. The
// address is never stored, logged or sent anywhere: it lives in the card's render and in the link.
//
// Pure functions over the card's model.

import type { BoxTextModel } from "./harness/box-text-model";

/** The longest address the button opens. Claude Code's is about 600 characters at 2.1.325. */
export const MAX_ADDRESS_CHARS = 4096;

/** What the card does with the address: open it with the button, or show it as text to copy. */
export type SignInAddress = { kind: "open"; href: string; text: string } | { kind: "copy"; text: string };

/** Whether the text holds a space, a control or a format (bidi) character. */
const UNSAFE = /[\s\p{Cc}\p{Cf}]/u;

/**
 * The one check: `text` is the address as the agent printed it, joined; `hosts` the adapter's exact host
 * names. An href when the button may open it, else null.
 */
export function openableAddress(text: string, hosts: readonly string[]): string | null {
  if (text === "" || text.length > MAX_ADDRESS_CHARS || UNSAFE.test(text)) return null;
  if (!text.toLowerCase().startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => h.toLowerCase() === host)) return null;
  return url.href;
}

/**
 * The address of a sign-in card: its first link. The card's reader joined the rows the agent wrapped the
 * address over into this one run (harness/box-url-join.ts); the tests hold that against the wrapped
 * captures. Null when the card holds no link.
 */
export function addressOfCard(model: BoxTextModel): string | null {
  for (const row of model.text) {
    for (const run of row) if (run.kind === "link") return run.text;
  }
  return null;
}

/** What the card does with its address, or null when it holds none. */
export function signInAddress(model: BoxTextModel, hosts: readonly string[]): SignInAddress | null {
  const text = addressOfCard(model);
  if (text === null) return null;
  const href = openableAddress(text, hosts);
  return href === null ? { kind: "copy", text } : { kind: "open", href, text };
}
