// ── COLLIE'S PROBE MARKER: THE ONE CHARACTER COLLIE TYPES TO PROVE A BOX, AND ITS RESIDUE ───────────
//
// The Send Protocol and Clear prove a box by typing one probe character into it and taking it out again
// with Backspace. A profile may name its own character (`probe.char`); a pane with no profile, and every
// profile today, uses {@link PROBE_MARKER}.
//
// A box that is drawn but does not read keys yet (omp 18.12.6 draws its box about twenty seconds before
// it reads a key; gang three, 2026-10-26) keeps the character in the terminal's buffer, and shows it as a
// draft once it wakes. A box whose whole text is one or more probe characters and nothing else is
// therefore Collie's own residue, never a person's draft: {@link probeResidue} counts it, and the caller
// takes exactly those characters out (one Backspace each) before it goes on. A probe character beside any
// other text is not counted: that box holds someone's text, and nothing of it is Collie's to delete.
//
// No harness is named here (no-harness-names.test.ts scans this folder).

import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";

/** The probe character on a pane with no profile: the slice 0 lab found it inert in every hotkey dialog. */
export const PROBE_MARKER = "⌁";

/** The probe character a send or a Clear types on this profile: its own, else {@link PROBE_MARKER}. */
export function probeCharOf(match: Pick<ProfileMatch, "profile"> | null): string {
  const own = match?.profile.probe.char;
  return own === undefined || own === "" ? PROBE_MARKER : own;
}

/**
 * How many probe characters a box holds when its whole text, white space around it aside, is `probe`
 * one or more times and nothing else. 0 for an empty box and for any box with other text in it.
 */
export function probeResidue(box: string, probe: string): number {
  const text = box.trim();
  if (text === "" || probe === "") return 0;
  const count = text.split(probe).length - 1;
  return count > 0 && text === probe.repeat(count) ? count : 0;
}
