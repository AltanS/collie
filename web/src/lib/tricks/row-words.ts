// THE WORDS OF A TRICK'S ROW, shared by Settings → Tricks (components/tricks-settings-card.tsx) and a trick's
// About sheet (components/trick-about-sheet.tsx), so the two say a place, a read, a warning and an origin in the
// same words. Pure: the phone's own English (or the person's language), and the wire's facts.

import { t, type MessageKey } from "@/lib/i18n";
import { TRICK_WARNING_KINDS, TRICK_WARNINGS_MAX, type PlaceKind, type TrickWarningKind, type TricksRunsOn, type WireTrickInfo } from "@/lib/tricks/schema";

/** The place words of a trick, each kind once, in the manifest's order. */
export function placesLine(places: readonly PlaceKind[] | undefined): string {
  // A trick entry with no `places` (an older bridge, a broken reply) is a manifest that declares none.
  const held: readonly PlaceKind[] = Array.isArray(places) ? places : [];
  const words = [...new Set(held)].map((place) => t(`settings.tricks.place.${place}` satisfies MessageKey));
  return words.length === 0 ? t("settings.tricks.places.none") : words.join(", ");
}

/** One warning as the row shows it: the phone's own words for a kind it knows, the bridge's for another. */
export interface WarningLine {
  kind: string;
  text: string;
}

function isKnownKind(kind: string): kind is TrickWarningKind {
  return TRICK_WARNING_KINDS.some((known) => known === kind);
}

/**
 * The warnings a trick's row carries, in the phone's own words for a kind it knows and the bridge's for
 * another. The wire reader (lib/tricks/wire.ts `readWarnings`) already left out a malformed entry.
 */
export function warningLines(trick: Pick<WireTrickInfo, "warnings">): WarningLine[] {
  const held = Array.isArray(trick.warnings) ? trick.warnings.slice(0, TRICK_WARNINGS_MAX) : [];
  return held.map(({ kind, text }) => ({ kind, text: isKnownKind(kind) ? t(`settings.tricks.warn.${kind}` satisfies MessageKey) : text }));
}

/** What a contract 2 trick reads, in one sentence: schema.ts `inputsSentence` in the phone's words. */
export function readsLine(inputs: NonNullable<WireTrickInfo["inputs"]>): string {
  const globs = inputs.globs.join(", ");
  return inputs.crew ? t("settings.tricks.reads.crew", { globs }) : t("settings.tricks.reads.solo", { globs });
}

/** "Tricks run on the lead of this crew (desk). This machine runs none." for a bridge that runs none. */
export function runsOnLine(runsOn: TricksRunsOn): string {
  return runsOn.lead === undefined ? t("settings.tricks.runsOn") : t("settings.tricks.runsOn.lead", { lead: runsOn.lead });
}

/**
 * Where a trick came from, for its About sheet: "From owner/repo @ 3f2a91c" for one `collie trick add` took
 * from a repository, "Proposed by an agent session on minibuch." for one `collie trick propose` handed in,
 * else "Added on this machine." (a folder, the CLI or an agent made it here).
 */
export function originLine(by: WireTrickInfo["provenance"]): string {
  if (by?.proposed !== undefined) return by.proposed.by === "agent" ? t("settings.tricks.about.proposedAgent", { host: by.proposed.host }) : t("settings.tricks.about.proposedUnconfirmed", { host: by.proposed.host });
  if (by === undefined || by.via !== "repo" || by.repo === undefined) return t("settings.tricks.about.local");
  if (by.sha === undefined) return t("settings.tricks.by.repoBare", { repo: by.repo });
  return t(by.unlisted === true ? "settings.tricks.by.repoUnlisted" : "settings.tricks.by.repo", { repo: by.repo, sha: by.sha.slice(0, 7) });
}
