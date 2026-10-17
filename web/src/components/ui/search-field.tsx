import { forwardRef } from "react";
import type { ChangeEvent } from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** ALREADY TRANSLATED. Shown while the field is empty. */
  placeholder: string;
  /** ALREADY TRANSLATED. The field's accessible name, when the placeholder is not enough of one. */
  label?: string;
  className?: string;
}

/**
 * The one search box: a 44px text field with a magnifier inside its left edge, for a list the person
 * narrows by typing. The command palette's and the Sent sheet's.
 *
 * It is a plain text field with every correction turned off, because what is searched for is a name
 * or a command and not prose. `inputMode="search"` gives the phone keyboard its search key. At 16px
 * (`text-base`) so iOS does not zoom the page when the field takes focus. It forwards its ref to the
 * `<input>` so a sheet can focus it on open. It owns the look and the field; the list under it, the
 * words and the filtering belong to the caller.
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, placeholder, label, className },
  ref,
) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-base placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
    </div>
  );
});
