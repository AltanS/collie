// A REAL snapshot off this machine's dev bridge (`GET http://127.0.0.1:8788/api/snapshot`), frozen
// for the dashboard-row experiment card. DEV-ONLY, like the rest of `src/playground/`.
//
// WHY A `.ts` MODULE AND NOT THE `.json` FILE IT STARTED AS: `web/tsconfig.json` does not set
// `resolveJsonModule`, so `import data from "./dashboard-live.json"` type-checks as an error even
// though Vite would serve it happily. Rather than widen a compiler option for a dev-only page, the
// body is inlined here and annotated with the app's own `SnapshotResponse` — which is strictly
// better anyway: a wire change now breaks this file at `tsc` instead of at a confusing render.
//
// WHAT WAS TAKEN OUT, and nothing else: `device`, `notifications` and `update` (three keys that say
// something about THIS browser and THIS install rather than about the herd), plus a scan for any
// token-like key, which found none. Every `cwd`, label, pane title, session name, host id and host
// name is exactly what the bridge sent — that is the whole point of the card, and a scrubbed path
// would make the row widths lie.
//
// It is a PHOTOGRAPH: the timestamps are frozen at capture, so the rows' "how long ago" ages drift
// further into the past the longer this file lives. Re-capture it when the ages stop being useful.

import type { SnapshotResponse } from "@/lib/types";

