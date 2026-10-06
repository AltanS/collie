// A journal image reference as a URL this phone may load, or `null` when it is not one (web/src/lib/api.ts
// `imageSrc`, whose module cannot be imported here: it pulls React).
//
// TWO SHAPES, AND NOTHING ELSE: a blob path served by the owning collie (`/api/blobs/<64 hex>`) and an
// inline `data:image/*` payload. A journal is an AGENT's output, so a remote URL in it would have the
// phone call an arbitrary host on the agent's word. Anything unrecognised answers null and renders as no
// image. The blob carries its host: the bytes sit on the machine whose journal named them, so the path
// takes the scope every other per-pane request takes.
import { mounted } from "@web/lib/base-path";
import { normalizeScope, type Scope } from "@web/lib/scope";

const BLOB_REF = /^\/api\/blobs\/[0-9a-f]{64}$/i;

/** The loadable form of a reference, mount not yet applied: pure, so the test needs no document. */
export function imagePath(ref: string, scope?: Scope): string | null {
  if (BLOB_REF.test(ref)) {
    const { host, session } = normalizeScope(scope);
    let out = ref;
    if (host) out += `${out.includes("?") ? "&" : "?"}host=${encodeURIComponent(host)}`;
    if (session) out += `${out.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
    return out;
  }
  return ref.startsWith("data:image/") ? ref : null;
}

/** The `src` to draw: a blob path takes the ADR 0052 mount, inline bytes are the bytes. */
export function imageSrc(ref: string, scope?: Scope): string | null {
  const path = imagePath(ref, scope);
  return path === null || path.startsWith("data:") ? path : mounted(path);
}
