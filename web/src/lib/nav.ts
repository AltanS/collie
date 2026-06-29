// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams.
export function panePath(paneId: string): string {
  return `/pane/${encodeURIComponent(paneId)}`;
}
