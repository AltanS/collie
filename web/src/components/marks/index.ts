import type { ComponentType } from "react";

import type { ShippedMark } from "@/lib/shipped-marks";

import { CollieMarkAdapter } from "./collie";
import { HarbourMark } from "./harbour";
import type { MarkProps } from "./contract";

export type { MarkProps, MarkState } from "./contract";

/**
 * Every shipped mark, by id. Static: no dynamic import, no network, so the mark is in the bundle the
 * header paints with. The three new ids draw the dog until their marks land (M57 spec 10), so a theme
 * that names one is never left without a mark.
 */
export const MARKS = {
  collie: CollieMarkAdapter,
  nightwatch: CollieMarkAdapter,
  daylight: CollieMarkAdapter,
  harbour: HarbourMark,
} satisfies Record<ShippedMark, ComponentType<MarkProps>>;
