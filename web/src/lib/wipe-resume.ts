// ── THE FIRST THING A PAGE DOES: FINISH A WIPE, THEN CHECK THE PAIRING'S EXPIRY ─────────────────
//
// The first import of main.tsx, so its body runs before the router, the loaders or any component
// reads storage. Two jobs, both cheap and synchronous at their start:
//
//   1. A wipe that a killed page left half done (`collie:wipe-pending`, lib/wipe.ts) runs again.
//      The store and the Chat tail are imported here so their cleaners are registered before it
//      runs; the store's database delete then sits first on the store's queue, ahead of any read.
//   2. A token whose remembered expiry has passed latches the pair-again wording before any fetch
//      (lib/pairing.ts `checkPairingExpiry`). The saved copies are already unreadable by then: the
//      store capped their lifetime at the same expiry.

import "@/lib/store";
import "@/lib/chat-tail";
import { checkPairingExpiry } from "@/lib/pairing";
import { resumePendingWipe } from "@/lib/wipe";

void resumePendingWipe();
checkPairingExpiry();
