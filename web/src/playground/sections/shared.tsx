// Helpers shared by more than one section of the states playground. Split out of app.tsx; see that
// file's header comment for the whole page's rules.

import type { ReactNode } from "react";
import { PhoneFrame } from "../harness";

/**
 * A phone frame that centres itself in its (two-column) card. Route-level components are written for
 * a screen; given a card's width they read as a widget, so they get 390px and their own scrollbar.
 */
export function PhoneFrameCard({ height, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <PhoneFrame height={height}>{children}</PhoneFrame>
    </div>
  );
}
