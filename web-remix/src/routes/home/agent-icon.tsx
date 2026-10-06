import type { Handle } from "remix/component";

import { AGENT_BRANDS, type AgentBrand } from "@web/components/agent-icon-data";
import { initials } from "@web/lib/format";
import { cn } from "@web/lib/utils";

// Port of web/src/components/agent-icon.tsx. The brand table is web/'s data, reused read-only; the
// lookup here is data-driven and names no harness: an exact key, or a key followed by `-` or `.`
// (so `claude-code` finds `claude`). Anything else is the initials tile, which is what an agent
// nobody drew a logo for has always got.
function brandFor(agent: string): AgentBrand | undefined {
  const name = agent.toLowerCase().trim();
  const exact = AGENT_BRANDS.get(name);
  if (exact) return exact;
  let best: string | undefined;
  for (const key of AGENT_BRANDS.keys()) {
    if ((name.startsWith(`${key}-`) || name.startsWith(`${key}.`)) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : AGENT_BRANDS.get(best);
}

export function AgentIcon(handle: Handle<{ agent: string; class?: string; glide?: string }>) {
  const gradId = `agent-icon-${handle.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  return () => {
    const { agent } = handle.props;
    const brand = brandFor(agent);
    if (!brand) {
      return (
        <span
          class={cn(
            "inline-flex shrink-0 items-center justify-center rounded-md border bg-muted text-[0.5em] font-semibold uppercase leading-none text-muted-foreground",
            handle.props.class,
          )}
          role="img"
          data-glide={handle.props.glide}
          aria-label={`${agent} icon`}
        >
          {initials(agent)}
        </span>
      );
    }
    const stroke = brand.mode === "stroke";
    const grad = brand.grad;
    const paint = grad ? `url(#${gradId})` : brand.fg;
    return (
      <svg viewBox="0 0 24 24" class={cn("shrink-0", handle.props.class)} data-glide={handle.props.glide} role="img" aria-label={`${agent} logo`}>
        {grad && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              {grad.map((stop, i) => (
                <stop key={`${stop}${String(i)}`} offset={i / (grad.length - 1)} stop-color={stop} />
              ))}
            </linearGradient>
          </defs>
        )}
        <rect width="24" height="24" rx="5.3" fill={brand.bg} />
        <g
          transform="translate(4.6 4.6) scale(0.617)"
          fill={stroke ? "none" : paint}
          stroke={stroke ? paint : undefined}
          stroke-width={stroke ? 2 : undefined}
          stroke-linecap={stroke ? "square" : undefined}
        >
          <path d={brand.d} />
        </g>
      </svg>
    );
  };
}
