import { createContext, useContext } from "react";

import { Badge } from "@/components/ui/badge";
import { t, type MessageKey } from "@/lib/i18n";
import { tokenUseFeature } from "@/lib/token-use-features";
import type { TokenUseReason } from "@/lib/tricks/token-use";
import { cn } from "@/lib/utils";

// "USES AGENT TOKENS" (2026-11-12): the quiet chip after the name of a trick or a Collie feature that makes
// an agent read or write more, so it is clear that it does not come for free. The facts decide, never a flag
// set by hand: lib/tricks/token-use.ts for a trick, lib/token-use-features.ts for Collie's own switches.
//
// The look of the origin label beside it (tricks-settings-card.tsx `OriginLabel`), on the secondary ground,
// with no icon: a fact, not a warning, so never the warning colour or glyph. It never wraps (ui/badge.tsx).
// In a row the NAME truncates first: the name beside it carries `TOKEN_USE_NAME` (a flex-shrink a thousand
// times the chip's), so the chip gives up width only once the name is gone, and then cuts its own words
// with an ellipsis rather than run past its column into the switch or Add. In English at 360 px it keeps its words; a long translation may not
// (measured 2026-11-12 with the playground's `?words=` fixture: German and Japanese leave no name at 360 px).
//
// A trick's About sheet says why in one sentence, the first row of "What it does" (`tokenUseWhy`), and draws
// no chip there.

/**
 * Whether the label is drawn, and its words. The app never sets it: every chip and sentence draws, in the
 * app's language. The playground sets it to show the look before the label ("0 Today") and to try a
 * translation's width before the translation pass.
 */
export interface TokenUseLook {
  readonly shown: boolean;
  /** The chip's words in place of `tokens.uses`. */
  readonly word?: string;
}

const LookContext = createContext<TokenUseLook>({ shown: true });

/** The playground's hand on the label. */
export const TokenUseLookProvider = LookContext.Provider;

/** Whether the label is drawn here. */
export function useTokenUseShown(): boolean {
  return useContext(LookContext).shown;
}

/** The chip. `data-slot="token-use"` for the tests and the shots. */
export function TokenUseChip({ className }: { className?: string }) {
  const look = useContext(LookContext);
  if (!look.shown) return null;
  return (
    <Badge variant="secondary" data-slot="token-use" className={cn("min-w-0 shrink px-1.5 py-0 text-[11px] leading-4 font-normal", className)}>
      <span className="truncate">{look.word ?? t("tokens.uses")}</span>
    </Badge>
  );
}

/** The class of the name the chip stands after: it truncates first, then the chip. */
export const TOKEN_USE_NAME = "min-w-0 shrink-[1000] truncate";

/** The chip of one of Collie's own switches, or nothing when the feature list does not name it. */
export function FeatureTokenChip({ feature, className }: { feature: string; className?: string }) {
  if (tokenUseFeature(feature) === undefined) return null;
  return <TokenUseChip className={className} />;
}

const WHY = {
  "agent-view": "settings.tricks.about.tokens.agentView",
  rules: "settings.tricks.about.tokens.rules",
  answer: "settings.tricks.about.tokens.answer",
} as const satisfies Record<TokenUseReason, MessageKey>;

/** The About sheet's sentence: why the trick makes an agent read or write more. */
export function tokenUseWhy(reason: TokenUseReason): string {
  return t(WHY[reason]);
}
