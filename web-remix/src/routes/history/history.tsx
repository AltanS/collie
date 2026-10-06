// PLACEHOLDER, replaced by the History port (the frame and the header claim are already in place).
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { panePath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";

export function HistoryRoute(handle: Handle<{ paneId: string }>) {
  const where = useStore(handle, address);
  return () => (
    <Frame title={t("history.title")} up={panePath(handle.props.paneId, where().scope)} width="wide">
      <p class="text-sm text-muted-foreground">{t("history.title")}</p>
    </Frame>
  );
}
