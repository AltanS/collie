// The resolver's verdict on a top-frame answer (S3, islands/resolver.ts): pure, so it is tested alone.

/** The bridge stamps every islands document with this (bridge/http/controllers/document.ts). */
export const DOCUMENT_MARK_HEADER = "x-collie-document";
export const DOCUMENT_MARK = "islands";
const BUILD_HEADER = "x-collie-build";

/** Why a top-frame answer was refused, for the e2e and the console. */
export type Refusal = "status" | "not-a-document" | "build-skew" | "network";

/** Null when the answer is this build's islands document (a 4xx one too), else why it is refused. */
export function refusalOf(response: Pick<Response, "status" | "headers">, runningBuild: string): Refusal | null {
  if (response.status >= 500) return "status";
  if (response.headers.get(DOCUMENT_MARK_HEADER) !== DOCUMENT_MARK) return "not-a-document";
  const build = response.headers.get(BUILD_HEADER);
  if (build === null || build !== runningBuild) return "build-skew";
  return null;
}
