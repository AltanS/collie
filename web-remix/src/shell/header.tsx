// THE ONE HEADER (web/src/components/app-header.tsx), mounted once by the Shell above the route
// outlet, drawn from the route's claim (`header-model.ts`). REMIX3.md, "The header is a claim":
//
//   - sticky, z-20, page colour with a 1 px rule (recoloured transparent in zen, never removed);
//   - the row has a 60 px FLOOR (`min-h-15`), never a height, with `pl-4 pr-2 py-1 gap-2`;
//   - width from the claim: `column` (640) or `wide` (768 → 1400 ladder) or `full`;
//   - the Collie mark in the same place on every route, never remounted: it is hidden (`invisible`,
//     out of flow) while a route overrides the row, and zen keeps the row mounted at 0fr;
//   - the identity ("Collie" eyebrow over "on <mux logo> <mux>", the mux line reserving `min-h-6`)
//     is hidden with `invisible` off the wordmark routes, so the logo <img> never remounts;
//   - HeaderStatus takes the title slot for 2.5 s with no animation; errors persist;
//   - the safe-area inset is reserved ONCE: here while the strip band is closed, by the band while
//     open, handed over on the band's own 240 ms (`transition-[padding-top]`).
//
// The host subscribes to the header model, the strip model (for the inset alone) and the locale.
// Nothing else: the mux line and the status slot are their own components with their own stores.
import { on, type Handle, type RemixNode } from "remix/component";
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, EllipsisVertical, Info, Settings, X } from "lucide";

import { t } from "@web/lib/i18n";
import { mounted } from "@web/lib/base-path";
import { homePath, settingsPath } from "@web/lib/nav";
import { cn } from "@web/lib/utils";

import { navigate } from "../lib/navigate";
import { address, config } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { clearStatus, status, type StatusTone } from "../lib/status";
import { scheduleUpdate, useStore } from "../lib/store";
import { href } from "../routes";
import { BottomSheet } from "../ui/sheet";
import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";
import { SectionLabel } from "../ui/section-label";
import { CollieHome } from "./collie-mark";
import { headerOf, stripsOf } from "./context";
import type { HeaderCenter, HeaderOverride, HeaderRight, OverrideGlide, ResolvedClaim } from "./header-model";
import { noteInAppBack } from "./screen-transition";

const WIDTH = {
  column: "mx-auto w-full max-w-screen-sm",
  wide: "mx-auto w-full max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]",
  full: "w-full",
} as const;

/** The title slot shows the status on a route that claims a center and keeps the row. */
export function headerShowsStatus(claim: ResolvedClaim): boolean {
  return claim.center !== null && claim.override === null && !claim.hidden;
}

export function HeaderHost(handle: Handle) {
  const model = headerOf(handle);
  const strips = stripsOf(handle);
  useLocale(handle);
  let seen = model.current;
  let band = strips.open;
  handle.queueTask(() => {
    model.addEventListener("change", () => scheduleUpdate(handle), { signal: handle.signal });
    strips.addEventListener(
      "change",
      () => {
        if (strips.open !== band) scheduleUpdate(handle);
      },
      { signal: handle.signal },
    );
    // A claim that landed between setup and this first task.
    if (model.current !== seen || strips.open !== band) scheduleUpdate(handle);
  });

  // Read at tap time: the claim's callback, or home. The mark's tap from a pane IS the in-app back
  // arrow, so it is the one move the screen slide and the glide play in reverse.
  const onHome = (): void => {
    const go = model.current.home;
    if (go !== null) {
      noteInAppBack();
      go();
      return;
    }
    const path = homePath(address.get().scope);
    if (`${window.location.pathname}${window.location.search}` === mounted(path)) return;
    void navigate(href(path));
  };

  return () => {
    const claim = model.current;
    seen = claim;
    band = strips.open;
    const override = claim.override;
    return (
      <header
        data-slot="app-header"
        translate="no"
        data-width={claim.width}
        class={cn(
          "sticky top-0 z-20 flex shrink-0 flex-col border-b bg-background",
          "transition-[padding-top] duration-[240ms] ease-out motion-reduce:transition-none",
          !band && "[padding-top:env(safe-area-inset-top)]",
          claim.hidden ? "border-transparent" : "border-rule",
          WIDTH[claim.width],
        )}
      >
        <Collapse open={!claim.hidden} keep>
          <div data-slot="header-row" class="relative flex min-h-15 items-center gap-2 py-1 pr-2 pl-4">
            <div
              data-slot="header-lead"
              class={cn("flex min-w-0 items-center gap-2", override !== null && "invisible absolute")}
              inert={override !== null ? true : undefined}
            >
              <CollieHome onActivate={onHome} label={claim.homeLabel === "" ? undefined : claim.homeLabel} />
              <div data-slot="header-identity" class={cn("relative min-w-0", !claim.wordmark && "invisible absolute")}>
                <SectionLabel class="absolute bottom-full left-0 max-w-full truncate leading-none">Collie</SectionLabel>
                <MuxLine />
              </div>
            </div>
            {override === null ? (
              <>
                <div data-slot="header-center" class="flex min-w-0 flex-1 items-center">
                  {claim.center === null ? null : headerShowsStatus(claim) ? (
                    <HeaderStatus>{center(claim.center)}</HeaderStatus>
                  ) : (
                    center(claim.center)
                  )}
                </div>
                <div data-slot="header-right" class="flex items-center gap-1">
                  {claim.right === null ? null : right(claim.right)}
                </div>
              </>
            ) : (
              <OverrideRow override={override} />
            )}
          </div>
        </Collapse>
      </header>
    );
  };
}

