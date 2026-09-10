// Pane section of the states playground. Split out of app.tsx; see that file's header comment for
// the whole page's rules.

import { useEffect, useState } from "react";

import { Collapse } from "@/components/ui/collapse";
import { NavTray } from "@/components/nav-tray";
import { NoEchoNotice } from "@/components/no-echo-notice";
import { clearStatus, setStatus } from "@/lib/status";
import type { DeviceAuth } from "@/lib/types";
import {
  deviceStack,
  homeCrew,
  homeSolo,
  noEchoPrompt,
  paneBlocked,
  paneShell,
  paneStack,
  paneUploadDraft,
  paneWorking,
  updateRelease,
  uploadedImagePath,
} from "../fixtures";
import {
  Card,
  Group,
  PaneRouter,
  PaneStackRouter,
  Section,
  Segmented,
  Stage,
  type SectionDef,
} from "../harness";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "pane",
  title: "Pane",
  intent:
    "One terminal, mirrored. The breadcrumb header and status chip, the ANSI mirror with whatever dialog the grammar lifted out of it, and the composer beneath.",
};

export function PaneSection() {
  return (
    <Section def={DEF}>
      <Group title="Pane screens">
        <Card
          state="pane-permission-prompt"
          label="pane, blocked on a permission prompt"
          reach="an agent asks to run something. Everything here is the real pane view — breadcrumb header, StatusBadge, mirror, composer — over a byte-faithful capture from web/src/fixtures/panes/."
          note="Reads are real; WRITES are not. Tapping an option posts to /api/pane/… and the screen never advances, because nothing on this page is a live terminal. Read it as a photograph."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeSolo} fixture={paneBlocked} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="pane-mid-tool-run"
          label="pane, mid tool-run"
          reach="watch an agent while it works. This is what the ANSI mirror has to colour: a live screen, no dialog, the composer free."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeSolo} fixture={paneWorking} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="pane-upload-draft-path"
          label="pane, a just-uploaded image path in the draft"
          reach="attach a picture. `uploadFile()` appends the HOST path the bridge returns, which is one
            unbroken 70-odd-character token with no break opportunity in it — the widest thing that can
            ever land in this box, and it arrives without the operator typing a character."
          note="THE REGRESSION CARD for the Send button walking off the right edge. The field must wrap
            the path mid-token and Send must stay at the row's right edge, inside the frame. Two classes
            hold it: `wrap-anywhere` on the field (ui/chat/chat-input.tsx) and `min-w-0` on the Collapse
            grid item the whole bottom region sits in (ui/collapse.tsx). jsdom cannot see either work —
            it computes no layout — so this frame is where they are actually looked at."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeSolo} fixture={paneUploadDraft} draft={uploadedImagePath} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="pane-shell-read-only"
          label="pane, a bare shell, composer locked read-only"
          reach="open a shell pane from a device the bridge will not let write. No agent means no grammar and a ShellBadge in place of the status chip; the write gate locks the composer and raises its banner above it."
          note="The shell screen is hand-written ANSI, not a capture — the fixture corpus is a corpus of AGENT screens, and a bare shell has no grammar to pin."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeSolo} fixture={paneShell} readOnly />
          </PhoneFrameCard>
        </Card>

        <Card
          state="keys-tray"
          label="the Keys tray, default state"
          reach="tap Keys in the composer's Controls row. This is the compact seven-column pad: Esc/Tab/the
            three modifiers/Up/Enter on row one, a quick Ctrl+C/Space/Left-Down-Right on row two, and 123,
            Presets and F keys behind one row of chips below it."
          note="Target: at most 120px tall at 390px wide, no clipped labels at 360px, every key at least
            36px tall. Measured with the agent-browser loop against this exact card."
        >
          <PhoneFrameCard height={200}>
            <NavTray onSend={async () => true} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="Composer refusals">
        <Card
          state="no-echo-notice"
          label="no-echo notice, the composer refused a password prompt"
          reach="tap Send at a pane sitting on `sudo`/`ssh`/`gpg`'s password prompt. Echo is off, so the
            reply guard's usual evidence can never arrive, and Send is refused every time — this notice
            is the one sentence that says why and points at the control that works (composer.tsx:1413)."
          note="Real <NoEchoNotice/>, state-driven rather than reached through a live send (playground
            writes go nowhere, and this path needs a real `res.noEcho`). `typed` picks which of the four
            sentences shows; the ✕ is wired to real state — this is the only notice in the app with a
            real dismiss, and tapping it here removes the card's content, not just a class."
        >
          <NoEchoNoticeHarness />
        </Card>
      </Group>

      <Group title="Worst case">
        <Card
          state="pane-every-notice-at-once"
          label="worst case, every notice live at once"
          reach="never all six at once by accident, but never impossible either: a stale proxy session
            (401), a release on offer, a status toast, a device this proxy doesn't allowlist,
            and a peer that has gone quiet — all independent facts that can coincide on one pane."
          note="GENUINE together: the real StripHost band with both of RootLayout's strip features
            registering into it — UpdateRibbon and ConnectionBanner — wrapping the real
            StatusArea/ReadOnlyBanner/HostStaleBanner/mirror inside the real AgentChat, the exact
            nesting routes/root.tsx uses. THE BAND SHOWS ONE OF THEM, and that is the point of the
            card rather than a gap in it: the refusal is AUTH and the offer is UPDATE, so the refusal
            takes the band and the offer waits (lib/strip-priority.ts). The worst case at the top of
            this app is therefore ONE strip plus the header, never two strips plus the header — which
            is also why the safe-area inset is reserved once, by the band while it is open and by the
            header when it is not. The offer is not lost while it waits: /settings/updates carries it,
            and it takes the band the moment the refusal clears. STAGED: the five causes are independently
            driven rather than provoked by one real outage, so they can be shown together on demand; nothing
            here is a state the app cannot produce, only a coincidence forced for review. The red
            ConnectionBanner is the auth-error branch (see PaneStackRouter's doc comment in harness.tsx)
            rather than the trouble→lost escalation, which this page cannot repaint on command — the
            clock's own `__resetConnectionHealth` never calls its store's `emit()`, so a control flip only
            takes effect once each consumer's own mount timer next fires. That gap sits in lib/, outside
            this pass's file allowlist — recommend fixing it there, not worked around by editing the
            store from here. StatusArea is behind its own toggle below rather than always on: `lib/
            status.ts` is ALSO a page-wide singleton, and every OTHER pane card on this page mounts a
            real AgentChat too — an always-on toast here would silently print on every one of them.
            Toggle it on only while measuring this card, then off again."
          span={2}
        >
          <PhoneFrameCard height={800}>
            <StackHarness />
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}

