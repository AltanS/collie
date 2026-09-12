import { t } from "@/lib/i18n";
import type { PushAvailability } from "@/lib/push";

// The two sentence tables that turn a push availability into something an operator can read. They
// lived inside `routes/settings.tsx` while Settings was the only screen that asked; the first-launch
// tour's third slide asks the same question, and two copies of an availability table are two chances
// to disagree about what `server-off` means.
//
// Both call `t()` at call time, never at module load: the operator can change the language without
// reloading, so a table frozen at import would answer in the old one.

/** Why an enable attempt failed — the sentence for an `EnableResult.reason`. */
export function reasonText(reason: PushAvailability | undefined): string {
  switch (reason) {
    case "insecure":
      return t("settings.push.reason.insecure");
    case "server-off":
      return t("settings.push.reason.serverOff");
    case "unavailable":
      return t("settings.push.availability.unavailable");
    case "denied":
      return t("settings.push.reason.denied");
    case "unsupported":
      return t("settings.push.reason.unsupported");
    default:
      return t("settings.push.reason.default");
  }
}

/** Why push cannot be turned on here at all — the standing note under a blocked toggle. */
export function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return t("settings.push.availability.insecure");
    case "server-off":
      return t("settings.push.availability.serverOff");
    case "unavailable":
      return t("settings.push.availability.unavailable");
    case "denied":
      return t("settings.push.availability.denied");
    case "unsupported":
      return t("settings.push.availability.unsupported");
    case "ready":
      return "";
  }
}
