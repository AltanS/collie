// Delegated actions for server HTML (S3). In an islands document most of the page is server HTML that
// no island hydrates (the dashboard rows, the pane header's identity): no `on()` mixin runs there, so a
// control says WHAT it does in data attributes, and the `gestures` island (islands/gestures.tsx) does
// it from one listener on the document (islands/act-table.ts).
//
//   - `data-act="<name>"` plus `data-a-<arg>="<value>"`: the click does it.
//   - `data-hold-act="<name>"` plus `data-h-<arg>="<value>"`: a long press does it (450 ms, or the
//     context menu), with the fill from 150 ms and the click that ends the hold swallowed, as
//     lib/gestures.ts `longPress` does on an island.
//
// The attributes are drawn ONLY while the bridge renders an islands document (`islandsHtml()`), so the
// static shell's markup is unchanged: there the same component's `on()` mixins do the work.
import { onServer } from "./server-render";

let islands = false;

/** True while the bridge renders an islands document's tree (ssr/islands-document.tsx). */
export function islandsHtml(): boolean {
  return islands && onServer();
}

/** Run `build` (synchronous, inside `withServerRender`) with islands markup on. */
export function withIslandsHtml<T>(build: () => T): T {
  islands = true;
  try {
    return build();
  } finally {
    islands = false;
  }
}

/** An action's arguments, each one `data-<prefix>-<key>` on the element. */
export interface ActArgs {
  [key: string]: string | undefined;
}

/** The attributes an action puts on its element. */
export interface ActAttrs {
  [attribute: string]: string;
}

function attrs(prefix: string, name: string, args: ActArgs | undefined, head: string): ActAttrs {
  const pairs = Object.entries(args ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [[`data-${prefix}-${key}`, value] as const]));
  return Object.fromEntries([[head, name], ...pairs]);
}

/** The click action's attributes, or nothing outside an islands render. */
export function act(name: string, args?: ActArgs): ActAttrs | undefined {
  return islandsHtml() ? attrs("a", name, args, "data-act") : undefined;
}

/** The long press action's attributes, or nothing outside an islands render. */
export function holdAct(name: string, args?: ActArgs): ActAttrs | undefined {
  return islandsHtml() ? attrs("h", name, args, "data-hold-act") : undefined;
}

/** The arguments of an action off its element (`data-a-*` or `data-h-*`). */
export function actArgs(el: HTMLElement, kind: "a" | "h"): ActAttrs {
  const prefix = kind === "a" ? "a" : "h";
  // dataset turns `data-a-pref` into `aPref`.
  const pairs = Object.entries(el.dataset).flatMap(([key, value]) =>
    key.length > 1 && key.startsWith(prefix) && key[1] === key[1]?.toUpperCase() && value !== undefined ? [[key[1].toLowerCase() + key.slice(2), value] as const] : [],
  );
  return Object.fromEntries(pairs);
}
