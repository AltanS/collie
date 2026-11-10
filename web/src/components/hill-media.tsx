import { useState } from "react";

import { Icon } from "@/components/icons/icon";
import { FocusFrame, FocusImage } from "@/components/ui/focus-image";
import { ImageStrip, ImageStripItem, stripSize, type StripSize } from "@/components/ui/image-strip";
import { PagerSheet } from "@/components/ui/pager-sheet";
import { useLocale } from "@/hooks/use-locale";
import { useNearScreen } from "@/hooks/use-near-screen";
import { useAuthedUrl } from "@/lib/authed-url";
import { hillMediaPath, type HillMedia } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import type { ViewPictureDraw, ViewPictures } from "@/lib/tricks/render";

// THE IMAGES OF A DECISION (M96).
//
// An agent may attach up to four images to a Decision. The card shows all of them under the summary,
// in the poster's order, as one row at one height that scrolls sideways (`ui/image-strip.tsx`), each
// with its caption under it. The height comes from the images' shapes on the wire (`stripSize`): a row
// of phone screenshots is tall enough to read, a row with a wide shot keeps the short height, and a
// single image may use the card's width. A tap on an image opens it at full size in the app's own picture sheet
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
//
// AN IMAGE THE VIEW PLACES (2026-11-10). A Decision's view may set one of these images among its facts,
// cropped (`image` with a `ref`), or two side by side (`compare`). The renderer lays out the frame
// (lib/tricks/render.tsx); this file hands it the bytes the same way (`viewPictures`), and a tap opens
// the picture at full size in a sheet that pages through the frames' set (`PagerSheet`). The card leaves
// such an image out of the row above, so it is not shown twice.

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
function StripImage({ src, media, index, count, near, size }: { src: string; media: HillMedia; index: number; count: number; near: boolean; size: StripSize }) {
  const { url, failed, onError } = useImage(src, near);
  return (
    <ImageStripItem
      width={media.width}
      height={media.height}
      size={size}
      single={count === 1}
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
  const size = stripSize(media);
  return (
    <ImageStrip ref={ref} label={t("hill.media.label")} className={className} scrollerClassName={scrollerClassName}>
      {media.map((item, index) => (
        <StripImage key={`${index}:${item.id}`} src={source(decisionId, item)} media={item} index={index} count={media.length} near={near} size={size} />
      ))}
    </ImageStrip>
  );
}

/** One picture at full size in the pager: its own fetch, from the cache the frame already filled. */
function PagerPicture({ src, alt }: { src: string; alt: string }) {
  const { url, failed } = useAuthedUrl(src);
  if (failed) return <Unavailable />;
  if (url === null) return <span aria-hidden className="block h-40 w-full" />;
  return <img src={url} alt={alt} className="mx-auto h-auto max-h-[70dvh] w-auto max-w-full rounded" />;
}

/** A frame a Decision's view placed: the picture cropped in it, near the screen only; a tap opens the pager on it. */
function ViewPictureFrame({ decisionId, media, source, draw }: { decisionId: string; media: readonly HillMedia[]; source: HillMediaSource; draw: ViewPictureDraw }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(draw.index);
  const { ref, near } = useNearScreen();
  const item = media[draw.refs[draw.index] ?? -1];
  const { url, failed, onError } = useImage(item === undefined ? "" : source(decisionId, item), near && item !== undefined);
  if (item === undefined) return null;
  const altAt = (i: number) => {
    const place = draw.refs[i] ?? 0;
    const at = media[place];
    return at === undefined ? "" : altOf(at, place, media.length);
  };
  const alt = altAt(draw.index);
  const shown = media[draw.refs[page] ?? -1];
  return (
    <span ref={ref} className="block min-w-0" style={draw.width === undefined ? undefined : { width: draw.width }}>
      <FocusFrame
        ratio={draw.ratio}
        maxHeight={draw.maxHeight}
        label={t("hill.media.open", { name: alt })}
        onOpen={() => {
          setPage(draw.index);
          setOpen(true);
        }}
      >
        {failed ? <Unavailable /> : url === null ? null : <FocusImage src={url} alt={alt} fit={draw.fit} crop={draw.crop} onError={onError} />}
      </FocusFrame>
      <PagerSheet
        open={open && shown !== undefined}
        onClose={() => setOpen(false)}
        title={altAt(page)}
        index={page}
        count={draw.refs.length}
        onIndex={setPage}
        prevLabel={t("hill.media.prev")}
        nextLabel={t("hill.media.next")}
        position={t("hill.media.position", { index: page + 1, count: draw.refs.length })}
      >
        {shown !== undefined && <PagerPicture key={shown.id} src={source(decisionId, shown)} alt={altAt(page)} />}
      </PagerSheet>
    </span>
  );
}

/** The Decision's images as a view's `image` and `compare` read them: each one's shape and words, and its frame. */
export function viewPictures(decisionId: string, media: readonly HillMedia[], source: HillMediaSource = hillMediaSource): ViewPictures {
  return {
    at: (ref) => {
      const item = media[ref];
      return item === undefined ? undefined : { width: item.width, height: item.height, alt: altOf(item, ref, media.length) };
    },
    draw: (draw) => <ViewPictureFrame decisionId={decisionId} media={media} source={source} draw={draw} />,
  };
}
