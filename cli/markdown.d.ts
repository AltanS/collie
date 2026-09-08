// Bun can import a file as text, and `@types/bun` declares that shape for eight extensions —
// `.txt`, `.toml`, `.yaml`, `.yml`, `.jsonc`, `.json5`, `bun.lock` and `.html`. `.md` is not among
// them, and `cli/docs-embed.ts` embeds the operator manual that way, so the declaration is ours.
declare module "*.md" {
  const text: string;
  export default text;
}
