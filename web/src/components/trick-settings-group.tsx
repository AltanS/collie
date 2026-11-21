import { useEffect, useId, useState, type FormEvent } from "react";

import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { asJsonString } from "@/lib/json";
import { t } from "@/lib/i18n";
import { FIELD_TEXT_MAX } from "@/lib/tricks/limits";
import { fieldValueOf, fieldValueProblem, type FieldProblem, type FieldValue, type TrickField, type WireTrickInfo } from "@/lib/tricks/schema";

// A trick's "Settings" group on its details page (contract 3, `[[field]]`): one 44 px row per field, the values
// the person keeps for the trick. Phone first: a text or number field is a box on its row with the "done" key,
// saved when the keyboard's done is tapped or the box loses focus, never per keystroke; a choice is the native
// select (the OS draws the picker); a switch flips and saves at once. The row checks a value by the field's own
// rule before it is sent (schema.ts `fieldValueProblem`), and the bridge checks it again.
//
// The write belongs to the card (`onValue`, tricks-settings-card.tsx): it mints one request id per change and
// answers the words of a failure, or null. Until the list shows the new value, the row holds what was saved.
// A cleared text or number box clears the value back to its default. On a crew member the values live on the
// lead: the group shows them read only, with one line that says so. A required field that is empty marks the
// group with one line, and the trick's row in Settings says "Needs setup".

export interface TrickSettingsGroupProps {
  trick: Pick<WireTrickInfo, "fields" | "values" | "needsSetup" | "valuesUnread">;
  /** Whether this device may write, and this bridge keeps the values (not a crew member). */
  canWrite: boolean;
  /** This bridge runs no tricks: the values live on the lead. */
  onLead?: boolean;
  /** Save one value (null clears it). Answers the words of a failure, or null when it took. */
  onValue: (key: string, value: FieldValue | null) => Promise<string | null>;
}

/** The words of a value that breaks its field's rule, in the phone's language. */
export function fieldProblemWords(field: TrickField, problem: Pick<FieldProblem, "code">): string {
  if (field.kind === "number") return t("settings.tricks.fields.refused.number", { min: field.min, max: field.max });
  if (field.kind === "choice") return t("settings.tricks.fields.refused.option");
  if (field.kind === "switch") return t("settings.tricks.fields.failed", { label: field.label });
  return problem.code === "text" ? t("settings.tricks.fields.refused.text", { max: FIELD_TEXT_MAX }) : t("settings.tricks.fields.failed", { label: field.label });
}

/** The Settings group, or nothing for a trick with no fields. */
export function TrickSettingsGroup({ trick, canWrite, onLead = false, onValue }: TrickSettingsGroupProps) {
  useLocale();
  const fields = trick.fields ?? [];
  if (fields.length === 0) return null;
  const values = trick.values ?? {};
  const writable = canWrite && !onLead;
  return (
    <section data-section="settings" className="pt-6">
      <SectionLabel className="mb-2 block">{t("settings.tricks.about.settingsHeading")}</SectionLabel>
      <p data-line="settings-no-secrets" className="pb-1 text-xs text-muted-foreground">
        {t("settings.tricks.fields.noSecrets")}
      </p>
      {onLead && (
        <p data-line="settings-on-lead" className="pb-1 text-xs text-muted-foreground">
          {t("settings.tricks.fields.onLead")}
        </p>
      )}
      {trick.valuesUnread === true && (
        <p data-line="settings-unread" role="status" className="pb-1 text-xs text-status-blocked">
          {t("settings.tricks.fields.unread")}
        </p>
      )}
      {trick.needsSetup === true && !onLead && (
        <p data-line="settings-needs-setup" className="pb-1 text-xs text-muted-foreground">
          {t("settings.tricks.fields.needsSetup")}
        </p>
      )}
      {/* One bordered group, one row per field, a rule between rows: the look of the page's other sections (2026-11-21). */}
      <ListGroup as="ul" aria-label={t("settings.tricks.about.settingsHeading")} className="mt-1">
        {fields.map((field) => (
          <li key={field.key} className="px-3.5 py-1">
            <FieldRow field={field} stored={values[field.key]} disabled={!writable} onValue={onValue} />
          </li>
        ))}
      </ListGroup>
    </section>
  );
}

interface FieldRowProps {
  field: TrickField;
  stored: FieldValue | undefined;
  disabled: boolean;
  onValue: TrickSettingsGroupProps["onValue"];
}

/** A field's value now: the one shown (saved or listed) when it keeps the rule, else the default. */
function valueNow(field: TrickField, shown: FieldValue | undefined): FieldValue | undefined {
  return fieldValueOf(field, shown === undefined ? {} : { [field.key]: shown });
}

/** The value a row shows: what was saved and not yet in the list, else the list's, else the default. */
function useHeld(stored: FieldValue | undefined): [FieldValue | undefined | null, (value: FieldValue | null | undefined) => void] {
  // `undefined`: nothing held; `null`: a clear held.
  const [held, setHeld] = useState<FieldValue | null | undefined>(undefined);
  useEffect(() => {
    // The list caught up: it speaks again.
    if (held !== undefined && (held ?? undefined) === stored) setHeld(undefined);
  }, [held, stored]);
  return [held === undefined ? stored : held, setHeld];
}

