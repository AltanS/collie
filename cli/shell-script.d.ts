// Bun can import a file as text, and `@types/bun` declares that shape for eight extensions — none
// of them `.sh`. `cli/installer-embed.ts` embeds `scripts/install.sh` that way, so the declaration
// is ours, exactly as `cli/markdown.d.ts` is ours for the docs pages.
declare module "*.sh" {
  const text: string;
  export default text;
}
