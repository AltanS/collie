/**
 * Fits a repo-relative path into `budget` characters, for a row that must show the whole path.
 * The file name is never cut. What gives way, in this order:
 *
 * 1. The folders between the first and the last collapse to one `…` segment
 *    (`src/…/routes/changes.tsx`). With two folders or fewer nothing collapses.
 * 2. The first folder shortens to its first character (`s/…/routes/changes.tsx`), then the last
 *    (`s/…/r/changes.tsx`).
 * 3. Only the bare file name is left.
 *
 * The result is never longer than `budget`, unless the bare name alone is.
 */
export function fitPath(path: string, budget: number): string {
  if (path.length <= budget) return path;
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? path;
  const folders = parts.slice(0, -1);
  if (folders.length === 0) return name;

  const first = folders.at(0) ?? "";
  const last = folders.at(-1) ?? "";
  const joined = (head: string, tail: string): string => {
    if (folders.length === 1) return `${head}/${name}`;
    const between = folders.length > 2 ? ["…"] : [];
    return [head, ...between, tail, name].join("/");
  };
  const attempts = [
    joined(first, last),
    joined(first.slice(0, 1), last),
    joined(first.slice(0, 1), last.slice(0, 1)),
  ];
  for (const attempt of attempts) if (attempt.length <= budget) return attempt;
  return name;
}
