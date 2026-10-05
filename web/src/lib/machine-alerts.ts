// The choices the alert control offers for one machine rule, kept apart from the component so the
// bridge's contract test can run every one of them through the bridge's own parser
// (`bridge/machines-web-contract.test.ts`). The bridge accepts a wider range (a line from 0.5 to 0.99,
// a time from 5 to 120 minutes, `bridge/machine-parse.ts`); the phone offers a few steps of it.

import type { MachineAlertRule } from "./types";

/** The lines on offer, as fractions: 80%, 90% and 95%. */
export const ALERT_THRESHOLDS = [0.8, 0.9, 0.95] as const;
/** The times on offer, in minutes. */
export const ALERT_DURATIONS = [5, 10, 30, 60] as const;
/** What a switch turns on to, before the operator picks anything else. */
export const DEFAULT_ALERT_RULE: MachineAlertRule = { above: 0.9, forMin: 10 };
