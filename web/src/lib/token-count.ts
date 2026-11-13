// A context's token count, written short for the usage row above the belt (components/model-tag.tsx):
// `850`, `222k`, `1.2M`. The row shows it in place of the context percentage when the harness stated no
// window to divide by (.adr/0115, amended 2026-11-13). The bridge's writers compare two counts by this
// same text (cli/usage-store.ts), so a count that would draw the same is not a new write.
//
// No locale: like the percentage beside it, a figure of digits and one ASCII letter, the units Claude
// Code itself writes (`222k tokens`). Below a thousand the plain whole number, below a million whole
// thousands, from there millions with one decimal, `.0` dropped.

/** A token count as the usage row writes it, or null for anything that is not a finite count of zero or more. */
export function formatTokens(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  const whole = Math.round(tokens);
  if (whole < 1000) return String(whole);
  const thousands = Math.round(whole / 1000);
  if (thousands < 1000) return `${String(thousands)}k`;
  const millions = Math.round(whole / 100_000) / 10;
  return `${Number.isInteger(millions) ? String(millions) : millions.toFixed(1)}M`;
}
