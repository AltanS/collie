import { cva, type VariantProps } from "class-variance-authority";
import type { Handle, Props, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/button.tsx: the same classes and variants, so a Remix screen and a
// React screen draw one button. Every variant shares ONE box (`border border-transparent` in the
// base string), and focus is an outline outside it. See the original for the reasoning.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] select-none",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline: "border-border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-md px-6 has-[>svg]:px-4 text-base",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = Props<"button"> &
  VariantProps<typeof buttonVariants> & { children?: RemixNode };

export function Button(handle: Handle<ButtonProps>) {
  return () => {
    const { class: className, variant, size, type = "button", ...rest } = handle.props;
    return (
      <button
        {...rest}
        type={type}
        data-slot="button"
        class={cn(buttonVariants({ variant, size, className }))}
      />
    );
  };
}
