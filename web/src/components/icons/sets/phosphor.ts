import type { IconKey } from "../keys";

// PHOSPHOR, one map for its three weights: the glyph of each key in @phosphor-icons/core, by its file name without the extension (the regular weight's name; the fill and duotone files add `-fill` and `-duotone`).
// `null` means the family has no glyph that says the same thing; that key then draws its lucide glyph
// under this family (`sets.test.ts` lists every such fallback). The build (`web/vite-glyphs.ts`) reads
// only the files named here, from `assets/regular`, `assets/fill` (`<name>-fill.svg`) and `assets/duotone` (`<name>-duotone.svg`), so a set chunk holds the mapped glyphs and nothing else.

export const PHOSPHOR = {
  "action-archive": "archive", // program action: archive · lucide Archive
  "action-check": "check", // program action: check · lucide Check
  "action-flag": "flag", // program action: flag · lucide Flag
  "action-more": "dots-three", // program action: more · lucide Ellipsis
  "action-note": "note", // program action: note · lucide StickyNote
  "action-pause": "pause", // program action: pause · lucide Pause
  "action-play": "play", // program action: play · lucide Play
  "action-refresh": "arrows-clockwise", // program action: refresh · lucide RefreshCw
  "action-search": "magnifying-glass", // program action: search · lucide Search
  "action-send": "paper-plane-right", // program action: send · lucide Send
  "action-star": "star", // program action: star · lucide Star
  "action-x": "x", // a program action drawn as an X · lucide X
  "add": "plus", // add · lucide Plus
  "add-note": "note-pencil", // add a note · lucide MessageSquarePlus
  "add-row": "rows-plus-bottom", // add a row · lucide Rows3
  "agent-commands": "terminal", // the agent's own slash commands · lucide Slash
  "all-options": "list-checks", // show all options · lucide ListChecks
  "answered": "check", // this question is answered · lucide Check
  "archived": "archive", // an archived item · lucide Archive
  "attach": "paperclip", // attach files · lucide Paperclip
  "attach-open": "plus", // the attach button while the composer box is open · lucide Plus
  "attachment-in-front": "arrow-line-left", // an attachment placed in front of the text · lucide ArrowLeftToLine
  "auth-token": "key", // token or key · lucide KeyRound
  "back": "arrow-left", // go back · lucide ArrowLeft
  "belt-size": "rows", // belt size setting · lucide Rows3
  "branch": "git-branch", // a git branch · lucide GitBranch
  "branch-off": "git-fork", // start a branch · lucide GitBranchPlus
  "bridge-unreachable": "cloud-slash", // the bridge does not answer · lucide CloudOff
  "busy": "spinner-gap", // busy, working (spinner) · lucide LoaderCircle
  "cache-age": "hourglass", // cache age · lucide Hourglass
  "change-options": "sliders-horizontal", // change options · lucide SlidersHorizontal
  "changes": "git-diff", // changed files · lucide GitCompare
  "check-for-updates": "arrows-clockwise", // check for updates · lucide RefreshCw
  "clear": "x", // clear a field or the draft · lucide X
  "clear-keys": "eraser", // clear the keys pad · lucide Eraser
  "close": "x", // close a sheet, bar or screen · lucide X
  "close-pane": "x-circle", // close a pane or tab · lucide CircleX
  "command": "terminal-window", // command · lucide SquareTerminal
  "command-takes-arg": "pencil-simple", // command needs an argument · lucide Pencil
  "comment": "chat", // a comment on a diff · lucide MessageSquare
  "commit": "git-commit", // a commit · lucide GitCommitHorizontal
  "compactions": "scissors", // compactions · lucide Scissors
  "confirm": "check", // armed, tap again to confirm · lucide Check
  "connecting": "plug", // connecting to the bridge · lucide Plug
  "connection": "plug", // connection details · lucide Plug
  "copied": "check", // copied to the clipboard · lucide Check
  "copy": "copy", // copy · lucide Copy
  "copy-failed": "x", // the copy failed · lucide X
  "crew": "network", // the crew of machines · lucide Network
  "decision-dismissed": "x", // a Decision that was dismissed · lucide X
  "decision-superseded": "arrows-clockwise", // a Decision a newer one replaced · lucide RefreshCw
  "decision-withdrawn": "arrow-left", // a Decision its poster took back · lucide ArrowLeft
  "delete": "trash", // delete · lucide Trash2
  "detached-head": "git-commit", // HEAD is on a commit, not a branch · lucide GitCommitHorizontal
  "direct-typing": "keyboard", // keystrokes go straight to the terminal · lucide Keyboard
  "discard": "trash", // discard the recording · lucide Trash2
  "disclosure": "caret-right", // expand or collapse (drawn pointing right) · lucide ChevronRight
  "dismiss": "x", // dismiss a notice, hint or banner · lucide X
  "display-settings": "faders-horizontal", // display settings · lucide Settings2
  "done": "check", // done, finished · lucide Check
  "download": "download-simple", // download · lucide Download
  "edit": "pencil-simple", // edit or rename · lucide Pencil
  "editor-close": "arrows-in-simple", // leave the full-screen editor · lucide Minimize2
  "editor-open": "arrows-out-simple", // open the full-screen editor · lucide Maximize2
  "empty-state": "tray", // nothing to show here · lucide Inbox
  "error": "warning-circle", // an error · lucide CircleAlert
  "expand": "caret-down", // expand or collapse (drawn pointing down) · lucide ChevronDown
  "experiments": "flask", // experimental settings · lucide FlaskConical
  "file": "file", // a file · lucide File
  "file-added": "file-plus", // file added · lucide FilePlus
  "file-deleted": "file-minus", // file deleted · lucide FileMinus
  "file-modified": "note-pencil", // file modified · lucide FilePen
  "file-next": "caret-right", // next file · lucide ChevronRight
  "file-prev": "caret-left", // previous file · lucide ChevronLeft
  "file-renamed": "file-arrow-down", // file renamed · lucide FileInput
  "file-text": "file-text", // a text file · lucide FileText
  "files": "tree-view", // files · lucide ListTree
  "filter": "funnel", // filter a list · lucide ListFilter
  "find-in-pane": "magnifying-glass", // find text in the pane · lucide Search
  "find-next": "caret-down", // next match or message · lucide ChevronDown
  "find-prev": "caret-up", // previous match or message · lucide ChevronUp
  "fix": "wrench", // repair · lucide Wrench
  "focus-on-machine": "monitor", // focus the pane on the machine's own screen · lucide Monitor
  "folder": "folder", // a folder · lucide Folder
  "folder-added": "folder-plus", // a folder with a new file · lucide FolderPlus
  "folder-open": "folder-open", // folder opened · lucide FolderOpen
  "folder-up": "arrow-elbow-left-up", // go up one folder · lucide CornerLeftUp
  "font": "text-t", // font · lucide Type
  "hand": "hand", // which hand holds the phone · lucide Hand
  "haptics": "vibrate", // vibration feedback · lucide Vibrate
  "harness-bar": "sliders-horizontal", // agent command bar setting · lucide SlidersHorizontal
  "harness-compact": "arrows-in", // compact the context (agent command) · lucide Shrink
  "harness-effort": "gauge", // set effort (agent command) · lucide Gauge
  "harness-history": "clock-counter-clockwise", // branch from an earlier prompt (agent command) · lucide History
  "harness-model": "cpu", // pick the model (agent command) · lucide Cpu
  "harness-plan": "tree-view", // plan mode on, off or read (agent command) · lucide ListTree
  "harness-resume": "clock-counter-clockwise", // resume an earlier session (agent command) · lucide History
  "harness-tree": "tree-view", // session tree (agent command) · lucide ListTree
  "harnesses": "robot", // harnesses · lucide Bot
  "hide-ignored": "eye-slash", // ignored files are hidden · lucide EyeOff
  "hill": "mountains", // the Hill, where Decisions wait · lucide Mountain
  "hill-now": "mountains", // the Hill while a `now` Decision is open · lucide MountainSnow
  "history-screen": "scroll", // the scrollback history screen · lucide ScrollText
  "image": "image", // an image · lucide Image
  "image-next": "caret-right", // the next picture in the picture sheet · lucide ChevronRight
  "image-prev": "caret-left", // the previous picture in the picture sheet · lucide ChevronLeft
  "info": "info", // information, or the facts of an option · lucide Info
  "install-app": "tray-arrow-down", // install the app · lucide MonitorDown
  "jobs": "timer", // running jobs · lucide Timer
  "key-down": "arrow-down", // the Down arrow key sent to the agent · lucide ArrowDown
  "key-enter": "key-return", // the Enter key · lucide CornerDownLeft
  "key-left": "arrow-left", // the Left arrow key sent to the agent · lucide ArrowLeft
  "key-right": "arrow-right", // the Right arrow key sent to the agent · lucide ArrowRight
  "key-shift": "arrow-fat-up", // the Shift key on the keys pad · lucide ArrowBigUp
  "key-space": null, // the Space key · lucide Space
  "key-tab": "arrow-line-right", // the Tab key · lucide ArrowRightToLine
  "key-up": "arrow-up", // the Up arrow key sent to the agent · lucide ArrowUp
  "keys-drawer": "keyboard", // open the keys dock · lucide Keyboard
  "language": "translate", // language setting · lucide Globe
  "launch": "play", // launch an agent · lucide Play
  "leaves-network": "globe", // audio leaves the host network · lucide Globe
  "link": "link", // a link · lucide Link2
  "load-earlier": "arrow-line-up", // load earlier history · lucide ArrowUpToLine
  "locked": "lock", // locked or read only · lucide Lock
  "machine": "hard-drives", // a machine (host) · lucide Server
  "machine-activity": "pulse", // machine activity · lucide Activity
  "machine-offline": "plugs", // a machine that is offline · lucide ServerOff
  "masked": "eye-slash", // content is masked · lucide EyeOff
  "math": "sigma", // math setting · lucide Sigma
  "message-agent": "robot", // a message from the agent · lucide Bot
  "message-sent": "paper-plane-right", // a message I sent · lucide Send
  "message-tool": "wrench", // message tool · lucide Wrench
  "messages": "chats", // messages · lucide MessagesSquare
  "mic": "microphone", // microphone · lucide Mic
  "mod-age": "clock", // how old a mod's facts are · lucide Clock
  "mod-icon-activity": "pulse", // a mod's own icon, the word `activity` · lucide Activity
  "mod-icon-alert": "warning", // a mod's own icon, the word `alert` · lucide TriangleAlert
  "mod-icon-archive": "archive", // a mod's own icon, the word `archive` · lucide Archive
  "mod-icon-bell": "bell", // a mod's own icon, the word `bell` · lucide Bell
  "mod-icon-bot": "robot", // a mod's own icon, the word `bot` · lucide Bot
  "mod-icon-branch": "git-branch", // a mod's own icon, the word `branch` · lucide GitBranch
  "mod-icon-bug": "bug", // a mod's own icon, the word `bug` · lucide Bug
  "mod-icon-chart": "chart-bar", // a mod's own icon, the word `chart` · lucide ChartColumn
  "mod-icon-check": "check", // a mod's own icon, the word `check` · lucide Check
  "mod-icon-clock": "clock", // a mod's own icon, the word `clock` · lucide Clock
  "mod-icon-commit": "git-commit", // a mod's own icon, the word `commit` · lucide GitCommitHorizontal
  "mod-icon-cpu": "cpu", // a mod's own icon, the word `cpu` · lucide Cpu
  "mod-icon-disk": "hard-drive", // a mod's own icon, the word `disk` · lucide HardDrive
  "mod-icon-file": "file-text", // a mod's own icon, the word `file` · lucide FileText
  "mod-icon-flag": "flag", // a mod's own icon, the word `flag` · lucide Flag
  "mod-icon-flask": "flask", // a mod's own icon, the word `flask` · lucide FlaskConical
  "mod-icon-folder": "folder", // a mod's own icon, the word `folder` · lucide Folder
  "mod-icon-gauge": "gauge", // a mod's own icon, the word `gauge` · lucide Gauge
  "mod-icon-globe": "globe", // a mod's own icon, the word `globe` · lucide Globe
  "mod-icon-inbox": "tray", // a mod's own icon, the word `inbox` · lucide Inbox
  "mod-icon-info": "info", // a mod's own icon, the word `info` · lucide Info
  "mod-icon-link": "arrow-square-out", // a mod's own icon, the word `link` · lucide ExternalLink
  "mod-icon-list": "list-checks", // a mod's own icon, the word `list` · lucide ListTodo
  "mod-icon-lock": "lock", // a mod's own icon, the word `lock` · lucide Lock
  "mod-icon-message": "chat", // a mod's own icon, the word `message` · lucide MessageSquare
  "mod-icon-more": "dots-three", // a mod's own icon, the word `more` · lucide Ellipsis
  "mod-icon-note": "note", // a mod's own icon, the word `note` · lucide StickyNote
  "mod-icon-pause": "pause", // a mod's own icon, the word `pause` · lucide Pause
  "mod-icon-play": "play", // a mod's own icon, the word `play` · lucide Play
  "mod-icon-plug": "plug", // a mod's own icon, the word `plug` · lucide Plug
  "mod-icon-refresh": "arrows-clockwise", // a mod's own icon, the word `refresh` · lucide RefreshCw
  "mod-icon-search": "magnifying-glass", // a mod's own icon, the word `search` · lucide Search
  "mod-icon-send": "paper-plane-right", // a mod's own icon, the word `send` · lucide Send
  "mod-icon-server": "hard-drives", // a mod's own icon, the word `server` · lucide Server
  "mod-icon-settings": "faders-horizontal", // a mod's own icon, the word `settings` · lucide Settings2
  "mod-icon-shield": "shield", // a mod's own icon, the word `shield` · lucide Shield
  "mod-icon-star": "star", // a mod's own icon, the word `star` · lucide Star
  "mod-icon-terminal": "terminal-window", // a mod's own icon, the word `terminal` · lucide SquareTerminal
  "mod-icon-timer": "timer", // a mod's own icon, the word `timer` · lucide Timer
  "mod-icon-trash": "trash", // a mod's own icon, the word `trash` · lucide Trash2
  "mod-icon-user": "user", // a mod's own icon, the word `user` · lucide User
  "mod-icon-wrench": "wrench", // a mod's own icon, the word `wrench` · lucide Wrench
  "mod-icon-x": "x", // a mod's own icon, the word `x` · lucide X
  "mod-icon-zap": "lightning", // a mod's own icon, the word `zap` · lucide Zap
  "mod-paused": "pause", // a mod that is paused · lucide Pause
  "mod-step-done": "check", // a mod's step: done · lucide Check
  "mod-step-failed": "x", // a mod's step: failed · lucide X
  "mod-step-running": "play", // a mod's step: running · lucide Play
  "mod-step-todo": "minus", // a mod's step: not started · lucide Minus
  "mod-trouble": "warning", // a mod that failed or cannot be reached · lucide TriangleAlert
  "mod-unknown": "question", // a mod mark whose state is not known · lucide CircleQuestionMark
  "modifier-lock": "lock", // a modifier key is locked · lucide Lock
  "mods": "plug", // the Mods settings section · lucide Plug
  "more-actions": "dots-three", // open the actions menu of a block · lucide Ellipsis
  "needs-you": "radio-button", // only panes that need me · lucide CircleDot
  "new-agent": "plus", // start a new agent · lucide Plus
  "new-shell": "terminal-window", // open a new shell · lucide SquareTerminal
  "new-space": "folder-plus", // new space · lucide FolderPlus
  "note": "note", // note · lucide StickyNote
  "notifications": "bell", // push notifications · lucide Bell
  "notifications-snooze": "bell-z", // snooze notifications · lucide BellOff
  "offline": "wifi-slash", // the phone is offline · lucide WifiOff
  "ok": "check", // a calm tick in a notice: it went through · lucide Check
  "open-beside": "columns", // open beside the current pane · lucide Columns2
  "open-external": "arrow-square-out", // open in another place · lucide ExternalLink
  "open-here": "swap", // open here · lucide Replace
  "option-pointer": "caret-right", // cursor on the option the agent menu points at · lucide ChevronRight
  "pairing": "key", // pair this phone with the bridge · lucide KeyRound
  "pane-count": "squares-four", // count of panes · lucide LayoutGrid
  "pane-menu": "dots-three-vertical", // open the pane menu (header) · lucide EllipsisVertical
  "pane-nav-down": "arrow-down", // pane navigation down · lucide ArrowDown
  "pane-nav-left": "arrow-left", // pane navigation left · lucide ArrowLeft
  "pane-nav-right": "arrow-right", // pane navigation right · lucide ArrowRight
  "pane-nav-up": "arrow-up", // pane navigation up · lucide ArrowUp
  "pane-navigation": "arrows-out-cardinal", // pane navigation setting · lucide Move
  "pane-settings": "sliders-horizontal", // pane settings · lucide SlidersHorizontal
  "pane-switcher": "stack", // switch pane (belt Switch mark) · lucide Layers
  "paste": "clipboard-text", // paste from the clipboard · lucide ClipboardPaste
  "phone": "device-mobile", // this phone · lucide Smartphone
  "phone-draft": "device-mobile", // a draft kept on this phone · lucide Smartphone
  "pin": "push-pin", // pin · lucide Pin
  "pinned-mark": "push-pin", // mark on a pinned block · lucide Pin
  "pins-list": "push-pin", // the pinned messages list · lucide Pin
  "plan-blocked": "warning-circle", // plan step blocked · lucide CircleAlert
  "plan-done": "check", // plan step done · lucide Check
  "plan-dropped": "minus-circle", // plan step dropped · lucide CircleMinus
  "plan-in-progress": "radio-button", // plan step in progress · lucide CircleDot
  "plan-pending": "circle", // plan step not started · lucide Circle
  "prompt-earlier": "arrow-line-up", // jump to an earlier prompt · lucide ArrowUpToLine
  "prompt-user": "user", // the pinned prompt · lucide User
  "queued": "clock", // queued, not yet sent · lucide Clock
  "quick-actions": "lightning", // quick actions · lucide Zap
  "recommended": "star", // the option the poster recommends · lucide Star
  "refresh": "arrows-clockwise", // refresh or reload · lucide RefreshCw
  "release-line": "git-branch", // release line (Stable or Edge) · lucide GitBranch
  "remove": "x", // remove one item from a list · lucide X
  "remove-from-view": "eye-slash", // remove a pane from the wide view · lucide EyeOff
  "reopen": "arrow-counter-clockwise", // reopen a closed conversation · lucide RotateCcw
  "report-problem": "bug", // report a problem · lucide Bug
  "restore": "arrow-counter-clockwise", // restore defaults or run again · lucide RotateCcw
  "retry": "arrows-clockwise", // try again · lucide RefreshCw
  "reuse-last": "clock-counter-clockwise", // reuse the last launch · lucide History
  "role-deputy": "shield", // this machine is the deputy · lucide Shield
  "role-lead": "crown", // this machine leads the crew · lucide Crown
  "rollback": "arrow-counter-clockwise", // roll back to the previous version · lucide RotateCcw
  "row-go": "caret-right", // this row opens another screen · lucide ChevronRight
  "run-command": "key-return", // run a command · lucide CornerDownLeft
  "saved-copy": "clock-counter-clockwise", // the screen shown is a saved copy · lucide History
  "screen": "monitor", // the screen view · lucide Monitor
  "scroll-hint-left": "caret-left", // more content to the left · lucide ChevronLeft
  "scroll-hint-right": "caret-right", // more content to the right · lucide ChevronRight
  "scroll-to-latest": "arrow-down", // scroll to the newest message · lucide ArrowDown
  "search": "magnifying-glass", // search · lucide Search
  "secret-input": "key", // a typed secret is not echoed · lucide KeyRound
  "section-device": "sliders-horizontal", // settings section: device · lucide SlidersHorizontal
  "select-caret": "caret-down", // caret of a dropdown · lucide ChevronDown
  "select-text": "cursor-text", // select text · lucide SquareDashedText
  "selected": "check", // this row or box is chosen · lucide Check
  "send": "paper-plane-right", // send · lucide Send
  "send-now": "key-return", // send the queued line now · lucide CornerDownLeft
  "send-ready": "arrow-up", // the send button once the box holds text · lucide ArrowUp
  "sent-history": "list-bullets", // sent lines record · lucide ListEnd
  "sent-ok": "check", // the send or key press went through (brief state) · lucide Check
  "sent-suggestions": "textbox", // sent line suggestions · lucide TextCursorInput
  "session": "stack", // the multiplexer session · lucide Layers
  "settings": "gear", // settings · lucide Settings
  "share-menu": "share", // the iOS Share button · lucide Share
  "shell-pane": "terminal-window", // a pane that is a bare shell · lucide SquareTerminal
  "show-ignored": "eye", // ignored files are shown · lucide Eye
  "show-terminal-view": "terminal-window", // show the terminal behind a card · lucide SquareTerminal
  "sidebar-hide": "sidebar-simple", // hide the sidebar · lucide PanelLeftClose
  "sidebar-show": "sidebar-simple", // show the sidebar · lucide PanelLeftOpen
  "sign-in": "sign-in", // sign in · lucide LogIn
  "slash-command": "terminal", // slash command · lucide Slash
  "sort-by-place": "tree-structure", // sort panes by place · lucide FolderTree
  "sort-order": "arrows-down-up", // the pane sort order setting · lucide ArrowDownUp
  "space-next": "caret-down", // next space · lucide ChevronDown
  "space-prev": "caret-up", // previous space · lucide ChevronUp
  "star-folder": "star", // star a folder · lucide Star
  "steer": "navigation-arrow", // steer a running turn · lucide Navigation
  "step-next": "caret-right", // next step · lucide ChevronRight
  "step-prev": "caret-left", // previous step · lucide ChevronLeft
  "stop": "stop", // stop (a turn, a program, a recording) · lucide Square
  "storage": "hard-drive", // local storage · lucide HardDrive
  "subagent": "robot", // agents the pane runs · lucide Bot
  "success": "check-circle", // success · lucide CircleCheck
  "tab-dashboard": "rows", // Dashboard tab · lucide Rows3
  "tab-fold": "caret-up", // fold or unfold the tab strip · lucide ChevronUp
  "telemetry": "chart-bar", // the install count ping · lucide ChartColumn
  "terminal-draft": "terminal", // terminal draft · lucide Terminal
  "text-larger": null, // make text larger · lucide AArrowUp
  "text-smaller": null, // make text smaller · lucide AArrowDown
  "theme": "palette", // theme picker · lucide Palette
  "theme-dark": "moon", // dark theme · lucide Moon
  "theme-light": "sun", // light theme · lucide Sun
  "theme-system": "devices", // theme follows the system · lucide MonitorSmartphone
  "time": "clock", // time or recency · lucide Clock
  "todos": "list-checks", // the agent's to-do list · lucide ListTodo
  "tool": "wrench", // a tool call · lucide Wrench
  "tool-create-file": "file-plus", // a tool call that creates a file · lucide FilePlusCorner
  "tool-delete": "trash", // a tool call that deletes · lucide Trash2
  "tool-edit": "pencil-simple", // a tool call that edits a file · lucide Pencil
  "tool-execute": "terminal-window", // a command tool call · lucide SquareTerminal
  "tool-fetch": "globe", // a fetch or web tool call · lucide Globe
  "tool-move": "arrows-left-right", // a tool call that moves a file · lucide ArrowRightLeft
  "tool-other": "wrench", // another tool call · lucide Wrench
  "tool-plan": "list-checks", // a plan tool call · lucide ListTodo
  "tool-question": "question", // a question tool call · lucide CircleQuestionMark
  "tool-read": "file-text", // a read tool call · lucide FileText
  "tool-search": "magnifying-glass", // a search tool call · lucide Search
  "tool-task": "robot", // a task or subagent tool call · lucide Bot
  "tour": "compass", // the guided tour · lucide Compass
  "type-into-terminal": "terminal", // type into the terminal · lucide Terminal
  "typeface": "text-aa", // the typeface setting · lucide CaseSensitive
  "undo": "arrow-u-up-left", // undo · lucide Undo2
  "unpin": "push-pin-slash", // unpin · lucide PinOff
  "update-available": "arrow-circle-up", // an update is available · lucide CircleArrowUp
  "update-step-done": "check", // update step done · lucide Check
  "update-step-failed": "x", // update step failed · lucide X
  "update-step-skipped": "minus", // update step skipped · lucide Minus
  "update-step-warning": "warning", // update step needs attention · lucide TriangleAlert
  "user-turn": "user", // a turn or message by the person · lucide User
  "view-chat": "chats", // switch to the chat view · lucide MessagesSquare
  "view-diff": "git-diff", // show the diff view · lucide GitCompareArrows
  "view-preview": "eye", // show the preview view · lucide Eye
  "view-source": "code", // show file source · lucide Code
  "view-terminal": "terminal-window", // switch to the terminal view · lucide SquareTerminal
  "voice-broken": "x-circle", // voice option is broken · lucide CircleX
  "voice-model": "waveform", // the voice model · lucide AudioLines
  "voice-on-host": "hard-drives", // voice runs on the host machine · lucide Server
  "voice-on-phone": "device-mobile", // voice runs on this phone · lucide Smartphone
  "voice-paused": "pause-circle", // voice option is paused · lucide CirclePause
  "voice-ready": "check-circle", // voice option works · lucide CircleCheck
  "voice-setup": "circle-dashed", // voice option needs setup · lucide CircleDashed
  "warning": "warning", // a warning · lucide TriangleAlert
  "wide-layout": "sidebar", // wide layout · lucide PanelLeft
  "zen-enter": "arrows-out-simple", // zen mode · lucide Maximize2
  "zen-exit": "arrows-in-simple", // leave zen mode · lucide Minimize2
  "zoom": "magnifying-glass-plus", // zoom · lucide ZoomIn
  "zoom-in": "plus", // zoom in · lucide Plus
  "zoom-out": "minus", // zoom out · lucide Minus
} as const satisfies Record<IconKey, string | null>;

/**
 * Phosphor names the Fill set draws in the REGULAR weight. Phosphor's fill drawings of these put the
 * mark inside a solid square (x, check, minus) or turn an empty ring solid (circle, circle-dashed), so
 * a cross would stop reading as a cross and "not started" would read as done. Every key mapped to one
 * of these names keeps the regular outline under `phosphor-fill`; KEYS.md lists them.
 */
export const PHOSPHOR_FILL_KEEPS_REGULAR: readonly string[] = ["x", "check", "minus", "circle", "circle-dashed"];
