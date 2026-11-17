import { ImageSheet } from "@/components/ui/image-sheet";
import { imageSrc } from "@/lib/api";
import { useAuthedUrl } from "@/lib/authed-url";
import type { Scope } from "@/lib/scope";

/**
 * One image out of the journal: a picture an agent attached, spoke, or a tool returned.
 *
 * A tap opens it at full size in a sheet (`ImageSheet`), the same affordance the mirror's image card
 * has, and the only way to see a screenshot at full size on a phone.
 *
 * `imageSrc` decides whether the reference is loadable AT ALL (`lib/api.ts`): a blob path on the
 * host the pane belongs to, or inline bytes, and nothing else. A journal is an agent's own output,
 * so a reference it refuses renders nothing rather than a broken image. While the bytes load, a quiet
 * box of `PagerPicture`'s height holds the place (a picture's size is not on the wire).
 */
export function JournalImage({
  ref_,
  alt,
  scope,
}: {
  ref_: string;
  alt: string;
  scope?: Scope;
}) {
  // Vetted first, then loaded with the pairing token (lib/authed-url.ts): reads need it (ADR 0086),
  // and an `<img src>` cannot send it. A picture the page already fetched is there on the first
  // render (the resolved map in that module).
  const src = imageSrc(ref_, scope);
  const { url, failed } = useAuthedUrl(src);
  // A reference `imageSrc` refuses, or a load that failed, draws nothing, as it always did: the
  // reserve below is only for a picture that is on its way, so no empty band can stay behind.
  if (src === null || failed) return null;
  // THE RESERVE, WHILE THE BYTES COME. The wire carries no width or height, so the box is the
  // `PagerPicture` one (`h-40`, hill-media.tsx): the line under it does not jump by the whole
  // picture's height when the bytes land. It is replaced by the picture, never kept beside it.
  if (url === null) return <span aria-hidden data-slot="journal-image-reserve" className="block h-40 w-full" />;
  return (
    <ImageSheet
      src={url}
      alt={alt}
      title={alt}
      imgClassName="max-h-96 w-auto max-w-full rounded border object-contain shadow-xs"
    />
  );
}
