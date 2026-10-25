import { imageSrc } from "@/lib/api";
import { useAuthedUrl } from "@/lib/authed-url";
import type { Scope } from "@/lib/scope";

/**
 * One image out of the journal: a picture an agent attached, spoke, or a tool returned.
 *
 * It is an ANCHOR to the bytes, not a bare `<img>`. That is what makes it keyboard reachable and
 * long-pressable — the same affordance the mirror's image card has — and it is the only way to see
 * a screenshot at full size on a phone.
 *
 * `imageSrc` decides whether the reference is loadable AT ALL (`lib/api.ts`): a blob path on the
 * host the pane belongs to, or inline bytes, and nothing else. A journal is an agent's own output,
 * so a reference it refuses renders nothing rather than a broken image.
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
  // and an `<img src>` cannot send it. Nothing is drawn until the bytes are here.
  const { url } = useAuthedUrl(imageSrc(ref_, scope));
  if (url === null) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block cursor-zoom-in">
      <img
        src={url}
        alt={alt}
        className="max-h-96 w-auto max-w-full rounded border object-contain shadow-xs"
        loading="lazy"
      />
    </a>
  );
}
