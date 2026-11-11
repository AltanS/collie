// Pair by phone section of the states playground (ADR 0139): the new device's block and the approver's
// page, in every state. Both mount the REAL pure views (`PairWithPhoneView`, `PairApproveView`) with
// fixture states; nothing here talks to a bridge. The QR encodes a fixture link at this origin, so a
// phone that scans it lands on an approver page that says the request has ended.

import type { ReactNode } from "react";

import { PairWithPhoneView, type PairPhoneState } from "@/components/pair-with-phone";
import { PairApproveView, type PairApproveActions, type PairApproveState } from "@/routes/pair-approve";

import { Card, Group, Section, Stage, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "pair-by-phone",
  title: "Pair by phone",
  intent:
    "An unpaired browser shows a QR code and a six-letter code. A phone that is already paired scans it, " +
    "sees which browser asks and from where, and taps the matching code out of three. A wrong tap or Not my device " +
    "ends the request. Cards 1 to 9 are the new device's block, cards 10 to 20 the phone's page.",
};

const NOOP = () => {};
const ACTIONS: PairApproveActions = { onPick: NOOP, onRefuse: NOOP, onName: NOOP, onRetry: NOOP, onDone: NOOP };
const LINK = "https://collie.example.ts.net/pair/approve?r=Pg0FixtureRequest0001";
const CHOICES = ["K7MP2Q", "D4XW9H", "R2TN6F"] as const;

const OPEN: PairApproveState = {
  kind: "open",
  asker: "Chrome on Linux",
  route: "tailnet",
  choices: CHOICES,
  remainingMs: 94_000,
  name: "Chrome on Linux",
  nameError: false,
  busy: false,
};

const PHONE_STATES: readonly { state: string; label: string; reach: string; value: PairPhoneState }[] = [
  { state: "pair-phone-idle", label: "1. idle, the button", reach: "an unpaired browser, Dashboard or Settings, System", value: { kind: "idle" } },
  { state: "pair-phone-waiting", label: "2. waiting, QR and code", reach: "tap Pair with your phone", value: { kind: "waiting", code: "K7MP2Q", link: LINK, remainingMs: 94_000 } },
  { state: "pair-phone-approved", label: "3. approved, reloading", reach: "tap the right code on the phone", value: { kind: "approved", label: "Chrome on Linux" } },
  { state: "pair-phone-refused", label: "4. refused by the phone", reach: "tap a wrong code or Not my device", value: { kind: "refused" } },
  { state: "pair-phone-expired", label: "5. expired", reach: "wait two minutes", value: { kind: "expired" } },
  { state: "pair-phone-rate", label: "6. rate limited", reach: "ask for seven codes in ten minutes", value: { kind: "rate-limited", retryAfterSeconds: 312 } },
  { state: "pair-phone-no-approver", label: "7. no paired device yet", reach: "a bridge with an empty device list", value: { kind: "no-approver" } },
  { state: "pair-phone-refused-before", label: "8. refused before pairing", reach: "a host or identity refusal (Access refused)", value: { kind: "refused-before" } },
  { state: "pair-phone-error", label: "9. bridge not reached", reach: "stop the bridge, then tap the button", value: { kind: "error" } },
];

const APPROVE_STATES: readonly { state: string; label: string; reach: string; value: PairApproveState }[] = [
  { state: "pair-approve-not-paired", label: "10. this phone not paired", reach: "open the QR link on an unpaired browser", value: { kind: "not-paired" } },
  { state: "pair-approve-loading", label: "11. loading", reach: "the first read of the request", value: { kind: "loading" } },
  { state: "pair-approve-open", label: "12. open, three codes", reach: "scan the QR with a paired phone", value: OPEN },
  { state: "pair-approve-name-error", label: "13. name refused", reach: "clear the name, then tap a code", value: { ...OPEN, name: "", nameError: true } },
  { state: "pair-approve-approved", label: "14. approved", reach: "tap the code the other screen shows", value: { kind: "approved", label: "Chrome on Linux" } },
  { state: "pair-approve-wrong-code", label: "15. wrong code", reach: "tap a code the other screen does not show", value: { kind: "wrong-code" } },
  { state: "pair-approve-declined", label: "16. not my device", reach: "tap Not my device", value: { kind: "declined" } },
  { state: "pair-approve-gone", label: "17. request ended", reach: "open an old link, or wait two minutes", value: { kind: "gone" } },
  { state: "pair-approve-answered", label: "18. already answered", reach: "open the link again after an answer", value: { kind: "answered" } },
  { state: "pair-approve-forbidden", label: "19. read-only device", reach: "a device the proxy allowlist does not name", value: { kind: "forbidden" } },
  { state: "pair-approve-error", label: "20. bridge not reached", reach: "stop the bridge, then open the link", value: { kind: "error" } },
];

function Framed({ children }: { children: ReactNode }) {
  return (
    <Stage>
      <div className="p-4">{children}</div>
    </Stage>
  );
}

export function PairByPhoneSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The new device">
        {PHONE_STATES.map((c) => (
          <Card key={c.state} state={c.state} label={c.label} reach={c.reach}>
            <Framed>
              <PairWithPhoneView state={c.value} onStart={NOOP} onCancel={NOOP} />
            </Framed>
          </Card>
        ))}
      </Group>
      <Group title="The paired phone">
        {APPROVE_STATES.map((c) => (
          <Card key={c.state} state={c.state} label={c.label} reach={c.reach}>
            <Framed>
              <PairApproveView state={c.value} actions={ACTIONS} />
            </Framed>
          </Card>
        ))}
      </Group>
    </Section>
  );
}
