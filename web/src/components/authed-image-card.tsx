import { type ComponentProps, useEffect, useRef } from "react";

import { ImageCard } from "@/components/ui/image-card";
import { useAuthedUrl } from "@/lib/authed-url";

// The journal picture card, with its bytes loaded WITH the pairing token (ADR 0086: reads need it).
//
// `ImageCard` (ui/) draws a URL it is given and fetches nothing, which is the primitive's contract.
// The picture's `src` is a vetted `/api/blobs/...` path (`imageSrc` in lib/api.ts), and an `<img src>`
// cannot send an `Authorization` header, so this wrapper turns the path into an object URL first
// (lib/authed-url.ts) and hands that to the card. Nothing is drawn while the bytes are on their way;
// a load the bridge refuses reports through `onError`, exactly as a broken `<img>` did.
export function AuthedImageCard({ src, onError, ...rest }: ComponentProps<typeof ImageCard>) {
  const { url, failed } = useAuthedUrl(src);
  // `onError` is the caller's inline closure, new every render, so it rides a ref: the failure is
  // what changed, and it is reported once.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (failed) onErrorRef.current?.();
  }, [failed]);
  if (url === null) return null;
  return <ImageCard {...rest} src={url} onError={onError} />;
}
