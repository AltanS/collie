import { useState } from "react";
import { createPortal } from "react-dom";

import { BottomSheet } from "@/components/ui/sheet";
import { PICTURE_SHEET, ZoomPicture } from "@/components/ui/zoom-picture";
import { cn } from "@/lib/utils";

/**
 * A picture that opens at full size in a sheet when tapped.
 *
 * NOT a link to the bytes. Inline images are `data:` URLs, and browsers refuse to navigate a top-level
 * window to one, so a link to it opened nothing on any phone; a fetched one is an object URL, which an
 * installed iOS app cannot open in a new window either. The sheet draws the same URL the thumbnail
 * already loaded, and a long-press on it there is the platform's own save and share.
 *
 * In the sheet the picture zooms (`ZoomPicture`): pinch, pan while zoomed, double tap. The panel takes
 * no page zoom from a pinch (`PICTURE_SHEET`).
 *
 * The sheet is portalled to <body>: a mirror card sits inside a <pre>, which allows no <div>, and an
 * ancestor with a transform would otherwise become the containing block of its `fixed` layer.
 */
export function ImageSheet({
  src,
  alt,
  title,
  className,
  imgClassName,
  onError,
}: {
  src: string;
  alt: string;
  title: string;
  className?: string;
  imgClassName?: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={title}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-block cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        <img src={src} alt={alt} className={imgClassName} loading="lazy" onError={onError} />
      </button>
      {open &&
        createPortal(
          <BottomSheet open onClose={() => setOpen(false)} title={title} className={PICTURE_SHEET}>
            <ZoomPicture src={src} alt={alt} />
          </BottomSheet>,
          document.body,
        )}
    </>
  );
}
