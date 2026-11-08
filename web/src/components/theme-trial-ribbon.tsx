import { useEffect, useState } from "react";

import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { LIBRARY_MAX, type AddResult } from "@/lib/theme/store";
import { confirmLook, lookBefore } from "@/lib/theme/confirm";
import { endTrial, keepTrial, useTrial } from "@/lib/theme/trial";

import "./theme-trial-ribbon.css";

// The trial ribbon (M59 spec 08): while a theme is being tried, one bar at the bottom edge, "Trying
// <name>", Keep and Back. Mounted once, beside the router (App.tsx), so it stands over every screen.
//
// THEME-PROOF. Its look is `theme-trial-ribbon.css` alone: literal colours, a literal font and literal
// sizes, `position: fixed` at the highest z-index, pointer events always on. Nothing in it reads a
// theme token or a utility class, so the theme being tried cannot hide the way back.
//
// While it shows, the root carries `collie-trial`, which shortens the app's height token by the
// ribbon's 40px, so the composer and every sheet end above the ribbon rather than under it.

const REFUSAL_KEYS = {
  full: "theme.library.full",
  duplicate: "theme.library.duplicate",
  invalid: "theme.library.invalid",
  "reserved-id": "theme.refusal.reserved-id",
} as const satisfies Record<Extract<AddResult, { ok: false }>["reason"], MessageKey>;

/** The most characters of a name the ribbon shows; the parser caps a name at 40 already. */
const NAME_MAX = 40;

export function ThemeTrialRibbon() {
  useLocale();
  const trial = useTrial();
  const [refused, setRefused] = useState<MessageKey | null>(null);
  const active = trial !== null;

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add("collie-trial");
    return () => root.classList.remove("collie-trial");
  }, [active]);

  // A new trial starts with a clean line.
  useEffect(() => setRefused(null), [trial?.theme.id]);

  if (trial === null) return null;
  const name = [...trial.theme.name].slice(0, NAME_MAX).join("");

  function keep() {
    const before = lookBefore();
    const kept = keepTrial();
    if (!kept.ok) setRefused(REFUSAL_KEYS[kept.reason]);
    // Kept and worn: the same question every newly worn imported theme gets.
    else confirmLook(before);
  }

  return (
    <div className="collie-trial-ribbon" role="region" aria-label={t("theme.trial.region")}>
      <span className="collie-trial-ribbon__text" role="status" data-refused={refused === null ? undefined : ""}>
        {refused === null ? t("theme.trial.trying", { name }) : t(refused, { count: LIBRARY_MAX })}
      </span>
      <button type="button" className="collie-trial-ribbon__button collie-trial-ribbon__keep" onClick={keep}>
        {t("theme.trial.keep")}
      </button>
      <button type="button" className="collie-trial-ribbon__button collie-trial-ribbon__back" onClick={endTrial}>
        {t("theme.trial.back")}
      </button>
    </div>
  );
}
