import { useState } from "react";

import { Icon } from "@/components/icons/icon";
import { ImageStrip, ImageStripItem } from "@/components/ui/image-strip";
import { useLocale } from "@/hooks/use-locale";
import { useNearScreen } from "@/hooks/use-near-screen";
import { useAuthedUrl } from "@/lib/authed-url";
import { hillMediaPath, type HillMedia } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";

// THE IMAGES OF A DECISION (M96).
//
// An agent may attach up to four images to a Decision. The card shows all of them under the summary,
// in the poster's order, as one row at one height that scrolls sideways (`ui/image-strip.tsx`), each
// with its caption under it. A tap on an image opens it at full size in the app's own picture sheet
// (`ImageSheet`, the one a journal picture in Chat opens), so there is no zoom of the hill's own.
//
// THE BYTES COME WITH THE PAIRING TOKEN. Reads need it (ADR 0086), and an `<img src>` to an `/api`
// route cannot carry it, so the route is fetched through `useAuthedUrl` and drawn from the object URL
// it hands back, as a journal picture is. A load that fails, at the fetch or at the decode, shows a
// quiet placeholder with "Image not available" in the image's own box.
//
// AN IMAGE IS FETCHED ONLY NEAR THE SCREEN (hooks/use-near-screen.ts): within one screen height of the
// visible part. The ROW is what is watched, not each image: the row scrolls on its own, and an observer
// rooted in it would call every image in it visible however far the card is from the screen. Until the
// row comes near, each image's box is reserved and empty, as it is while the fetch runs, so nothing moves.

/** Where an image's bytes are: the bridge's route by default; the playground hands in its own. */
export type HillMediaSource = (decisionId: string, media: HillMedia) => string;

export const hillMediaSource: HillMediaSource = (decisionId, media) => hillMediaPath(decisionId, media.id);

/** The image's own words, or "Image 2 of 3". */
function altOf(media: HillMedia, index: number, count: number): string {
  return media.caption ?? t("hill.media.alt", { index: index + 1, count });
}

/** The stand-in for an image that did not load. Quiet: muted words on the same surface. */
function Unavailable() {
  return (
    <span data-slot="hill-media-unavailable" className="flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
      <Icon name="image" aria-hidden className="size-4" />
      {t("hill.media.unavailable")}
    </span>
  );
}

/** What an image slot draws: the URL, or null while it loads, and whether the fetch or the decode failed. */
interface ImageLoad {
  url: string | null;
  failed: boolean;
  onError: () => void;
}

/** The bytes are fetched only once `near` is true: the slot's own box is reserved before and after, so the page does not move. */
function useImage(src: string, near: boolean): ImageLoad {
  const { url, failed } = useAuthedUrl(near ? src : null);
  const [broken, setBroken] = useState<string | null>(null);
  return { url, failed: failed || (url !== null && broken === url), onError: () => setBroken(url) };
}

/** One image of the row: its box from its known size, the picture once loaded, the placeholder if it failed. */
function StripImage({ src, media, index, count, near }: { src: string; media: HillMedia; index: number; count: number; near: boolean }) {
  const { url, failed, onError } = useImage(src, near);
  return (
    <ImageStripItem
      width={media.width}
      height={media.height}
      src={failed ? null : url}
      alt={altOf(media, index, count)}
      caption={media.caption}
      fallback={failed ? <Unavailable /> : null}
      onError={onError}
    />
  );
}

/**
 * Every image of a decision, in order, as one sideways row. `className` and `scrollerClassName` let the
 * row run to the card's edge (a negative margin and the matching padding).
 */
export function HillImageStrip({
  decisionId,
  media,
  source = hillMediaSource,
  className,
  scrollerClassName,
}: {
  decisionId: string;
  media: readonly HillMedia[];
  source?: HillMediaSource;
  className?: string;
  scrollerClassName?: string;
}) {
  useLocale();
  const { ref, near } = useNearScreen();
  return (
    <ImageStrip ref={ref} label={t("hill.media.label")} className={className} scrollerClassName={scrollerClassName}>
      {media.map((item, index) => (
        <StripImage key={`${index}:${item.id}`} src={source(decisionId, item)} media={item} index={index} count={media.length} near={near} />
      ))}
    </ImageStrip>
  );
}
