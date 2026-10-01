import type { WizardAnswer } from "@/lib/blocks";

/**
 * The echoed `question → answer` pairs of a dialog's review screen, as a definition list.
 *
 * Both review screens that echo answers render them through here (the wizard's Submit step and a
 * multi-select review that carries `answers`), so the two cannot drift apart. Every string is a
 * React text node, the terminal's own words, so the XSS boundary is unchanged. Renders nothing for
 * an empty list.
 */
export function AnswerList({ answers }: { answers: WizardAnswer[] }) {
  if (answers.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
      {answers.map((qa, i) => (
        <div key={i}>
          <dt className="font-content text-xs text-muted-foreground">{qa.question}</dt>
          <dd className="font-content text-sm font-medium text-foreground">{qa.answer}</dd>
        </div>
      ))}
    </dl>
  );
}
