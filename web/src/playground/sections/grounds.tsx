// "Grounds": every pattern of a theme's ground (schema version 4) at its three sizes and three
// strengths, in Collie's light and dark colours, static. One card per pattern, and one more for the
// primary ink. Each tile carries the page colour, the foreground and the primary of one half, and the
// ground's declarations from surface.ts, the same ones the store sets on `html`, so a tile is the page
// as a theme with that ground paints it.
//
// DEV-ONLY, unreachable from the app entry.

import { collieTheme, styleOf } from "@/components/theme-page-sample";
import { fillHalves } from "@/lib/theme/schema";
import {
  GROUND_PATTERN_WORDS,
  GROUND_SIZE_WORDS,
  GROUND_STRENGTH_WORDS,
  groundDeclarations,
  type GroundSpec,
} from "@/lib/theme/surface";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = { id: "grounds", title: "Grounds" };

type Half = "light" | "dark";

/** One tile: the half's page colour under the ground, and a line of text on it. */
function Tile({ half, ground, caption }: { half: Half; ground: GroundSpec; caption: string }) {
  const colours = fillHalves(collieTheme(), collieTheme())[half];
  const style = styleOf([
    ["--background", colours.background ?? ""],
    ["--foreground", colours.foreground ?? ""],
    ["--primary", colours.primary ?? ""],
    ...groundDeclarations(ground),
  ]);
  return (
    <div
      style={{ ...style, backgroundColor: "var(--background)", backgroundImage: "var(--ground-image)", backgroundSize: "var(--ground-size)", color: "var(--foreground)" }}
      className="flex h-16 items-end p-1 font-mono text-[10px] leading-none"
    >
      {caption}
    </div>
  );
}

/** The words in reading order, smallest first, rather than the default-first order of the lists. */
const READING_SIZES = ["fine", "default", "wide"] as const satisfies readonly (typeof GROUND_SIZE_WORDS)[number][];
const READING_STRENGTHS = ["faint", "default", "bold"] as const satisfies readonly (typeof GROUND_STRENGTH_WORDS)[number][];

/** Three rows of strength by three columns of size, in one half. */
function Matrix({ half, pattern }: { half: Half; pattern: GroundSpec["pattern"] }) {
  return (
    <div>
      <p className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">{half}</p>
      <div className="grid grid-cols-3 gap-px border border-border bg-border">
        {READING_STRENGTHS.flatMap((strength) =>
          READING_SIZES.map((size) => <Tile key={`${strength}-${size}`} half={half} ground={{ pattern, size, strength }} caption={`${strength} ${size}`} />),
        )}
      </div>
    </div>
  );
}

const PATTERNS = GROUND_PATTERN_WORDS.filter((pattern) => pattern !== "flat");

export function GroundsSection() {
  return (
    <Section def={DEF}>
      <Group title="Patterns, foreground ink">
        {PATTERNS.map((pattern, i) => (
          <Card key={pattern} state={`ground-${pattern}`} label={`${i + 1} · ${pattern}`} note="Rows: faint, default, bold. Columns: fine, default, wide.">
            <div className="grid grid-cols-2 gap-2">
              <Matrix half="light" pattern={pattern} />
              <Matrix half="dark" pattern={pattern} />
            </div>
          </Card>
        ))}
      </Group>
      <Group title="Primary ink">
        <Card state="ground-primary-ink" label={`${PATTERNS.length + 1} · every pattern, primary ink`}>
          <div className="grid grid-cols-2 gap-2">
            {(["light", "dark"] as const).map((half) => (
              <div key={half} className="grid grid-cols-2 gap-px border border-border bg-border">
                {PATTERNS.map((pattern) => (
                  <Tile key={pattern} half={half} ground={{ pattern, ink: "primary" }} caption={`${half} ${pattern}`} />
                ))}
              </div>
            ))}
          </div>
        </Card>
      </Group>
    </Section>
  );
}
