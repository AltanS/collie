import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/toast-viewport.tsx: where a transient event floats, bottom dock,
// `z-40` (above chrome, below sheets and the idle lock), taps passing through.
//
// NOT PORTALLED. The React original portals to <body> so no ancestor with a transform or a
// backdrop-filter can capture its `fixed` box. remix/spa owns <body> as its top frame, so there is
// no free node to portal into; the shell keeps such ancestors off the route tree instead
// (shell.tsx). A caller that puts this under a transformed ancestor will see it clipped.
const SHARED = "pointer-events-none z-40 mx-auto w-full max-w-screen-sm px-4";

export function ToastViewport(handle: Handle<{ class?: string; children?: RemixNode }>) {
  return () => (
    <div class={cn(SHARED, "fixed inset-x-0 bottom-0 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]", handle.props.class)}>
      {handle.props.children}
    </div>
  );
}
