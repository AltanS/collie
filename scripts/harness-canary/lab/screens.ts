// One screen of a lab run, as the Surface reads it (M56 spec 10). The lab reads the pane through the
// mux adapter, parses it the way the bridge does, lifts an ask the way the shadow does, and folds the
// Surface with the harness's own profile. A harness with no profile reads with the generic cues alone.

import { parseAnsi } from "../../../web/src/lib/ansi";
import { lineText, splitLines, type StyledLine } from "../../../web/src/lib/blocks";
import type { CueStrength } from "../../../web/src/lib/surface/cues";
import type { IdleProfile } from "../../../web/src/lib/surface/frame";
import { loadProfiles } from "../../../web/src/lib/surface/profile";
import { isFree, modalWord, shortHash, type Surface } from "../../../web/src/lib/surface/surface";
import { agentOf, readScreen } from "../../../web/src/test/surface-corpus";
import type { ScreenExpect, ScreenFact } from "./verdict";

export interface ScreenView {
  readonly raw: string;
  readonly rows: StyledLine[];
  readonly plain: readonly string[];
  readonly surface: Surface;
  readonly free: boolean;
  readonly cue: CueStrength;
  /** A short hash of the plain rows, to tell whether the screen moved. */
  readonly hash: string;
}

/** The idle anchors the harness's profile gives, or null. */
export function idleOf(harness: string): IdleProfile | null {
  return loadProfiles().get(harness)?.idle ?? null;
}

export function viewOf(raw: string, harness: string): ScreenView {
  const rows = splitLines(parseAnsi(raw));
  const read = readScreen(rows, agentOf(harness), idleOf(harness));
  const plain = rows.map((row) => lineText(row));
  return {
    raw,
    rows,
    plain,
    surface: read.surface,
    free: isFree(read.surface),
    cue: read.cues?.strength ?? "none",
    hash: shortHash(plain.join("\n")),
  };
}

export function factOf(view: ScreenView, leg: string, label: string, expects: ScreenExpect): ScreenFact {
  const { turn, composer, reason } = view.surface;
  return {
    leg,
    label,
    expects,
    surface: { turn, composer, modal: modalWord(view.surface.modal), reason },
    free: view.free,
    cue: view.cue,
    rows: view.plain,
  };
}
