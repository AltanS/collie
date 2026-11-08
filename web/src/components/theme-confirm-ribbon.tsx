import { useEffect, useState } from "react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { CONFIRM_SECONDS, backLook, expireLookConfirm, keepLook, useLookConfirm } from "@/lib/theme/confirm";

import "./theme-trial-ribbon.css";

// Keep this look? (lib/theme/confirm.ts). After an imported theme goes on, the trial ribbon's own bar,
// colours and face ask "Keep this look?", with Keep and Back, and a countdown that goes Back by itself
// at zero. Mounted once beside the router (App.tsx), outside the inert wrapper, so a theme that hides
// the app cannot hide this. THEME-PROOF as the trial ribbon is: its look is `theme-trial-ribbon.css`
// alone, no token and no utility class.
//
// The number counts down in whole seconds. A thin bar drains across the top edge as well, except under
// reduced motion, where only the number moves. The countdown is not a live region: the question and
// a static sentence say it once, so a screen reader does not hear every second.

/** Whole seconds left before the deadline, never below zero. */
function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function ThemeConfirmRibbon() {
  useLocale();
  const confirm = useLookConfirm();
  const deadline = confirm?.deadline ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    const root = document.documentElement;
    root.classList.add("collie-confirm");
    setNow(Date.now());
    // The tick moves the number and the bar, and at zero goes Back by itself.
    const tick = setInterval(() => {
      const at = Date.now();
      if (!expireLookConfirm(at)) setNow(at);
    }, 250);
    return () => {
      clearInterval(tick);
      root.classList.remove("collie-confirm");
    };
  }, [deadline]);

  if (confirm === null) return null;
  const left = secondsLeft(confirm.deadline, now);
  // The bar shows what is left, so a ribbon resumed after a reload starts part way. Moved by the same
  // tick as the number, never by a CSS animation, so a page that was hidden (index.css pauses every
  // animation then) comes back with the bar and the number in step.
  const share = Math.min(1, Math.max(0, (confirm.deadline - now) / (CONFIRM_SECONDS * 1000)));

  return (
    <div className="collie-trial-ribbon" role="region" aria-label={t("theme.confirm.region")}>
      <span className="collie-confirm-ribbon__drain" aria-hidden="true" style={{ transform: `scaleX(${share})` }} />
      <span className="collie-trial-ribbon__text" role="status">
        {t("theme.confirm.question")}
        <span className="collie-confirm-ribbon__hidden">{t("theme.confirm.note", { seconds: CONFIRM_SECONDS })}</span>
      </span>
      <span className="collie-confirm-ribbon__count" aria-hidden="true">
        {left}
      </span>
      <button type="button" className="collie-trial-ribbon__button collie-trial-ribbon__keep" onClick={keepLook}>
        {t("theme.trial.keep")}
      </button>
      <button type="button" className="collie-trial-ribbon__button collie-trial-ribbon__back" onClick={backLook}>
        {t("theme.trial.back")}
      </button>
    </div>
  );
}