export const dashboardLive: SnapshotResponse = {
    "bridge": "connected",
    "agents": [
      {
        "paneId": "w1T:p2K",
        "workspaceId": "w1T",
        "workspaceLabel": "workspace-sportsight",
        "workspaceNumber": 2,
        "tabId": "w1T:tR",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/workspace-sportsight",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "xhigh delphi improvements",
        "readableLines": 61,
        "sessionName": "xhigh delphi improvements",
        "lastActiveAt": 1788341961188,
        "lastSeenAt": 1788338370094,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2H:p1",
        "workspaceId": "w2H",
        "workspaceLabel": "klaracase",
        "workspaceNumber": 3,
        "tabId": "w2H:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/klaracase",
        "focused": false,
        "kind": "agent",
        "terminalTitle": "fix loop",
        "readableLines": 61,
        "sessionName": "fix loop",
        "lastActiveAt": 1788317508177,
        "lastSeenAt": 1788158662810,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2T:p34",
        "workspaceId": "w2T",
        "workspaceLabel": "collie-workspace",
        "workspaceNumber": 4,
        "tabId": "w2T:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/collie-workspace",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "PR work",
        "readableLines": 59,
        "sessionName": "PR work",
        "lastActiveAt": 1788344851213,
        "lastSeenAt": 1788344117453,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2T:p39",
        "workspaceId": "w2T",
        "workspaceLabel": "collie-workspace",
        "workspaceNumber": 4,
        "tabId": "w2T:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/collie-workspace",
        "focused": false,
        "kind": "agent",
        "tabLabel": "work",
        "terminalTitle": "translating docs",
        "readableLines": 59,
        "sessionName": "translating docs",
        "lastActiveAt": 1788343834487,
        "lastSeenAt": 1788344061957,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2Y:p1H",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-sprqvntrs",
        "workspaceNumber": 5,
        "tabId": "w2Y:tH",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/workspace-sprqvntrs",
        "focused": false,
        "kind": "agent",
        "tabLabel": "translate",
        "terminalTitle": "Vocabulary translation PWA",
        "readableLines": 59,
        "lastActiveAt": 1788341934249,
        "lastSeenAt": 1788297318046,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2Y:p7",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-sprqvntrs",
        "workspaceNumber": 5,
        "tabId": "w2Y:t2",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/workspace-sprqvntrs",
        "focused": true,
        "kind": "agent",
        "tabLabel": "openplate",
        "terminalTitle": "Openplate release polish",
        "readableLines": 61,
        "lastActiveAt": 1788343171900,
        "lastSeenAt": 1788294982573,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2Z:p2",
        "workspaceId": "w2Z",
        "workspaceLabel": "anchorgenius",
        "workspaceNumber": 6,
        "tabId": "w2Z:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/var/home/altan/projects/anchorgenius",
        "focused": false,
        "kind": "agent",
        "terminalTitle": "gsc",
        "readableLines": 61,
        "sessionName": "gsc",
        "lastActiveAt": 1788344586813,
        "lastSeenAt": 1786626095176,
        "hasSession": true,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w9:p2",
        "workspaceId": "w9",
        "workspaceLabel": "workspace-kaz",
        "workspaceNumber": 1,
        "tabId": "w9:t1",
        "agent": "claude",
        "status": "working",
        "cwd": "/home/altan/projects/workspace-kaz",
        "focused": true,
        "kind": "agent",
        "terminalTitle": "kaz work",
        "readableLines": 1382,
        "sessionName": "kaz work",
        "lastActiveAt": 1788342074956,
        "lastSeenAt": 1788295926286,
        "host": "minibuch"
      },
      {
        "paneId": "wA:p1",
        "workspaceId": "wA",
        "workspaceLabel": "nixos-configuration",
        "workspaceNumber": 2,
        "tabId": "wA:t1",
        "agent": "claude",
        "status": "idle",
        "cwd": "/home/altan/nixos-configuration",
        "focused": false,
        "kind": "agent",
        "tabLabel": "1",
        "terminalTitle": "ThinkPad T14 setup",
        "readableLines": 825,
        "lastActiveAt": 1788299958988,
        "lastSeenAt": 1788299849328,
        "hasSession": true,
        "host": "minibuch"
      },
      {
        "paneId": "wA:p5",
        "workspaceId": "wA",
        "workspaceLabel": "nixos-configuration",
        "workspaceNumber": 2,
        "tabId": "wA:t2",
        "agent": "claude",
        "status": "idle",
        "cwd": "/home/altan/nixos-configuration",
        "focused": false,
        "kind": "agent",
        "tabLabel": "2 👜",
        "terminalTitle": "Claude Code",
        "readableLines": 61,
        "lastActiveAt": 1788299454315,
        "lastSeenAt": 1788299837748,
        "hasSession": true,
        "host": "minibuch"
      },
      {
        "paneId": "w2Y:p1S",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-sprqvntrs",
        "workspaceNumber": 5,
        "tabId": "w2Y:tJ",
        "agent": "claude",
        "status": "done",
        "cwd": "/var/home/altan/projects/workspace-bay",
        "focused": false,
        "kind": "agent",
        "tabLabel": "bay",
        "terminalTitle": "Bay 0.3.0 release and consumer deployment",
        "readableLines": 61,
        "lastActiveAt": 1788344852329,
        "lastSeenAt": 1788337068446,
        "hasSession": true,
        "host": "collie-04rj6a"
      }
    ],
    "shellPanes": [
      {
        "paneId": "w654f9f0c0dd67e:pS",
        "workspaceId": "w654f9f0c0dd67e",
        "workspaceLabel": "tgl",
        "workspaceNumber": 1,
        "tabId": "w654f9f0c0dd67e:t1",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/var/home/altan/projects/workspace-sprqvntrs/tgl",
        "focused": false,
        "kind": "shell",
        "readableLines": 61,
        "lastActiveAt": 1788295611453,
        "lastSeenAt": 1786108030061,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "w2Y:p1P",
        "workspaceId": "w2Y",
        "workspaceLabel": "workspace-sprqvntrs",
        "workspaceNumber": 5,
        "tabId": "w2Y:tH",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/var/home/altan/projects/workspace-sprqvntrs/platform",
        "focused": false,
        "kind": "shell",
        "tabLabel": "translate",
        "readableLines": 59,
        "lastActiveAt": 1788299870743,
        "lastSeenAt": 1788299870743,
        "host": "collie-04rj6a"
      },
      {
        "paneId": "wA:p7",
        "workspaceId": "wA",
        "workspaceLabel": "nixos-configuration",
        "workspaceNumber": 2,
        "tabId": "wA:t1",
        "agent": "shell",
        "status": "unknown",
        "cwd": "/home/altan/nixos-configuration",
        "focused": false,
        "kind": "shell",
        "tabLabel": "1",
        "readableLines": 59,
        "lastActiveAt": 1788301027771,
        "lastSeenAt": 1788301027771,
        "host": "minibuch"
      }
    ],
    "workspaces": [
      {
        "workspaceId": "w654f9f0c0dd67e",
        "number": 1,
        "label": "tgl",
        "focused": false,
        "activeTabId": "w654f9f0c0dd67e:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w1T",
        "number": 2,
        "label": "workspace-sportsight",
        "focused": false,
        "activeTabId": "w1T:tR",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w2H",
        "number": 3,
        "label": "klaracase",
        "focused": false,
        "activeTabId": "w2H:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w2T",
        "number": 4,
        "label": "collie-workspace",
        "focused": false,
        "activeTabId": "w2T:t1",
        "tabCount": 1,
        "paneCount": 2,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w2Y",
        "number": 5,
        "label": "workspace-sprqvntrs",
        "focused": true,
        "activeTabId": "w2Y:t2",
        "tabCount": 3,
        "paneCount": 4,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w2Z",
        "number": 6,
        "label": "anchorgenius",
        "focused": false,
        "activeTabId": "w2Z:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "workspaceId": "w9",
        "number": 1,
        "label": "workspace-kaz",
        "focused": true,
        "activeTabId": "w9:t1",
        "tabCount": 1,
        "paneCount": 1,
        "host": "minibuch"
      },
      {
        "workspaceId": "wA",
        "number": 2,
        "label": "nixos-configuration",
        "focused": false,
        "activeTabId": "wA:t1",
        "tabCount": 2,
        "paneCount": 3,
        "host": "minibuch"
      }
    ],
    "tabs": [
      {
        "tabId": "w654f9f0c0dd67e:t1",
        "workspaceId": "w654f9f0c0dd67e",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w1T:tR",
        "workspaceId": "w1T",
        "number": 24,
        "label": "work",
        "focused": false,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2H:t1",
        "workspaceId": "w2H",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2T:t1",
        "workspaceId": "w2T",
        "number": 1,
        "label": "work",
        "focused": false,
        "paneCount": 2,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2Y:t2",
        "workspaceId": "w2Y",
        "number": 2,
        "label": "openplate",
        "focused": true,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2Y:tH",
        "workspaceId": "w2Y",
        "number": 17,
        "label": "translate",
        "focused": false,
        "paneCount": 2,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2Y:tJ",
        "workspaceId": "w2Y",
        "number": 18,
        "label": "bay",
        "focused": false,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w2Z:t1",
        "workspaceId": "w2Z",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 1,
        "host": "collie-04rj6a"
      },
      {
        "tabId": "w9:t1",
        "workspaceId": "w9",
        "number": 1,
        "label": "1",
        "focused": true,
        "paneCount": 1,
        "host": "minibuch"
      },
      {
        "tabId": "wA:t1",
        "workspaceId": "wA",
        "number": 1,
        "label": "1",
        "focused": false,
        "paneCount": 2,
        "host": "minibuch"
      },
      {
        "tabId": "wA:t2",
        "workspaceId": "wA",
        "number": 2,
        "label": "2 👜",
        "focused": false,
        "paneCount": 1,
        "host": "minibuch"
      }
    ],
    "sessions": [
      {
        "name": "default",
        "isPrimary": true,
        "reachable": true,
        "agents": 8,
        "working": 7,
        "blocked": 0,
        "host": "collie-04rj6a"
      },
      {
        "name": "collie-demo",
        "isPrimary": false,
        "reachable": true,
        "agents": 5,
        "working": 0,
        "blocked": 0,
        "host": "collie-04rj6a"
      },
      {
        "name": "default",
        "isPrimary": true,
        "reachable": true,
        "agents": 3,
        "working": 1,
        "blocked": 0,
        "host": "minibuch"
      }
    ],
    "ts": 1788344864196,
    "servers": [
      {
        "id": "collie-04rj6a",
        "name": "bluefin",
        "isLead": true,
        "reachable": true,
        "protocol": "ok",
        "lastSeenAt": 1788344864196
      },
      {
        "id": "minibuch",
        "name": "minibuch",
        "isLead": false,
        "reachable": true,
        "protocol": "ok",
        "lastSeenAt": 1788344862730
      }
    ]
  };
