import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import { settingsPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

// The shell every Settings SECTION page wears: the shell's own header filled with a back button and
// a title, then one scrolling column of cards. Four pages share it, and sharing it is the point —
// four hand-rolled copies of the same header is how the old Settings header drifted from the
// shell's in the first place (see the note in routes/settings.tsx).
//
// Back goes to `/settings`, never home: a section is a CHILD of the index, and ADR 0067 says back
// goes up one level. `nav.up` is what makes a tap and the system gesture agree about that.
export function SettingsPage({ title, children }: { title: MessageKey; children: ReactNode }) {
  const nav = useNav();
  const scope = useScope();
  useLocale();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(settingsPath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t(title)}</h1>
          </>
        }
      />
      {/* `relative` for the same reason the home scroller carries it: an `sr-only` (position:
          absolute) deep in the page would otherwise escape the scroller and grow the document's
          own scrollbar. */}
      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {children}
      </main>
    </div>
  );
}
