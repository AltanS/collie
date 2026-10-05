import type { MessageKey } from "@/lib/i18n";
import type { ChangesUnavailableReason } from "@/lib/types";

/** The sentence for a Changes or Files answer that has nothing to show, one wording for both tabs. */
export function unavailableKey(reason: ChangesUnavailableReason): MessageKey {
  if (reason === "no-git") return "changes.unavailable.noGit";
  if (reason === "no-pane") return "changes.unavailable.noPane";
  if (reason === "no-workspace") return "changes.unavailable.noWorkspace";
  return "changes.unavailable.noFolder";
}
