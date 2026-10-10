// One way to copy text, for every copy control. `navigator.clipboard` exists only in a secure context
// (https or localhost), and Collie is often served as plain `http://host:8788` on a tailnet, a supported
// deploy. There the legacy `document.execCommand("copy")` still works from a tap, so it is the fallback.

/** Whether a copy can be attempted here: the async API, or the legacy command. */
export function canCopyText(): boolean {
  if (navigator.clipboard) return true;
  // jsdom and some embedded webviews do not implement the query at all.
  return document.queryCommandSupported?.("copy") === true;
}

/**
 * Copy `text`. Rejects when the browser refuses, so a caller can show the failure honestly. Call it
 * straight from the tap handler: the legacy path runs before the first `await`, still inside the
 * user gesture the browser requires.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  // Off screen and out of the page's layout, and 16px so iOS Safari does not zoom to it.
  field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("copy command refused");
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
  }
}
