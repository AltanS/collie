// Brand section of the states playground: the app's own voice — the UI typeface under a live
// switcher, then the three marks it wears. Split out of app.tsx; see that file's header comment for
// the whole page's rules (real components, real props, short card labels).

import { AlphaBar } from "@/components/alpha-bar";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { CollieHome } from "@/components/collie-home";
import type { MarkState } from "@/components/mark-contract";
import { CollieMark } from "@/components/collie-mark";
import { homeSolo } from "../fixtures";
import { RootRouter } from "../harness";
import { Card, Group, Section, Stage, type SectionDef } from "../layout";
import { TypefaceCard } from "../typeface-card";

export const DEF: SectionDef = {
  id: "brand",
  title: "Brand",
  intent:
    "The app's own voice: the UI typeface under a live switcher, then the three marks it wears. The Collie mark in every weight and state, the multiplexer's own logo as the header prints it, and the installed-app icons at the sizes a launcher actually asks for.",
};

export function BrandSection() {
  return (
    <Section def={DEF}>
      <Group title="Typeface">
        <TypefaceCard />
      </Group>

      <Group title="The mark">
        <Card
          state="mark-header-weight"
          label="the mark, header weight"
          reach="every screen. 40px in the header bar, 64px on the boot splash and the idle cover."
          note="`paper` is the ground the mark sits on: it is --background here, --muted in the header, --card on the idle cover."
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <MarkSample size={40} weight="header" state="rest" />
              <MarkSample size={40} weight="header" state="loading" />
              <MarkSample size={64} weight="header" state="rest" />
              <MarkSample size={64} weight="header" state="loading" />
            </div>
          </Stage>
        </Card>

        <Card
          state="mark-full-weight"
          label="the mark, full weight"
          reach="the drawing anywhere above about 80px. Below that the full weight's detail closes up and the header weight is used instead."
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <MarkSample size={96} weight="full" state="rest" />
              <MarkSample size={96} weight="full" state="loading" />
              <MarkSample size={132} weight="full" state="loading" />
            </div>
          </Stage>
        </Card>

        <Card
          state="mark-muted-rest"
          label="the mark, muted rest"
          reach="let the connection stay lost for 15s. The splash and the header both drop the mark to this rest to say “not connected”."
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <MarkSample size={40} weight="header" state="idle" />
              <MarkSample size={64} weight="header" state="idle" />
              <MarkSample size={96} weight="full" state="idle" />
            </div>
          </Stage>
        </Card>

        <Card
          state="mark-applying"
          label="the mark, app updating"
          reach="leave the app open while a new build of it downloads, or while it waits to reload onto one. Tap the mark to open the dashboard's update line."
          note="The band's old download row, moved onto the mark (2026-11-06). The loading rate, and every bead a full disc in --status-working. The mark paints it itself, from the applying state. Under reduced motion the orbit stops and the colour stays. The first sample is the real header button, with its updating name."
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <div className="flex flex-col items-center gap-1.5">
                <CollieHome trouble={false} applying paper="var(--background)" />
                <span className="font-mono text-[10px] text-muted-foreground">header button</span>
              </div>
              <MarkSample size={64} weight="header" state="applying" />
              <MarkSample size={96} weight="full" state="applying" />
            </div>
          </Stage>
        </Card>
        <Card
          state="mark-reconnected"
          label="the mark, reconnected"
          reach="let the connection drop until the strip shows, then let it come back. The mark turns once in green and the status line says Reconnected."
          note="The band's old green Connected strip, moved onto the mark (2026-11-07, lib/reconnected.ts). One full turn at the loading rate, every bead in --status-done, then rest. The same contract door. The samples here hold the state; in the app it lasts one turn, 1.8s. Under reduced motion the orbit stays still and the colour holds for the same time."
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <div className="flex flex-col items-center gap-1.5">
                <CollieHome trouble={false} reconnected paper="var(--background)" />
                <span className="font-mono text-[10px] text-muted-foreground">header button</span>
              </div>
              <MarkSample size={64} weight="header" state="reconnected" />
              <MarkSample size={96} weight="full" state="reconnected" />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="The header">
        <Card
          state="header-stacked-identity"
          label="“Collie” over “on <mux>”, the header's stacked identity"
          reach="open the dashboard or a space view. The block rides WITH the wordmark claim and never appears inside a pane, where the breadcrumb owns the middle of the bar."
          note="Real <AppHeaderHost>+<RouteHeader wordmark/>. Two lines beside the mark: the 11px uppercase brand tier over the multiplexer at 16px, which is the line the width is for — stacked, the brand costs the name nothing. The name and the logo come from this bridge's own /api/config, so with no bridge behind the dev proxy the second line renders NOTHING, deliberately: “on unknown” would be a worse header than no line at all. The slot is reserved either way, so the brand line does not move when the read lands."
          span={2}
        >
          <Stage>
            <RootRouter data={homeSolo}>
              <AppHeaderHost bridge="connected" error={false}>
                <RouteHeader wordmark rightTrail={<SettingsGear />} />
              </AppHeaderHost>
            </RootRouter>
          </Stage>
        </Card>

        <Card
          state="prerelease-strip"
          label="the prerelease strip, AlphaBar"
          reach="run a v1 alpha build beside the stable install. It never appears at all on a stable
            build — `prereleaseLabel` reads THIS bundle's own baked-in version (lib/build.ts, a vite
            `define`) and returns nothing unless that version carries a SemVer prerelease tag."
          note="`version` is AlphaBar's own injectable prop (its test seam, alpha-bar.test.tsx uses the
            same one) — the honest way to stand in for the vite define without editing the component or
            faking the build. In the real app it is mounted once, inside the one <AppHeaderHost/> above
            the wordmark row — the header is hoisted out of the routes now, so there is exactly one of
            it for the app's lifetime; it is shown here on its own so its `version` seam can be driven."
          span={2}
        >
          <Stage>
            <div className="flex flex-col">
              <AlphaBar version="1.0.0-alpha.3" />
              <AlphaBar version="2.0.0-rc.1" />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="App icons">
        <Card
          state="app-icons-real-sizes"
          label="favicon and installed-app tiles, at their real sizes"
          reach="install the PWA, or look at the browser tab. Each tile below is at its native pixel size — no upscaling — so the ones that get downsampled by a launcher can be judged as drawn."
          span={2}
        >
          <Stage>
            <div className="flex flex-wrap items-end gap-6 p-4">
              <IconSample src="/favicon.svg" size={16} label="favicon.svg @16" />
              <IconSample src="/favicon.svg" size={32} label="favicon.svg @32" />
              <IconSample src="/favicon.ico" size={16} label="favicon.ico 16×16" />
              <IconSample src="/favicon-96x96.png" size={96} label="favicon 96×96" />
              <IconSample src="/apple-touch-icon.png" size={180} label="apple-touch 180×180" />
              <IconSample src="/web-app-manifest-192x192.png" size={192} label="manifest 192×192" />
            </div>
          </Stage>
        </Card>

        <Card
          state="app-icon-512"
          label="the 512 tile"
          reach="the manifest's largest icon — what a launcher downsamples from, and what a splash screen uses whole."
          span={2}
        >
          <Stage>
            <div className="p-4">
              <IconSample src="/web-app-manifest-512x512.png" size={512} label="manifest 512×512" />
            </div>
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}

function MarkSample({ size, weight, state }: { size: number; weight: "full" | "header"; state: MarkState }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <CollieMark size={size} weight={weight} state={state} paper="var(--background)" />
      <span className="font-mono text-[10px] text-muted-foreground">
        {size} {weight} {state}
      </span>
    </div>
  );
}

function IconSample({ src, size, label }: { src: string; size: number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <img src={src} width={size} height={size} alt={label} className="max-w-full" />
      <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
