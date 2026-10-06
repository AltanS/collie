// The top band (web/src/components/ui/strip-host.tsx): at most ONE strip above the header, the
// highest priority of those registered in the `StripModel` (`strip-model.ts`, web/'s priority table).
//
//   - The band's height moves only on appear and leave, through `Collapse` (240 ms). A replacement is
//     a 120 ms opacity dissolve inside the open band: every layer shares ONE grid cell (`OneOf`), so
//     the band is as tall as the tallest strip and a swap never changes its height.
//   - On leave, `Collapse` holds the last child, so the departing strip keeps painting while the band
//     closes (web/'s "ghost").
//   - Two live regions exist before anything is announced and never unmount, so a strip appearing is
//     a change WITHIN a region (the classic way a banner is never read is mounting the region and its
//     text in one commit).
//   - The notch is reserved ONCE: by the band (its padding-top) while it is open, by the header while
//     it is closed (`shell/header.tsx` reads `strips.open`).
import type { Handle } from "remix/component";

import { scheduleUpdate } from "../lib/store";
import { Collapse } from "../ui/collapse";
import { OneOf } from "../ui/one-of";
import { stripsOf } from "./context";

export function StripHost(handle: Handle) {
  const strips = stripsOf(handle);
  handle.queueTask(() => {
    strips.addEventListener("change", () => scheduleUpdate(handle), { signal: handle.signal });
    if (strips.open) scheduleUpdate(handle);
  });
  return () => {
    const layers = strips.layers;
    return (
      <div data-slot="strip-band" class="shrink-0">
        <div class="sr-only" role="status" data-slot="strip-live-polite" />
        <div class="sr-only" role="alert" data-slot="strip-live-assertive" />
        <Collapse open={layers.length > 0}>
          {layers.length > 0 ? (
            <OneOf
              active={strips.winner}
              options={layers.map((layer) => ({ key: layer.id, node: layer.entry.render() }))}
              class="[padding-top:env(safe-area-inset-top)]"
              layerClass="transition-opacity duration-[120ms] ease-out motion-reduce:transition-none"
            />
          ) : null}
        </Collapse>
      </div>
    );
  };
}
