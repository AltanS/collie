// The set chunks `web/vite-glyphs.ts` builds. Each one's default export is the set's data.
declare module "virtual:collie-glyphs/*" {
  const data: import("./glyph-data").GlyphSetData;
  export default data;
}
