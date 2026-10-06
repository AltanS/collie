// The frame every wave-4 route wears: it CLAIMS the Shell's header with `override` (the size-11
// ArrowLeft and the h1 take the place of the Collie mark, REMIX3.md rule 6; DESIGN.md §6), releases
// it when the route unmounts, and draws one scrolling column under it. A route never draws a header.
//
//   <Frame title={t("crew.title")} backLabel={t("crew.back")} up={settingsPath(scope)}>…</Frame>
//
// `up` is the structural parent, scope included; back steps back when the entry behind is a
// legitimate parent and replaces otherwise (ADR 0067, `up.ts`). It is read at tap time from
// `handle.props`, so a claim carries callbacks made ONCE in setup (header-model.ts).
//
// The column keeps its own scroll spot per URL (`scrollMemory`, REMIX3.md "Scroll"). A route with
// two scrollers, or one that wants a different key, passes `scrollKey`.
import { type Handle, type RemixNode } from "remix/component";

import { t, type MessageKey } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { scrollMemory } from "../../lib/scroll";
import { headerOf } from "../../shell/context";
import type { HeaderWidth } from "../../shell/header-model";
import { goUp } from "./up";

const COLUMN = {
  column: "mx-auto w-full max-w-screen-sm",
  wide: "mx-auto w-full max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]",
  full: "w-full",
} as const satisfies Record<HeaderWidth, string>;

export interface FrameProps {
  /** The h1, already translated (a machine's name is not a dictionary key). */
  title: string;
  /** The back arrow's accessible name. Defaults to "Back". */
  backLabel?: string;
  /** Where up lands when nothing legitimate is behind: a root-relative path, scope included. */
  up: string;
  width?: HeaderWidth;
  /** One scroll spot per URL by default; a route whose one URL has several views passes a key. */
  scrollKey?: string;
  /** Extra classes for the scroll column (the default is the card column, `space-y-4 p-4`). */
  class?: string;
  children?: RemixNode;
}

export function Frame(handle: Handle<FrameProps>) {
  useLocale(handle);
  const header = headerOf(handle).owner(handle.signal);
  const onBack = (): void => goUp(handle.props.up);
  return () => {
    const { title, backLabel, width = "column", scrollKey, children } = handle.props;
    const back = backLabel ?? t("settings.nav.back" satisfies MessageKey);
    handle.queueTask(() => header.claim({ override: { title, backLabel: back, onBack }, width }));
    return (
      <div class={cn("flex min-h-0 w-full flex-1 flex-col", COLUMN[width])}>
        <main
          data-testid="route-main"
          class={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto", handle.props.class ?? "space-y-4 p-4")}
          mix={scrollMemory(scrollKey)}
        >
          {children}
        </main>
      </div>
    );
  };
}
