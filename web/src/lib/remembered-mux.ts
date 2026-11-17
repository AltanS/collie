import { readAnswer, writeAnswer, type AnswerName } from "@/lib/remembered-shape";
import { MUX_CAPABILITIES, type MuxCapability, type MuxConfig, type SttCapability } from "@/lib/types";

// WHAT THE FRONT MACHINE'S /api/config SAID LAST TIME, as the first answer of the config store.
//
// The store (lib/operator-config.ts) starts empty and the read ends after the first paint, so every
// control the multiplexer gates is drawn from the fail-open default and then swapped when the real
// answer differs (a durable machine's dashboard, the Spaces "+", a program's belt buttons). This file
// is the thin adapter between that store and the remembered-answer primitive (lib/remembered-shape.ts):
// after each successful read the store hands it the block to remember, and at module load the store
// asks it for the block to start from.
//
// THE SEED IS "LAST KNOWN, ELSE CAPABLE; A REAL READ REPLACES IT". A first visit and a wiped device
// have no seed, and then the default in lib/mux-capability.ts holds. A seed is never the answer for
// longer than one read: the store replaces it in full when the read lands.
//
// WHAT IT HOLDS: one yes/no/unsaid word per declared capability, the `spaces` word, and whether a
// speech provider was offered. WHAT IT NEVER HOLDS: the multiplexer's name, its notes, its mark's URL,
// the refused keys, the operator's rows and fonts, the upload limits, the Whistle state. A capability's
// note stays empty until the read, so a component that explains an absent capability explains it then.
//
// ONLY THE FRONT MACHINE'S OWN ANSWER IS REMEMBERED. The remembered-answer primitive keys per mount and
// never per host (a host name in a key would be an identity), so a crew member's own block and a
// session card's block keep today's behaviour: until their read lands they answer with the front
// machine's block, which is now its last known one.

function factOf(capability: MuxCapability): AnswerName {
  // The template's type is `mux-${MuxCapability}`; the compiler checks it names a row of ANSWERS, so a
  // capability added to MUX_CAPABILITIES without a row there fails the typecheck.
  return `mux-${capability}` as const;
}

/** The block to start the store from, or `null` when nothing was remembered (or all of it was "unsaid"). */
export function readRememberedMux(): MuxConfig | null {
  const capabilities: Partial<Record<MuxCapability, boolean>> = {};
  let said = false;
  for (const capability of MUX_CAPABILITIES) {
    const word = readAnswer(factOf(capability));
    if (word !== "yes" && word !== "no") continue;
    capabilities[capability] = word === "yes";
    said = true;
  }
  const spaces = readAnswer("mux-spaces");
  if (!said && spaces !== "one") return null;
  // Name, notes, keys and mark stay empty until the read: nothing here is a word an operator wrote.
  const block: MuxConfig = { name: "", capabilities, unsupportedKeys: [], notes: {} };
  if (spaces !== undefined) block.spaces = spaces;
  return block;
}

/** Remember what a successful read said. A bridge that published no block is remembered as saying nothing. */
export function rememberMux(mux: MuxConfig | null | undefined): void {
  for (const capability of MUX_CAPABILITIES) {
    const said = mux?.capabilities?.[capability];
    writeAnswer(factOf(capability), said === undefined ? "unsaid" : said ? "yes" : "no");
  }
  writeAnswer("mux-spaces", mux?.spaces === "one" ? "one" : "many");
}

/** Whether a speech provider was offered the last time the config was read. */
export function readRememberedSttOffered(): boolean {
  return readAnswer("stt-offered") === true;
}

/** Remember whether a successful read offered a speech provider. */
export function rememberStt(stt: SttCapability | null | undefined): void {
  writeAnswer("stt-offered", stt !== null && stt !== undefined);
}
