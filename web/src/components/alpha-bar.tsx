import { Info } from "lucide-react";

import { BUILD, prereleaseLabel } from "@/lib/build";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface AlphaBarProps {
  /** Defaults to this bundle's own build version; injectable so tests don't have to fake the define. */
  version?: string;
  className?: string;
}

// The prerelease marker: a thin amber strip across the top of the one AppHeader, saying which
// non-stable build you are looking at. It exists because a v1 alpha runs BESIDE the stable install on
// its own origin — same dog, same layout, different machine-eating capabilities — and "which tab is
// which" cannot be left to the operator's memory of a port number.
//
// Zero config: it keys off the version already baked into THIS bundle (lib/build.ts, a vite `define`)
// and renders only when that version carries a SemVer prerelease tag. A stable build has no tag, so
// prereleaseLabel returns undefined and this component is nothing at all — no flag, no fetch, no
// setting to forget to turn off.
//
// Colours are the shared `status-info` sky token, which is declared with `light-dark()` in
// index.css and therefore already correct under both themes — hence NO `dark:` variants here. Sky
// rather than the `status-working` amber deliberately: this strip isn't a warning, just a calm
// "you're on the prerelease build" fact. The treatment (border-b + /15 wash + solid token text) is
// deliberately the ReadOnlyBanner's, so the app's two "this session is not normal" strips read as
// one family.
export function AlphaBar({ version = BUILD.version, className }: AlphaBarProps) {
  useLocale();
  const label = prereleaseLabel(version);
  if (!label) return null;
  return (
    <div
      // Not role="status": this never changes after mount, and announcing it as a live region would
      // re-read it over every header update. It's a static line of text screen readers reach in order.
      title={t("nav.prereleaseTitle", { version })}
      className={cn(
        // One short line, py-0.5 + 11px text ⇒ ~20px tall, and it lives INSIDE the sticky header's
        // safe-area padding (see app-header.tsx), so it costs the pane mirror one line of height and
        // shifts nothing sideways. min-w-0 + truncate so a long tag can never widen the header.
        "flex min-w-0 items-center justify-center gap-1.5 border-b border-status-info/40" +
          " bg-status-info/15 px-3 py-0.5 text-[11px] font-medium leading-tight text-status-info",
        className,
      )}
    >
      <Info className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate tracking-wide">
        {label} <span aria-hidden="true">·</span> <span className="font-mono">{version}</span>
      </span>
    </div>
  );
}