function center(slot: HeaderCenter): RemixNode {
  return slot.render();
}

function right(slot: HeaderRight): RemixNode {
  if (slot.kind === "custom") return slot.render();
  return (
    <div class="flex items-stretch gap-2 pr-3">
      {slot.onOpen ? (
        <button
          type="button"
          data-testid="header-menu"
          aria-label={slot.label}
          class="grid min-h-11 w-11 shrink-0 place-items-center self-stretch rounded-md text-muted-foreground transition-colors active:bg-muted/60 active:text-foreground"
          mix={on("click", () => slot.onOpen?.())}
        >
          <Icon icon={EllipsisVertical} class="size-5" />
        </button>
      ) : (
        <div class="w-11 shrink-0" />
      )}
    </div>
  );
}

/** "on <mux logo> <mux>", reserved at one line (`min-h-6`) before /api/config lands. */
export function MuxLine(handle: Handle) {
  const cfg = useStore(handle, config);
  useLocale(handle);
  return () => {
    const mux = cfg().data?.mux;
    const name = mux?.name ?? "";
    const logo = mux?.logoUrl ? mounted(mux.logoUrl) : "";
    return (
      <span data-slot="header-mux" class="block min-h-6 truncate text-base">
        {name !== "" ? (
          <>
            {t("nav.mux.onPrefix")}{" "}
            {logo !== "" ? <img src={logo} alt="" class="mr-1 inline-block size-[1.15em] align-[-0.2em]" /> : null}
            {name}
          </>
        ) : null}
      </span>
    );
  };
}

function OverrideRow(handle: Handle<{ override: HeaderOverride }>) {
  return () => {
    const { title, subtitle = "", backLabel, trailing, glide } = handle.props.override;
    return (
      <>
        <button
          type="button"
          data-testid="header-back"
          aria-label={backLabel}
          class="grid size-11 shrink-0 place-items-center rounded-md text-foreground active:bg-muted/60"
          mix={on("click", () => {
            noteInAppBack();
            handle.props.override.onBack();
          })}
        >
          <Icon icon={ArrowLeft} class="size-5" />
        </button>
        {subtitle === "" ? (
          <h1 class="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
        ) : (
          <div data-slot="header-title" data-glide-destination={glide?.pair} class="min-w-0 flex-1">
            <h1 class="truncate text-lg leading-tight font-semibold tracking-tight">{title}</h1>
            <div data-slot="header-subtitle" class="h-[0.9375rem] truncate text-xs leading-tight text-muted-foreground">
              {subtitleLine(subtitle, glide)}
            </div>
          </div>
        )}
        {trailing ? trailing.render() : null}
      </>
    );
  };
}

/**
 * The subtitle, with a glide's label drawn as its own box when the subtitle leads with it: the part
 * that flies needs a box shaped like its text (web/'s `max-w-full truncate` span), and the rest of
 * the line follows it unchanged.
 */
function subtitleLine(subtitle: string, glide: OverrideGlide | undefined): RemixNode {
  if (glide === undefined || glide.label === "" || !subtitle.startsWith(glide.label)) return subtitle;
  return (
    <>
      <span data-glide="label" class="inline-block max-w-full truncate align-top">
        {glide.label}
      </span>
      {subtitle.slice(glide.label.length)}
    </>
  );
}

const TONE = {
  info: "text-muted-foreground",
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
} satisfies Record<StatusTone, string>;

const TONE_ICON = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: AlertCircle } as const;

/**
 * web/src/components/header-status.tsx: while a status is live it takes the title slot, in the same
 * `min-h-11` box, with no animation. An error persists: its text opens the whole message, its ✕
 * clears it in one tap.
 */
function HeaderStatus(handle: Handle<{ children?: RemixNode }>) {
  const read = useStore(handle, status);
  useLocale(handle);
  let detailFor = 0;
  return () => {
    const message = read();
    if (message === null) return handle.props.children;
    const error = message.tone === "error";
    const open = detailFor === message.id;
    return (
      <div key={message.id} data-slot="header-status" class="relative flex min-h-11 min-w-0 flex-1 items-center">
        <output aria-live="polite" class={cn("flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold", TONE[message.tone])}>
          <Icon icon={TONE_ICON[message.tone]} class="size-4 shrink-0" />
          <span class="truncate">{message.text}</span>
        </output>
        {error ? (
          <>
            <button
              type="button"
              aria-label={t("status.detailAria")}
              class="absolute inset-0 rounded-lg"
              mix={on("click", () => {
                detailFor = message.id;
                void handle.update();
              })}
            />
            <button
              type="button"
              aria-label={t("status.dismissAria")}
              class="relative flex size-11 shrink-0 items-center justify-center rounded-lg"
              mix={on("click", () => clearStatus())}
            >
              <Icon icon={X} class="size-4 opacity-70" />
            </button>
            <BottomSheet
              open={open}
              onClose={() => {
                detailFor = 0;
                void handle.update();
              }}
            >
              <p class="text-sm break-words whitespace-pre-wrap">{message.detail ?? message.text}</p>
            </BottomSheet>
          </>
        ) : null}
      </div>
    );
  };
}

/**
 * The Settings gear (web/'s SettingsGear): a real 44 px box, scope kept, a push down one level.
 * Shared so the dashboard and space claims do not each hand-roll it.
 */
export function SettingsGear(handle: Handle) {
  useLocale(handle);
  return () => (
    <button
      type="button"
      data-testid="settings-gear"
      aria-label={t("nav.settings.aria")}
      class="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
      mix={on("click", () => void navigate(href(settingsPath(address.get().scope))))}
    >
      <Icon icon={Settings} class="size-5" />
    </button>
  );
}
