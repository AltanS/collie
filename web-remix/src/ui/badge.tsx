import { cva, type VariantProps } from "class-variance-authority";
import type { Handle, Props } from "remix/component";

import { cn } from "@web/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3 transition-colors overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-white",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge(handle: Handle<Props<"span"> & VariantProps<typeof badgeVariants>>) {
  return () => {
    const { class: className, variant, ...rest } = handle.props;
    return <span {...rest} data-slot="badge" class={cn(badgeVariants({ variant }), className)} />;
  };
}
