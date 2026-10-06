// Port of web/src/components/direct-typing-strip.tsx: the armed indicator for direct typing, in the
// same in-flow slot as the "You sent:" strip. The lead puts it inside a `Collapse`; this draws only
// the content.
//
// WHY IT EXISTS ON TOP OF THE RESTYLED BUTTON AND TEXTAREA. Those are the two things you stop looking
// at once you start typing, so they fail the glance-back test: come back to the phone twenty seconds
// later and nothing in your field of view says the next keystroke goes straight into a running agent.
// This strip sits where the eye already goes for composer state and says what is happening in words.
import { on, type Handle } from "remix/component";
import { Keyboard } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../lib/i18n-store";
import { Icon } from "../ui/icon";

export interface DirectTypingStripProps {
  /** Read at tap time. */
  onStop: () => void;
}

export function DirectTypingStrip(handle: Handle<DirectTypingStripProps>) {
  useLocale(handle);
  return () => (
    <div data-testid="direct-typing-strip" class="flex items-center gap-2 px-1 pb-1 text-xs text-primary">
      <Icon icon={Keyboard} class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate">
        <span class="font-medium">{t("sendMode.armed.title")}</span>
        <span class="text-muted-foreground">, {t("sendMode.armed.hint")}</span>
      </span>
      <button
        type="button"
        data-testid="direct-typing-stop"
        mix={on("click", () => handle.props.onStop())}
        class="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted"
      >
        {t("sendMode.armed.stop")}
      </button>
    </div>
  );
}
