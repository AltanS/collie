import { cn } from "@/lib/utils";

// One picture out of an agent's journal, framed, with a line that says where it came from.
//
// A placeholder cluster inside the mirror's <pre> shows its picture through this card
// (components/ansi-output.tsx). Every element is a <span> (block where it must be), because a <pre>
// does not allow a <div>.
//
// The card is an ANCHOR to the bytes, so it is keyboard reachable and long-pressable, and it is the
// only way to see a picture at full size on a phone. `src` must be a URL `imageSrc` already vetted
// (`lib/api.ts`): a blob path on the owning host, or inline bytes, never a URL out of the agent's log.
//
// The caption says what the card is and is Collie's own words, so the caller translates it. It is
// also the anchor's tooltip: a pointer that hovers the picture asks about the picture, and the
// caption may be scrolled out of the tap target.
export function ImageCard({
  src,
  alt,
  caption,
  onError,
  className,
}: {
  src: string;
  alt: string;
  caption: string;
  /** A load that fails. The caller decides what stands in, for example the "[Image]" badge. */
  onError?: () => void;
  className?: string;
}) {
  return (
    <span
      data-slot="image-card"
      className={cn(
        "my-2 block select-none overflow-hidden rounded-md border border-border/40 bg-black/20 text-center",
        className,
      )}
    >
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        title={caption}
        className="inline-block cursor-zoom-in"
      >
        <img
          src={src}
          alt={alt}
          className="mx-auto max-h-80 w-auto max-w-full rounded object-contain"
          loading="lazy"
          onError={onError}
        />
      </a>
      <span className="block px-2 pb-1 text-xs text-muted-foreground">{caption}</span>
    </span>
  );
}