type NoEchoTyped = "untyped" | "typed";
const NO_ECHO_OPTIONS = [
  { value: "untyped", label: "Not typed yet" },
  { value: "typed", label: "Already typed" },
] as const satisfies readonly { value: NoEchoTyped; label: string }[];

/**
 * `NoEchoNotice`, state-driven since a real refusal needs a live send this page cannot produce
 * (`res.noEcho`). `typed` picks which of the four sentences shows; the ✕ is wired to REAL local state
 * — this is the only notice in the app with a real dismiss, so tapping it here has to remove the
 * notice, not just prove a class toggled.
 *
 * THROUGH `Collapse`, because that is how the composer mounts it (DESIGN.md §1) and the dismiss is
 * the one interaction on this page that shows the exit. A card that popped the notice in and out
 * would be showing a surface the app does not have.
 */
function NoEchoNoticeHarness() {
  const [typed, setTyped] = useState<NoEchoTyped>("untyped");
  const [dismissed, setDismissed] = useState(false);
  return (
    <>
      <div className="mb-2">
        <Segmented name="no-echo prompt" value={typed} options={NO_ECHO_OPTIONS} onChange={setTyped} />
      </div>
      <Stage>
        <div className="p-3">
          <Collapse open={!dismissed}>
            <NoEchoNotice
              prompt={noEchoPrompt}
              typed={typed === "typed"}
              onUseType={() => {}}
              onDismiss={() => setDismissed(true)}
            />
          </Collapse>
          {dismissed && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-4"
              onClick={() => setDismissed(false)}
            >
              dismissed — tap to show it again
            </button>
          )}
        </div>
      </Stage>
    </>
  );
}

