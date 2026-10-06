import { on, type Handle } from "remix/component";
import { ChevronRight, Network } from "lucide";

import { isMultiHost } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { crewPath } from "@web/lib/nav";
import { cn } from "@web/lib/utils";

import { navigate } from "../../lib/navigate";
import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";

// Port of web/src/components/crew-footer-link.tsx: the dashboard's way into /crew, a muted line in
// the footer's META zone beside the build stamp and the update ribbon ("how is the thing I'm looking
// at doing"), never a card: a census is never triage.
//
// It draws nothing on a solo install, so a solo install sees byte-identical chrome. The gate is the
// snapshot roster (`isMultiHost`), the same one every host chip uses, not the answer of any crew
// read. When a crew forms or dissolves while the screen is open, the line eases in or out through
// `Collapse` (REMIX3.md rule 7); a closed `Collapse` renders no node at all.
//
// The counts come off the roster the snapshot already holds, the same field and filter the host
// switcher uses. The census page fetches crew status; a footer line must not, or every dashboard
// poll would drag a second request behind it for a caption. The scope comes from `address`, read when
// the line is tapped.
export function CrewFooterLink(handle: Handle<{ class?: string }>) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  return () => {
    const servers = snap().data?.servers;
    const multi = isMultiHost(servers);
    return (
      <Collapse open={multi}>
        {multi && servers !== undefined ? (
          <button
            type="button"
            mix={on("click", () => void navigate(href(crewPath(address.get().scope))))}
            aria-label={t("crew.footer.aria")}
            class={cn(
              "flex w-full items-center justify-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground active:text-foreground",
              handle.props.class,
            )}
          >
            <Icon icon={Network} class="size-3 shrink-0" />
            <span>
              {t("crew.footer.label", {
                machines: tn("crew.summary.machines", servers.length),
                reachable: t("crew.summary.reachable", { count: servers.filter((s) => s.reachable).length }),
              })}
            </span>
            <Icon icon={ChevronRight} class="size-3 shrink-0" />
          </button>
        ) : null}
      </Collapse>
    );
  };
}
