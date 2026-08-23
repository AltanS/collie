import { posix, win32 } from "node:path";

function normalizeForEquality(path: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return path;
  const normalized = path.replace(/\//g, "\\");
  const root = win32.parse(normalized).root;
  let end = normalized.length;
  while (end > root.length && normalized[end - 1] === "\\") end--;
  return normalized.slice(0, end).toLowerCase();
}

function normalizeForContainment(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return normalizeForEquality(path, platform);
  const root = posix.parse(path).root;
  let end = path.length;
  while (end > root.length && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** Case-sensitive everywhere except win32, where comparisons are case-insensitive and normalize equivalent Windows path spellings. */
export function pathEq(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeForEquality(a, platform) === normalizeForEquality(b, platform);
}

/**
 * Whether `child` is the same path as `root` or lives directly beneath it.
 * win32 comparisons ignore case; other platforms keep the existing strict behavior while
 * ignoring redundant trailing separators for containment.
 */
export function pathStartsWithChild(
  child: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const childFold = normalizeForContainment(child, platform);
  const rootFold = normalizeForContainment(root, platform);
  if (childFold === rootFold) return true;
  const sep = platform === "win32" ? "\\" : "/";
  const boundary = rootFold.endsWith(sep) ? rootFold : `${rootFold}${sep}`;
  return childFold.startsWith(boundary);
}