/**
 * The header gate as a device the bridge DOES allowlist — the same fixture with one bit flipped, so
 * the read-only box can be made to leave as well as to arrive. Frozen at module scope: a fresh
 * object each render would re-run every `device`-keyed effect inside the real AgentChat below.
 */
const deviceStackAllowed: DeviceAuth = { ...deviceStack, authorized: true };

/**
 * The band here is driven by the SNAPSHOT — `update.releaseAvailable` on the loader data — and not by
 * the self-updater's page-wide store, which is what this card used to reach for. That store is one
 * module for the whole page, so taking a hold here quietly put every other band card into the stale-
 * bundle state; the offer state is a genuine band state that needs no singleton at all, and the
 * stale-bundle one has its own opt-in card in sections/dashboard.tsx (`StaleBuildHarness`).
 *
 * `ConnectionBanner`'s red and `ReadOnlyBanner`/`HostStaleBanner`'s locks are plain props on
 * `PaneStackRouter` — see its own doc comment in harness.tsx for why the red state is the
 * auth-error branch, not the escalation clock. `StatusArea` is NOT driven on mount — see this
 * component's own toggle, and why.
 */
function StackHarness() {
  const [showStatus, setShowStatus] = useState(false);
  // The ReadOnlyBanner is the one surface on this card that can be made to appear and disappear on
  // demand, and after its ui/notice.tsx conversion that transition is the thing worth looking at:
  // it opens and closes over 240ms instead of popping, and the mirror under it resizes with it
  // rather than teleporting. Flip this while watching the terminal tail.
  const [readOnly, setReadOnly] = useState(true);

  // `lib/status.ts` is a page-wide singleton, same shape as `lib/connection-health.ts` — and unlike
  // the real app, this ONE page mounts several real `AgentChat`s (and therefore several real
  // `StatusArea`s) at once. Firing it unconditionally on mount would print this card's toast on
  // every other pane card too. So it is opt-in, and this card is the only reader that clears it again.
  useEffect(() => {
    if (!showStatus) return;
    setStatus("Reply sent · 3 lines", "success", null);
    return () => clearStatus();
  }, [showStatus]);

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        aria-label="status toast"
        aria-pressed={showStatus}
        onClick={() => setShowStatus((v) => !v)}
        className="shrink-0 border-b border-border bg-muted px-3 py-1 text-left text-[11px] font-medium text-muted-foreground"
      >
        {showStatus
          ? "StatusArea toast: ON — tap to clear (and stop it leaking into every other pane card)"
          : "StatusArea toast: off — tap to fire one (leaks into every other pane card while on)"}
      </button>
      <button
        type="button"
        aria-label="read-only box"
        aria-pressed={readOnly}
        onClick={() => setReadOnly((v) => !v)}
        className="shrink-0 border-b border-border bg-muted px-3 py-1 text-left text-[11px] font-medium text-muted-foreground"
      >
        {readOnly
          ? "read-only box: ON — tap to lift the gate and watch it collapse out"
          : "read-only box: off — tap to refuse this device and watch it collapse in"}
      </button>
      <div className="min-h-0 flex-1">
        <PaneStackRouter
          home={{ ...homeCrew, update: updateRelease }}
          fixture={paneStack}
          device={readOnly ? deviceStack : deviceStackAllowed}
        />
      </div>
    </div>
  );
}
