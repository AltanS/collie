import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Local, monotonic id — NOT crypto.randomUUID(), which is undefined on insecure origins (plain
// HTTP over the tailnet). Only used as a React key / local message id, so uniqueness-per-session
// is all we need.
let _idSeq = 0;
export function genId(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${(_idSeq++).toString(36)}`;
}
