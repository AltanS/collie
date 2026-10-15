import type { ComponentType } from "react";

import type { ShippedMark } from "@/lib/shipped-marks";

import { CollieMarkAdapter } from "./collie";
import type { MarkProps } from "./contract";
import { DaylightMark } from "./daylight";
import { HarbourMark } from "./harbour";
import { NightwatchMark } from "./nightwatch";

export type { MarkProps, MarkState } from "./contract";

/**
 * Every shipped mark, by id. Static: no dynamic import, no network, so the mark is in the bundle the
 * header paints with. Each shipped theme names its own id; an imported theme that names none gets the dog.
 */
export const MARKS = {
  collie: CollieMarkAdapter,
  nightwatch: NightwatchMark,
  daylight: DaylightMark,
  harbour: HarbourMark,
} satisfies Record<ShippedMark, ComponentType<MarkProps>>;
