// The pure part of rendering the WalkyTalky skill: no embedded template, no file, no context. It lives apart
// from cli/skill-install.ts because that module imports the template with Bun's `with { type: "text" }`,
// which Node (Playwright, vitest) cannot load. The browser-leg rig renders the skill through this one
// function, so its agents read what a real install of the same switch reads and no second copy of the
// cutting logic exists.

/** A Hill part that fills whole lines: the marker lines go in both states, the lines between only when off. */
const HILL_LINES = /^\{\{HILL\}\}\n([\s\S]*?)^\{\{\/HILL\}\}\n/gmu;
/** A Hill part inside one line (the description's words). */
const HILL_WORDS = /\{\{HILL\}\}([\s\S]*?)\{\{\/HILL\}\}/gu;

/**
 * The template's Hill parts kept (on) or cut (off). With the Hill on the text is byte for byte the text of
 * before the markers; with it off no Hill word is left, in the description or the body (M96 spec 12).
 */
export function withHill(template: string, hillOn: boolean): string {
  return template.replace(HILL_LINES, hillOn ? "$1" : "").replace(HILL_WORDS, hillOn ? "$1" : "");
}

/** What a render fills in: the command's path, the build's version and the Hill switch. */
export interface SkillRenderInput {
  readonly binary: string;
  readonly version: string;
  readonly hillOn: boolean;
}

/** A template (LF line ends) with its Hill parts kept or cut and `{{COLLIE_BIN}}` and `{{COLLIE_VERSION}}` resolved. */
export function renderSkillTemplate(template: string, input: SkillRenderInput): string {
  return withHill(template, input.hillOn)
    .replaceAll("{{COLLIE_BIN}}", input.binary)
    .replaceAll("{{COLLIE_VERSION}}", input.version)
    .replace(/\n+$/u, "\n");
}
