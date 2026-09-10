// Idle & resume section of the states playground. Split out of app.tsx; see that file's header
// comment for the whole page's rules.

import { IdleLock } from "@/components/idle-lock";
import { Card, Group, Section, Stage, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "idle",
  title: "Idle & resume",
  intent:
    "The pause that appears when Collie is left open, visible and untouched, and the refetch that returning to it fires. A pause, never a gate (ADR 0007).",
};

export function IdleSection() {
  return (
    <Section def={DEF}>
      <Group title="Paused">
        <Card
          state="idle-lock-paused"
          label="idle lock, paused"
          reach="leave Collie open, visible and untouched. A hidden page never locks; polling stops and the app stays mounted underneath, so an in-progress composer draft survives."
        >
          <Stage height={420}>
            <IdleLock onUnlock={() => {}} />
          </Stage>
        </Card>
      </Group>

      <Group title="Catching up">
        <Card
          state="idle-lock-catching-up"
          label="idle lock, catching up"
          reach="touch the paused screen, or bring the tab back to the foreground. The cover stays up for exactly as long as the resume refetch is in flight."
          note="Both states sit on the page at once because `catchingUp` is a prop, not a clock."
        >
          <Stage height={420}>
            <IdleLock onUnlock={() => {}} catchingUp />
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
