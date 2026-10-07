// The idle lock's cover (ADR 0007), shared by the static shell (shell.tsx) and an islands page's
// `live` island (islands/live.tsx).
import { on, type Handle } from "remix/component";

import { t } from "@web/lib/i18n";

import { unlock } from "../lib/idle";
import { Button } from "../ui/button";
import { CollieMark } from "./collie-mark";

export function IdleCover(handle: Handle<{ catchingUp: boolean }>) {
  return () => {
    const { catchingUp } = handle.props;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("idle.dialogAria")}
        data-testid="idle-lock"
        translate="no"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]"
      >
        <div class="flex flex-col items-center gap-6 rounded-lg border border-border/60 bg-card/70 px-8 py-10 text-center shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl">
          <div class="flex flex-col items-center gap-3">
            {/* ONE mark in both states, in one 80 px box, so the panel never shifts as the resume
                fetch starts and finishes. The catch-up is the bloom: the orbit speeds up and the
                accents come to full chroma. `paper` is the glass panel's own token, the closest
                honest answer over a blurred herd. */}
            <span class="grid size-20 shrink-0 place-items-center">
              <CollieMark size={64} loading={catchingUp} paper="var(--card)" />
            </span>
            <span class="text-lg font-semibold tracking-tight">Collie</span>
          </div>
          {catchingUp ? (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.catchingUp.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.catchingUp.body")}</p>
            </div>
          ) : (
            <div class="space-y-1">
              <p class="font-medium">{t("idle.paused.title")}</p>
              <p class="max-w-xs text-sm text-muted-foreground">{t("idle.paused.body")}</p>
            </div>
          )}
          {!catchingUp && (
            <Button size="lg" mix={on("click", unlock)}>
              {t("idle.resume")}
            </Button>
          )}
        </div>
      </div>
    );
  };
}
