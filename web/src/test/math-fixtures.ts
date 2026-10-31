import type { FileReadResponse, TranscriptEntry } from "@/lib/types";

import { fixtureFileRead, fixtureTranscript } from "./handlers";

const wide = Array.from({ length: 40 }, (_, i) => `x_{${i}}`).join(" + ");

/** The same document exercises the renderer in a unit test and in the shipped browser bundle. */
export const fixtureMathMarkdown = [
  "# Equations",
  "",
  String.raw`Inline: **$f^{**}(x)$** and *\(f^*(x) = \sqrt{a^2+b^2}\)*.`,
  "",
  "$$",
  String.raw`\begin{aligned}`,
  String.raw`S_n &= \sum_{i=1}^{n} i = \frac{n(n+1)}{2} \\`,
  String.raw`A &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`,
  String.raw`\end{aligned}`,
  "$$",
  "",
  "A wide display equation:",
  "",
  "$$",
  wide,
  "$$",
  "",
  `A wide inline equation: \\(${wide}\\).`,
  "",
  "Code remains literal: `$x^2$`. Prices remain $5 and $10.",
].join("\n");

export function fixtureMathFile(): FileReadResponse {
  const file = fixtureFileRead("README.md");
  if (file === null || !file.available) throw new Error("The shared README fixture is missing");
  return { ...file, text: fixtureMathMarkdown, size: fixtureMathMarkdown.length };
}

export const fixtureMathTranscript: TranscriptEntry[] = fixtureTranscript.map((entry) =>
  entry.role === "assistant" ? Object.assign({}, entry, { parts: [{ kind: "text" as const, text: fixtureMathMarkdown }] }) : entry,
);
