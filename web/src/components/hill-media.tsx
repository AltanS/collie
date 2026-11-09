import { useState } from "react";

import { Icon } from "@/components/icons/icon";
import { ImageSheet } from "@/components/ui/image-sheet";
import { useLocale } from "@/hooks/use-locale";
import { useAuthedUrl } from "@/lib/authed-url";
import { hillMediaPath, type HillMedia } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE IMAGES OF A DECISION (M96).
//
// An agent may attach up to four images to a Decision. The card shows the first one under the summary,
// at most 200px high and whole (object-fit contain) on the card's muted surface, with a "1 / 3" mark
// when there are more; a tap on it opens the card's body, which shows every image at the column's
// width with its caption, in the poster's order. A tap on an image there opens it at full size in the
// app's own picture sheet (`ImageSheet`, the one a journal picture in Chat opens), so there is no
// zoom of the hill's own.
//
// THE BYTES COME WITH THE PAIRING TOKEN. Reads need it (ADR 0086), and an `<img src>` to an `/api`
// route cannot carry it, so the route is fetched through `useAuthedUrl` and drawn from the object URL
// it hands back, as a journal picture is. A load that fails, at the fetch or at the decode, shows a
// quiet placeholder with "Image not available" in the image's place, the same height on the card.

/** Where an image's bytes are: the bridge's route by default; the playground hands in its own. */
export type HillMediaSource = (decisionId: string, media: HillMedia) => string;

export const hillMediaSource: HillMediaSource = (decisionId, media) => hillMediaPath(decisionId, media.id);

/** The image's own words, or "Image 2 of 3". */
function altOf(media: HillMedia, index: number, count: number): string {
  return media.caption ?? t("hill.media.alt", { index: index + 1, count });
}

/** The stand-in for an image that did not load. Quiet: muted words on the same surface. */
function Unavailable({ className }: { className?: string }) {
  return (
    <span data-slot="hill-media-unavailable" className={cn("flex items-center justify-center gap-2 text-xs text-muted-foreground", className)}>
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

function useImage(src: string): ImageLoad {
  const { url, failed } = useAuthedUrl(src);
  const [broken, setBroken] = useState<string | null>(null);
  return { url, failed: failed || (url !== null && broken === url), onError: () => setBroken(url) };
}

/** The first image on the card. A tap opens the body; `count` above one adds the "1 / n" mark. */
export function HillCardImage({ src, media, count, onOpen }: { src: string; media: HillMedia; count: number; onOpen: () => void }) {
  useLocale();
  const { url, failed, onError } = useImage(src);
  return (
    <button
      type="button"
      data-slot="hill-card-image"
      aria-label={t("hill.media.open")}
      onClick={onOpen}
      className="relative flex h-[200px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {failed ? (
        <Unavailable />
      ) : url !== null ? (
        <img src={url} alt={altOf(media, 0, count)} onError={onError} className="max-h-full max-w-full object-contain" />
      ) : null}
      {count > 1 && (
        <span data-slot="hill-media-count" className="absolute right-2 top-2 rounded-sm bg-background/85 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-foreground">
          {t("hill.media.count", { index: 1, count })}
        </span>
      )}
    </button>
  );
}

/** One image in the body: the column's width, its caption under it; a tap opens the picture sheet. */
function BodyImage({ src, media, index, count }: { src: string; media: HillMedia; index: number; count: number }) {
  const { url, failed, onError } = useImage(src);
  const alt = altOf(media, index, count);
  return (
    <figure data-slot="hill-body-image" className="flex flex-col gap-1">
      {failed ? (
        <Unavailable className="h-24 rounded-md border border-border bg-muted/30" />
      ) : url !== null ? (
        <ImageSheet src={url} alt={alt} title={alt} className="block w-full" imgClassName="h-auto w-full rounded-md border border-border bg-muted/30" onError={onError} />
      ) : (
        <span className="block h-24 rounded-md border border-border bg-muted/30" />
      )}
      {media.caption !== undefined && <figcaption className="font-content break-words text-xs text-muted-foreground">{media.caption}</figcaption>}
    </figure>
  );
}

/** Every image of a decision, in order, as the body view shows them. */
export function HillBodyImages({ decisionId, media, source = hillMediaSource }: { decisionId: string; media: readonly HillMedia[]; source?: HillMediaSource }) {
  useLocale();
  return (
    <div data-slot="hill-body-images" className="flex flex-col gap-3">
      {media.map((item, index) => (
        <BodyImage key={item.id} src={source(decisionId, item)} media={item} index={index} count={media.length} />
      ))}
    </div>
  );
}
