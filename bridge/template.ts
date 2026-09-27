// ── ONE TEMPLATE FILLER for every English sentence the bridge renders from a catalogue ──────────
//
// Two catalogues put a stable machine code beside an English sentence and send both: the API error
// bodies (`error-codes.ts`) and the push notification titles (`push-titles.ts`). Both spell their
// slots `{name}` — the convention `web/src/lib/i18n/` uses — and both must fill them the same way,
// or the English a phone falls back to would disagree with the English the catalogue promises.

/** The named values a template's `{slot}`s are filled from. */
export type TemplateDetail = Readonly<Record<string, string | number>>;

/**
 * Fill `{name}` slots from `detail`, in ONE pass.
 *
 * One pass is the load-bearing part: several error templates are `{reason}` filled with a
 * multiplexer's own words, and a push title carries an agent's name — neither is Collie's to trust.
 * A second pass over the result would let a value that happens to contain `{maxBytes}` reach into
 * the catalogue's other values.
 *
 * A slot with no matching field renders empty. That is a programming error, not a runtime condition
 * — each catalogue's test fails a call that names a slotted code without passing a detail object —
 * so it does not throw here, where throwing would turn a wording bug into a 500 or a lost alert on a
 * live phone.
 */
export function renderTemplate(template: string, detail: TemplateDetail | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = detail?.[name];
    return value === undefined ? "" : String(value);
  });
}
