// LAB CODE (experiments/desktop-surfaces, agent A). `?sf=1|2|3` or `localStorage["collie:lab:surfaces"]`
// puts `data-surfaces` on <html>; `src/surfaces-lab.css` keys each proposal on it. No value is today's
// look. Removed when a proposal is picked.
const KEY = "collie:lab:surfaces";
const WORDS = new Set(["1", "2", "3"]);

export function installSurfacesLab(): void {
  const fromUrl = new URLSearchParams(location.search).get("sf");
  if (fromUrl !== null) {
    if (WORDS.has(fromUrl)) localStorage.setItem(KEY, fromUrl);
    else localStorage.removeItem(KEY);
  }
  const value = localStorage.getItem(KEY);
  if (value !== null && WORDS.has(value)) document.documentElement.dataset.surfaces = value;
}
