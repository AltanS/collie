import { forwardRef } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { Icon } from "@/components/icons/icon";

import { cn } from "@/lib/utils";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** ALREADY TRANSLATED. Shown while the field is empty. */
  placeholder: string;
  /** ALREADY TRANSLATED. The field's accessible name, when the placeholder is not enough of one. */
  label?: string;
  /**
   * A control in the field's right edge, a 44px square the caller draws (`absolute right-0 top-0
   * size-11`): the session filter's clear button. Given, the text stops short of it, whether the
   * control is shown or kept `invisible`, so it never moves the text (DESIGN.md §2).
   */
  trailing?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** The label of the keyboard's action key (`go`, `search`). */
  enterKeyHint?: "go" | "search" | "done";
  className?: string;
}

/**
 * The one search box: a 44px text field with a magnifier inside its left edge, for a list the person
 * narrows by typing. The command palette's, the Sent sheet's and the session filter's.
 *
 * It is a plain text field with every correction turned off, because what is searched for is a name
 * or a command and not prose. `inputMode="search"` gives the phone keyboard its search key. At 16px
 * (`text-base`) so iOS does not zoom the page when the field takes focus. It forwards its ref to the
 * `<input>` so a sheet can focus it on open. It owns the look and the field; the list under it, the
 * words and the filtering belong to the caller. The session filter adds a clear button in the right
 * edge (`trailing`) and reads Enter and Escape (`onKeyDown`).
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, placeholder, label, trailing, onKeyDown, enterKeyHint, className },
  ref,
) {
  return (
    <div className={cn("relative", className)}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        aria-label={label}
        enterKeyHint={enterKeyHint}
        onKeyDown={onKeyDown}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-11 w-full rounded-md border border-input bg-transparent pl-9 text-base placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          trailing === undefined ? "pr-3" : "pr-11",
        )}
      />
      {trailing}
    </div>
  );
});
