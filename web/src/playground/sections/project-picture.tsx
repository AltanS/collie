// "Project picture": the picture a repository's `collie.toml` names, on a pane row's tile, the sidebar's
// tile with its status mark, the closed sidebar's tile, and the Settings switch (issue 811, ADR 0160).
//
// DEV-ONLY, unreachable from the app entry.
//
// THE PICTURE IS A FIXTURE: a 64 px PNG made for this page, held here as a data URL. The tiles read the
// device's picture store (lib/project-picture.ts), so the section seeds that store with the fixture for
// as long as it is mounted and puts the device's own values back when it leaves.

import { useEffect, useState } from "react";

import { AgentTile } from "@/components/agent-tile";
import { ProjectPicturesControl } from "@/components/project-pictures-control";
import { PaneGlyph } from "@/components/ui/pane-glyph";
import { __reloadProjectPictures } from "@/lib/project-picture";
import type { AgentView } from "@/lib/types";

import { herd } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "project-picture",
  title: "Project picture",
  intent:
    "The picture a repository's collie.toml names, in place of the agent logo on a tile. The agent's logo stays in the tile's corner, and the Collie mark is never replaced.",
};

const VERSION = "0123456789ab0123456789ab";
const PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA9ElEQVR42u3a0Q3CMAwE0NuERdipv8zApP1FYoB+I0FoHDt2rid5gHttpDa2cdseSxcEEEAAAT5rf94bVRTQDh2KQUp0RwYSo7swkB59kIE66W0GlEpvMKBa+l4DItK/X/vXijDAMf2v3GaJD8A3ei9jFBAUvYsRCBhPf8ZgB8xJP2gwAnzT/zVYAJPTmw2kgJT0NsPFANHp24bLABLPj+EUodrj730JAggggAACzAIs8yHTv1BhgO4DswC6ExcALN9WYWhsLd9aZGjuLt9eZxhwMIyYGIZ8DGNWhkE3w6oBw7IHyboNycITycqZthYFEEAAax2rMU2LMl6+SgAAAABJRU5ErkJggg==";

const COPIES_KEY = "collie:project-picture-copies:v1";
const SWITCH_KEY = "collie:project-pictures:v1";

function failNoHerd(): never {
  throw new Error("the fixture herd is empty");
}

/** The first herd row, as a pane of a repository that names the fixture picture. */
const base: AgentView = herd.at(0) ?? failNoHerd();
const withPicture: AgentView = { ...base, paneId: "pic:with", picture: VERSION };
const withoutPicture: AgentView = { ...base, paneId: "pic:without" };
const inSidebar: AgentView = { ...base, paneId: "pic:side", picture: VERSION, status: "working" };

/** Hold the fixture in the picture store while the section is mounted, then give the device its values back. */
function useSeededPictures(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const kept = { copies: localStorage.getItem(COPIES_KEY), on: localStorage.getItem(SWITCH_KEY) };
    localStorage.removeItem(SWITCH_KEY);
    localStorage.setItem(COPIES_KEY, JSON.stringify({ ["\u0000" + VERSION]: PICTURE }));
    __reloadProjectPictures();
    setReady(true);
    return () => {
      if (kept.copies === null) localStorage.removeItem(COPIES_KEY);
      else localStorage.setItem(COPIES_KEY, kept.copies);
      if (kept.on === null) localStorage.removeItem(SWITCH_KEY);
      else localStorage.setItem(SWITCH_KEY, kept.on);
      __reloadProjectPictures();
    };
  }, []);
  return ready;
}

/** A tile on the colour it sits on, with a name beside it, as a row draws it. */
function Row({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
      {children}
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function ProjectPictureSection() {
  const ready = useSeededPictures();
  return (
    <Section def={DEF}>
      <Group title="Tiles">
        <Card state="tile-with-picture" label="1. row tile, picture" reach="a repository's collie.toml names a picture; the pane's row shows it at 16 px with the agent's logo on its corner.">
          {ready && (
            <Row label="collie">
              <AgentTile pane={withPicture} className="size-4" />
            </Row>
          )}
        </Card>
        <Card state="tile-without-picture" label="2. row tile, no picture" reach="a pane of a repository with no picture, or with the switch off.">
          {ready && (
            <Row label="example-api">
              <AgentTile pane={withoutPicture} className="size-4" />
            </Row>
          )}
        </Card>
        <Card state="tile-sidebar-status" label="3. sidebar tile, status mark" reach="a large screen's sidebar: a 20 px tile with the status mark on its bottom-right corner.">
          {ready && (
            <Row label="collie">
              <PaneGlyph pane={inSidebar} className="size-5" markOn="bg-background" named />
            </Row>
          )}
        </Card>
      </Group>

      <Group title="Closed sidebar">
        <Card state="tile-rail" label="4. closed sidebar tile" reach="a large screen with the sidebar closed: a 28 px tile in a 44 px button, the logo at 14 px, the status mark below.">
          {ready && (
            <Row label="collie">
              <PaneGlyph pane={inSidebar} markOn="bg-card" />
            </Row>
          )}
        </Card>
      </Group>

      <Group title="Settings">
        <Card state="settings-switch" label="5. Settings switch" reach="Settings, Look and feel, Project pictures. On until the person turns it off; off drops every picture the device kept.">
          <ProjectPicturesControl />
        </Card>
      </Group>
    </Section>
  );
}
