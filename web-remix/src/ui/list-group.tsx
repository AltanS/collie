import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/list-group.tsx: a list of flat rows as ONE bordered region. The
// frame takes `--rule`, the hairlines inside take `--border` (the original says why).
export interface ListGroupProps {
  as?: "div" | "dl" | "ul";
  class?: string;
  id?: string;
  "aria-labelledby"?: string;
  children?: RemixNode;
}

export function ListGroup(handle: Handle<ListGroupProps>) {
  return () => {
    const { as = "div", class: className, children, ...rest } = handle.props;
    const cls = cn("flex flex-col divide-y divide-border rounded-sm border border-rule", className);
    if (as === "ul") return <ul {...rest} data-slot="list-group" class={cls}>{children}</ul>;
    if (as === "dl") return <dl {...rest} data-slot="list-group" class={cls}>{children}</dl>;
    return <div {...rest} data-slot="list-group" class={cls}>{children}</div>;
  };
}
