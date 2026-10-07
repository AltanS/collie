// "Translation is on; the live view may redraw" (ACTION-PLAN A.3, `research/07-kody.md` c.1).
//
// Chrome Translate rewrites text nodes in place and wraps them in `<font>`, and it marks the
// document with `translated-ltr` or `translated-rtl` on `<html>`. The screen rows and chat blocks
// stay translatable on purpose (the reader wants them), and the next poll repaints a row the
// translator touched, so a row can flicker back for a moment. The strip says why.
//
// Like the connection strip this renders NOTHING in place: it drives one slot of the band, the
// lowest priority, and draws only while the class is on `<html>`. A MutationObserver on the class
// attribute watches it for the component's life.
import type { Handle, RemixNode } from "remix/component";
import { Languages } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate } from "../lib/store";
import { Icon } from "../ui/icon";
import { Notice } from "../ui/notice";
import { stripsOf } from "./context";
import { TRANSLATION } from "./strip-model";

/** The classes the browser's translator puts on `<html>` while it holds the page. */
export const TRANSLATED_CLASSES: readonly string[] = ["translated-ltr", "translated-rtl"];

/** Whether the document is translated, from its class tokens. Pure, so a test needs no DOM. */
export function isTranslated(classNames: Iterable<string>): boolean {
  for (const name of classNames) if (TRANSLATED_CLASSES.includes(name)) return true;
  return false;
}

/** The strip's body. One function for every instance, so the model sees an equal entry as equal. */
function renderNotice(): RemixNode {
  return (
    <div data-testid="translation-notice">
      <Notice tone="info" variant="strip" announce="status" icon={<Icon icon={Languages} />}>
        {t("connection.translation")}
      </Notice>
    </div>
  );
}

export function TranslationNotice(handle: Handle) {
  useLocale(handle);
  const slot = stripsOf(handle).slot(handle.signal);
  let on = false;
  // Bumped when the sentence changes (a language switch), so the model redraws the band.
  let rev = 0;
  let drawnCopy = "";

  const sync = (): void => {
    const next = isTranslated(document.documentElement.classList);
    if (next === on) return;
    on = next;
    scheduleUpdate(handle);
  };

  handle.queueTask(() => {
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    handle.signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    sync();
  });

  return () => {
    const copy = t("connection.translation");
    if (copy !== drawnCopy) {
      drawnCopy = copy;
      rev++;
    }
    const nowRev = rev;
    // The band's model is written after commit, never during render.
    handle.queueTask(() => {
      if (on) slot.show({ priority: TRANSLATION, render: renderNotice, rev: nowRev });
      else slot.hide();
    });
    return null;
  };
}
