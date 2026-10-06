import type { Handle } from "remix/component";
import { Layers, Server, ServerOff } from "lucide";

import { linkPresentation, type HostState, type LinkPresentation } from "@web/lib/host-health";
import { HOST_TEXT_CLASSES, hostName, hostSlot, primarySession } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { useStore } from "../lib/store";
import { Icon } from "../ui/icon";
import { AddressTag } from "./address-tag";
import { crewOf, hostHealthOf } from "./crew";

// Port of web/src/components/host-chip.tsx and session-chip.tsx.
//
// THE HIDE RULE IS THE CHIP'S OWN: a host chip draws only on a crew and only for a host it was
// given; a session chip draws only for a session other than the primary one. Every caller mounts
// the chip unconditionally and lets it answer. Each chip subscribes to the snapshot it reads the
// roster from (rule 4), so it is right on the pane header too, where no list re-renders it.
//
// Variants: `tag` (the default pill), `target` (a write surface's own header, with "on"), `caption`
// (10px uppercase run), `bare` (the 11px mono name the dashboard row and the pane header's meta line
// wear: no pill, the tint on the glyph, the fault in the glyph's shape).
export interface HostChipProps {
  host: string | undefined;
  state?: HostState;
  variant?: "tag" | "target" | "caption" | "bare";
  sends?: boolean;
  class?: string;
}

function linkSuffix(link: LinkPresentation): string {
  switch (link) {
    case "ok":
      return "";
    case "reconnecting":
      return t("connection.host.ariaSuffix", { word: t("connection.host.reconnecting") });
    case "attention":
      return t("connection.host.ariaSuffix", { word: t("connection.host.attention") });
    case "unreachable":
      return t("connection.host.ariaUnreachableSuffix");
  }
}

export function HostChip(handle: Handle<HostChipProps>) {
  const snap = useStore(handle, snapshot);
  useLocale(handle);
  return () => {
    const { host, state, variant = "tag", sends } = handle.props;
    const crew = crewOf(snap().data);
    if (!crew.multi || host === undefined) return null;
    const health = hostHealthOf(crew, host);
    const name = hostName(crew.servers, host) ?? host;
    const slot = hostSlot(crew.servers, host);
    const unreachable = health?.writable !== true;
    const degraded = unreachable || health?.incompatible === true || (state ?? health?.state ?? "unknown") === "unknown";
    const link = linkPresentation(unreachable, health?.linkState);
    const tone = link === "reconnecting" ? "waiting" : degraded ? "alert" : "quiet";
    const target = variant === "target";
    const caption = variant === "caption";
    const bare = variant === "bare";
    const label = t(target || caption || sends === true ? "connection.host.ariaSends" : "connection.host.ariaHost", {
      name,
      unreachable: linkSuffix(link),
    });
    if (caption || bare) {
      return (
        <span
          aria-label={label}
          data-slot="host-chip"
          class={cn(
            "inline-flex min-w-0 gap-1",
            caption ? "items-center text-[10px]/3 font-medium uppercase tracking-wide" : "max-w-[8rem] shrink-0 items-baseline font-mono text-[11px]/3",
            tone === "alert" ? "text-status-blocked" : tone === "waiting" ? "text-status-working" : "text-muted-foreground",
            handle.props.class,
          )}
        >
          <Icon
            icon={tone !== "quiet" ? ServerOff : Server}
            class={cn("size-2.5 shrink-0", bare && "translate-y-[0.26px]", tone === "quiet" && slot !== null && HOST_TEXT_CLASSES[slot])}
          />
          <span class="min-w-0 truncate" aria-hidden="true">
            {name}
          </span>
        </span>
      );
    }
    return (
      <AddressTag
        label={label}
        glyph={<Icon icon={Server} class="size-3 shrink-0" />}
        prefix={target ? t("connection.host.onPrefix") : undefined}
        name={name}
        size={target ? "md" : "sm"}
        tone={tone}
        slot={slot}
        class={handle.props.class}
      />
    );
  };
}

/** The session a row's pane lives in, when it is not the primary one (web/'s SessionChip). */
export function SessionChip(handle: Handle<{ session: string | undefined; class?: string }>) {
  const snap = useStore(handle, snapshot);
  useLocale(handle);
  return () => {
    const { session } = handle.props;
    if (session === undefined || session === primarySession(crewOf(snap().data).sessions)) return null;
    return (
      <AddressTag
        label={t("connection.session.ariaIn", { name: session })}
        glyph={<Icon icon={Layers} class="size-3 shrink-0" />}
        name={session}
        class={handle.props.class}
      />
    );
  };
}
