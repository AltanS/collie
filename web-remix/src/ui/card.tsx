import type { Handle, Props } from "remix/component";

import { cn } from "@web/lib/utils";

export function Card(handle: Handle<Props<"div">>) {
  return () => {
    const { class: className, ...rest } = handle.props;
    return (
      <div
        {...rest}
        data-slot="card"
        class={cn("bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm", className)}
      />
    );
  };
}
