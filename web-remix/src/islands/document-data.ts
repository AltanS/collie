// The islands document's one data block (S3): `<script type="application/json" id="collie-boot">`.
//
// WHY NOT ISLAND PROPS. Every island that draws from the snapshot (the composer, the sheets, the header
// actions, the live strip) would carry its own copy in `rmx-data`, and every soft navigation would ship
// them all again. The document carries the snapshot, the config and a pane page's read ONCE, here; the
// islands' props stay small (a pane id, a page kind), and the stores are primed from this block before
// `run()` (islands/boot.ts) and again, from the next document, before a soft navigation diffs it in
// (islands/resolver.ts).
//
// A new document's scripts never run on a soft navigation (research note 10, 2.4), so this is data, not
// code: the browser reads it with `JSON.parse`. `<` is written as `<` so no value can close the tag.
import { asJsonNumber, asJsonString, parseJsonObject } from "@web/lib/json";

import type { DocumentProps } from "../lib/document-props";

export const BOOT_SCRIPT_ID = "collie-boot";

export interface DocumentData extends DocumentProps {
  /** The hash of each snapshot frame this document drew (islands/snapshot-frames.ts), by frame name. */
  held: Record<string, string>;
}

/** The block as the bridge writes it. */
export function documentDataScript(data: DocumentData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${BOOT_SCRIPT_ID}">${json}</script>`;
}

function parse(text: string | null | undefined): DocumentData | null {
  if (text == null || text === "") return null;
  const raw = parseJsonObject(text);
  // The fields the boot branches on are checked here; anything else fails to a static-shell boot.
  if (raw === undefined || asJsonString(raw.path)?.startsWith("/") !== true || asJsonNumber(raw.snapshotAt) === undefined || raw.snapshot === undefined) return null;
  // SAFETY: the bridge's own block (ssr/islands-document.tsx writes it with `documentDataScript`), its
  // path and snapshot time checked above; `held` is filled in when an older bridge left it out.
  const data = JSON.parse(text) as DocumentData;
  data.held ??= {};
  return data;
}

/** The block of the live document, or null. */
export function readDocumentData(doc: Document = document): DocumentData | null {
  return parse(doc.getElementById(BOOT_SCRIPT_ID)?.textContent);
}

const BLOCK = new RegExp(`<script type="application/json" id="${BOOT_SCRIPT_ID}">([\\s\\S]*?)</script>`);

/** The block of a fetched document's HTML, or null (the static shell, a proxy's page). */
export function documentDataOf(html: string): DocumentData | null {
  return parse(BLOCK.exec(html)?.[1]);
}