function FieldRow({ field, stored, disabled, onValue }: FieldRowProps) {
  const id = useId();
  const hintId = useId();
  const [shown, hold] = useHeld(stored);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const now = valueNow(field, shown ?? undefined);
  const empty = field.kind !== "switch" && field.required === true && now === undefined;

  async function save(value: FieldValue | null): Promise<void> {
    if (busy) return;
    const problem = value === null ? undefined : fieldValueProblem(field, value);
    if (problem !== undefined) {
      setNote(fieldProblemWords(field, problem));
      return;
    }
    setNote(null);
    setBusy(true);
    hold(value);
    const failed = await onValue(field.key, value);
    setBusy(false);
    if (failed !== null) {
      hold(undefined);
      setNote(failed);
    }
  }

  return (
    <div data-field={field.key} data-kind={field.kind} data-empty={empty ? "" : undefined}>
      <div className="flex min-h-11 items-center gap-3 py-1">
        <label htmlFor={id} className="min-w-0 flex-1 text-sm break-words">
          {field.label}
          {field.required === true && field.kind !== "switch" && <span className="ml-1.5 text-xs text-muted-foreground">{t("settings.tricks.fields.required")}</span>}
        </label>
        <FieldControl id={id} hintId={field.hint === undefined ? undefined : hintId} field={field} shown={shown ?? undefined} disabled={disabled || busy} onSave={(value) => void save(value)} />
      </div>
      {field.hint !== undefined && (
        <p id={hintId} className="pb-1 text-xs text-muted-foreground break-words">
          {field.hint}
        </p>
      )}
      {note !== null && (
        <p data-slot="field-note" role="status" className="pb-1 text-[11px] text-status-blocked">
          {note}
        </p>
      )}
    </div>
  );
}

interface FieldControlProps {
  id: string;
  hintId: string | undefined;
  field: TrickField;
  shown: FieldValue | undefined;
  disabled: boolean;
  onSave: (value: FieldValue | null) => void;
}

/** The control of one field, by its kind. */
function FieldControl({ id, hintId, field, shown, disabled, onSave }: FieldControlProps) {
  switch (field.kind) {
    case "switch":
      return <Switch id={id} checked={valueNow(field, shown) === true} disabled={disabled} onCheckedChange={(on) => onSave(on)} aria-describedby={hintId} />;
    case "choice": {
      const now = asJsonString(valueNow(field, shown));
      // A field with no value yet (no default, nothing set) shows "Not set" until one is picked.
      const unset = now === undefined;
      return (
        <Select id={id} valueChip className="w-1/2 max-w-56 shrink-0" value={unset ? "" : now} disabled={disabled} aria-describedby={hintId} onChange={(event) => onSave(event.currentTarget.value === "" ? null : event.currentTarget.value)}>
          {(unset || field.required !== true) && <option value="">{t("settings.tricks.fields.notSet")}</option>}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    }
    case "number":
    case "text":
      return <BoxControl id={id} hintId={hintId} field={field} shown={shown} disabled={disabled} onSave={onSave} />;
  }
}

/** A text or number box: saved on the keyboard's done or on blur, when it changed. */
function BoxControl({ id, hintId, field, shown, disabled, onSave }: FieldControlProps) {
  const now = valueNow(field, shown);
  const text = now === undefined ? "" : String(now);
  const [draft, setDraft] = useState(text);
  // A new value from the list (another device) replaces the box while it is not being typed in.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setDraft(text);
  }, [text, typing]);

  function commit(): void {
    setTyping(false);
    const typed = draft.trim() === "" ? "" : field.kind === "number" ? draft.trim() : draft;
    if (typed === text) return;
    if (typed === "") {
      onSave(null);
      return;
    }
    if (field.kind === "text") {
      onSave(typed);
      return;
    }
    // A number that does not read as one is sent as NaN, so the row's own check says the rule.
    onSave(/^-?\d{1,9}$/u.test(typed) ? Number(typed) : Number.NaN);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // The done key closes the keyboard; the blur saves, so a value is sent once.
    const input = event.currentTarget.elements.namedItem("value");
    if (input instanceof HTMLInputElement && document.activeElement === input) input.blur();
    else commit();
  }

  return (
    <form className="w-1/2 max-w-56 shrink-0" onSubmit={submit}>
      <input
        id={id}
        name="value"
        type="text"
        inputMode={field.kind === "number" ? "numeric" : "text"}
        enterKeyHint="done"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={field.kind === "text" ? FIELD_TEXT_MAX : 11}
        value={draft}
        placeholder={field.kind === "number" ? t("settings.tricks.fields.range", { min: field.min, max: field.max }) : t("settings.tricks.fields.notSet")}
        disabled={disabled}
        aria-describedby={hintId}
        onFocus={() => setTyping(true)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        className="h-11 w-full rounded-lg border border-border bg-muted px-3 text-base font-medium text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
      />
    </form>
  );
}
