// Every dashboard write goes through web/'s own API module (`@web/lib/api`: createTab, renamePane,
// closePane, focusPane, renameTab, closeTab, launch, dismissUpdate …), the same wire contract the
// React app writes through, as the pane screen does (routes/pane/answer.ts). This file adds the two
// things that module cannot know about this shell:
//
//   - PAIRING. web/'s api.ts feeds web/'s latch. This shell has its own (lib/pairing.ts), so every
//     answer is fed to it too: a 2xx write clears it, the not-paired 403 sets it (`notePairing`).
//   - READ-ONLY. A device the bridge marks read-only, or one the latch says is not paired, is refused
//     before the write is sent, with web/'s own sentence (`useSpaceActions`' `blockedText`).
import { isApiErrorStatus } from "@web/lib/api";
import { t } from "@web/lib/i18n";
import { isReadOnly } from "@web/lib/types";

import { snapshot } from "../lib/data";
import { isNotPaired, notePairing } from "../lib/pairing";

/** Why this device may not write right now, or undefined when it may. */
export function writeRefusal(): string | undefined {
  if (isNotPaired()) return t("space.readOnly.notPaired");
  if (isReadOnly(snapshot.get().data?.device)) return t("space.readOnly.deviceUnauthorised");
  return undefined;
}

/** The refusal body off web/'s ApiError message (`<path> → <status> <detail>`). */
function detailOf(error: Error, status: number): string {
  const marker = ` ${String(status)} `;
  const at = error.message.indexOf(marker);
  return at === -1 ? "" : error.message.slice(at + marker.length);
}

/** Run one write and feed its answer to this shell's pairing latch. Rethrows what it caught. */
export async function bridgeWrite<T>(op: () => Promise<T>): Promise<T> {
  try {
    const out = await op();
    notePairing("POST", 200);
    return out;
  } catch (error) {
    if (error instanceof Error && isApiErrorStatus(error, 403)) notePairing("POST", 403, detailOf(error, 403));
    throw error;
  }
}
