// The frame every Settings page wears: a header row with a back button and a title, then one
// scrolling column of cards. Port of web/src/components/settings-page.tsx (and the index's own
// header in web/src/routes/settings.tsx, which is the same row with a different way up).
//
// Back goes UP one level (ADR 0067): a section to `/settings`, the index to home, never history back.
import { navigate, on, type Handle, type RemixNode } from "remix/component";
import { ArrowLeft } from "lucide";

import { t, type MessageKey } from "@web/lib/i18n";

import { useLocale } from "../../lib/i18n-store";
import { href } from "../../routes";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

export interface SettingsPageProps {
  title: MessageKey;
  /** The root-relative path one level up, scope included. */
  up: string;
  /** The back button's accessible name; Settings says "Back", Updates has its own key. */
  backLabel?: MessageKey;
  children?: RemixNode;
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  useLocale(handle);
  return () => {
    const { title, backLabel = "settings.nav.back", children } = handle.props;
    return (
      <div class="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
        <header class="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
          <Button
            variant="ghost"
            size="icon"
            // 44px: the tap floor every control in this row shares. size="icon" alone is 36px.
            class="-ml-2 size-11"
            aria-label={t(backLabel)}
            mix={on("click", () => void navigate(href(handle.props.up)))}
          >
            <Icon icon={ArrowLeft} class="size-5" />
          </Button>
          <h1 class="min-w-0 truncate text-lg font-semibold tracking-tight">{t(title)}</h1>
        </header>
        {/* `relative` so an sr-only node deep in the page cannot grow the document's scrollbar. */}
        <main class="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">{children}</main>
      </div>
    );
  };
}
