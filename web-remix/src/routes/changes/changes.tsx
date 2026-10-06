// PLACEHOLDER, replaced by the Changes and Files port (the frame and the header claim are in place).
//
// ONE component serves all three levels of both targets (ADR 0065, 0083): the list, the commit
// under it and the folder tree under it. `level` is read off the URL by the route action, and the
// action keys the route by target and id only, so the list keeps its state under the commit.
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { panePath, spacePath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";

export type ChangesTarget = { kind: "pane"; paneId: string } | { kind: "space"; spaceId: string };
export type ChangesLevel = "list" | "commit" | "files";

export function ChangesRoute(handle: Handle<{ target: ChangesTarget; level: ChangesLevel }>) {
  const where = useStore(handle, address);
  return () => {
    const { target } = handle.props;
    const up = target.kind === "pane" ? panePath(target.paneId, where().scope) : spacePath(target.spaceId, where().scope);
    return (
      <Frame title={t("files.title")} up={up} width="wide">
        <p class="text-sm text-muted-foreground">{handle.props.level}</p>
      </Frame>
    );
  };
}
