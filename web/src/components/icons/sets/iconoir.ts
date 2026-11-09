import type { IconKey } from "../keys";

// ICONOIR: the glyph of each key in iconoir, by its file name without the extension.
// `null` means the family has no glyph that says the same thing; that key then draws its lucide glyph
// under this family (`sets.test.ts` lists every such fallback). The build (`web/vite-glyphs.ts`) reads
// only the files named here, from `icons/regular`, so a set chunk holds the mapped glyphs and nothing else.

export const ICONOIR = {
  "action-archive": "archive", // program action: archive · lucide Archive
  "action-check": "check", // program action: check · lucide Check
  "action-flag": "triangle-flag", // program action: flag · lucide Flag
  "action-more": "more-horiz", // program action: more · lucide Ellipsis
  "action-note": "notes", // program action: note · lucide StickyNote
  "action-pause": "pause", // program action: pause · lucide Pause
  "action-play": "play", // program action: play · lucide Play
  "action-refresh": "refresh", // program action: refresh · lucide RefreshCw
  "action-search": "search", // program action: search · lucide Search
  "action-send": "send", // program action: send · lucide Send
  "action-star": "star", // program action: star · lucide Star
  "action-x": "xmark", // a program action drawn as an X · lucide X
  "add": "plus", // add · lucide Plus
  "add-note": "chat-plus-in", // add a note · lucide MessageSquarePlus
  "add-row": "grid-plus", // add a row · lucide Rows3
  "agent-commands": "slash", // the agent's own slash commands · lucide Slash
  "all-options": "task-list", // show all options · lucide ListChecks
  "answered": "check", // this question is answered · lucide Check
  "archived": "archive", // an archived item · lucide Archive
  "attach": "attachment", // attach files · lucide Paperclip
  "attach-open": "plus", // the attach button while the composer box is open · lucide Plus
  "attachment-in-front": "fast-arrow-left", // an attachment placed in front of the text · lucide ArrowLeftToLine
  "auth-token": "key", // token or key · lucide KeyRound
  "back": "arrow-left", // go back · lucide ArrowLeft
  "belt-size": "table-rows", // belt size setting · lucide Rows3
  "branch": "git-branch", // a git branch · lucide GitBranch
  "branch-off": "git-fork", // start a branch · lucide GitBranchPlus
  "bridge-unreachable": "cloud-xmark", // the bridge does not answer · lucide CloudOff
  "busy": null, // busy, working (spinner) · lucide LoaderCircle
  "cache-age": "hourglass", // cache age · lucide Hourglass
  "change-options": "control-slider", // change options · lucide SlidersHorizontal
  "changes": "git-compare", // changed files · lucide GitCompare
  "check-for-updates": "refresh", // check for updates · lucide RefreshCw
  "clear": "xmark", // clear a field or the draft · lucide X
  "clear-keys": "erase", // clear the keys pad · lucide Eraser
  "close": "xmark", // close a sheet, bar or screen · lucide X
  "close-pane": "xmark-circle", // close a pane or tab · lucide CircleX
  "command": "terminal", // command · lucide SquareTerminal
  "command-takes-arg": "edit-pencil", // command needs an argument · lucide Pencil
  "comment": "message", // a comment on a diff · lucide MessageSquare
  "commit": "git-commit", // a commit · lucide GitCommitHorizontal
  "compactions": "scissor", // compactions · lucide Scissors
  "confirm": "check", // armed, tap again to confirm · lucide Check
  "connecting": "plug-type-a", // connecting to the bridge · lucide Plug
  "connection": "plug-type-a", // connection details · lucide Plug
  "copied": "check", // copied to the clipboard · lucide Check
  "copy": "copy", // copy · lucide Copy
  "copy-failed": "xmark", // the copy failed · lucide X
  "crew": "network", // the crew of machines · lucide Network
  "delete": "trash", // delete · lucide Trash2
  "detached-head": "git-commit", // HEAD is on a commit, not a branch · lucide GitCommitHorizontal
  "direct-typing": "dialpad", // keystrokes go straight to the terminal · lucide Keyboard
  "discard": "trash", // discard the recording · lucide Trash2
  "disclosure": "nav-arrow-right", // expand or collapse (drawn pointing right) · lucide ChevronRight
  "dismiss": "xmark", // dismiss a notice, hint or banner · lucide X
  "display-settings": "control-slider", // display settings · lucide Settings2
  "done": "check", // done, finished · lucide Check
  "download": "download", // download · lucide Download
  "edit": "edit-pencil", // edit or rename · lucide Pencil
  "editor-close": "reduce", // leave the full-screen editor · lucide Minimize2
  "editor-open": "enlarge", // open the full-screen editor · lucide Maximize2
  "empty-state": "drawer", // nothing to show here · lucide Inbox
  "error": "warning-circle", // an error · lucide CircleAlert
  "expand": "nav-arrow-down", // expand or collapse (drawn pointing down) · lucide ChevronDown
  "experiments": "flask", // experimental settings · lucide FlaskConical
  "file": "empty-page", // a file · lucide File
  "file-added": "page-plus", // file added · lucide FilePlus
  "file-deleted": "page-minus", // file deleted · lucide FileMinus
  "file-modified": "page-edit", // file modified · lucide FilePen
  "file-next": "nav-arrow-right", // next file · lucide ChevronRight
  "file-prev": "nav-arrow-left", // previous file · lucide ChevronLeft
  "file-renamed": "import", // file renamed · lucide FileInput
  "file-text": "page", // a text file · lucide FileText
  "files": "view-structure-down", // files · lucide ListTree
  "filter": "filter", // filter a list · lucide ListFilter
  "find-in-pane": "search", // find text in the pane · lucide Search
  "find-next": "nav-arrow-down", // next match or message · lucide ChevronDown
  "find-prev": "nav-arrow-up", // previous match or message · lucide ChevronUp
  "fix": "wrench", // repair · lucide Wrench
  "focus-on-machine": "computer", // focus the pane on the machine's own screen · lucide Monitor
  "folder": "folder", // a folder · lucide Folder
  "folder-added": "folder-plus", // a folder with a new file · lucide FolderPlus
  "folder-open": "folder", // folder opened · lucide FolderOpen
  "folder-up": "long-arrow-left-up", // go up one folder · lucide CornerLeftUp
  "font": "type", // font · lucide Type
  "hand": "drag-hand-gesture", // which hand holds the phone · lucide Hand
  "haptics": "sine-wave", // vibration feedback · lucide Vibrate
  "harness-bar": "control-slider", // agent command bar setting · lucide SlidersHorizontal
  "harness-compact": "compress", // compact the context (agent command) · lucide Shrink
  "harness-effort": "dashboard-speed", // set effort (agent command) · lucide Gauge
  "harness-model": "cpu", // pick the model (agent command) · lucide Cpu
  "harness-resume": "clock-rotate-right", // resume an earlier session (agent command) · lucide History
  "harness-tree": "view-structure-down", // session tree (agent command) · lucide ListTree
  "harnesses": "sparks", // harnesses · lucide Bot
  "hide-ignored": "eye-closed", // ignored files are hidden · lucide EyeOff
  "history-screen": "journal-page", // the scrollback history screen · lucide ScrollText
  "image": "media-image", // an image · lucide Image
  "info": "info-circle", // information, or the facts of an option · lucide Info
  "install-app": "download-data-window", // install the app · lucide MonitorDown
  "jobs": "timer", // running jobs · lucide Timer
  "key-down": "arrow-down", // the Down arrow key sent to the agent · lucide ArrowDown
  "key-enter": "long-arrow-down-left", // the Enter key · lucide CornerDownLeft
  "key-left": "arrow-left", // the Left arrow key sent to the agent · lucide ArrowLeft
  "key-right": "arrow-right", // the Right arrow key sent to the agent · lucide ArrowRight
  "key-shift": "fast-arrow-up", // the Shift key on the keys pad · lucide ArrowBigUp
  "key-space": null, // the Space key · lucide Space
  "key-tab": "fast-arrow-right", // the Tab key · lucide ArrowRightToLine
  "key-up": "arrow-up", // the Up arrow key sent to the agent · lucide ArrowUp
  "keys-drawer": "dialpad", // open the keys dock · lucide Keyboard
  "language": "language", // language setting · lucide Globe
  "launch": "play", // launch an agent · lucide Play
  "leaves-network": "globe", // audio leaves the host network · lucide Globe
  "link": "link", // a link · lucide Link2
  "load-earlier": "arrows-up-from-line", // load earlier history · lucide ArrowUpToLine
  "locked": "lock", // locked or read only · lucide Lock
  "machine": "server", // a machine (host) · lucide Server
  "machine-activity": "activity", // machine activity · lucide Activity
  "machine-offline": "cloud-desync", // a machine that is offline · lucide ServerOff
  "masked": "eye-closed", // content is masked · lucide EyeOff
  "math": "sigma-function", // math setting · lucide Sigma
  "message-agent": "sparks", // a message from the agent · lucide Bot
  "message-sent": "send", // a message I sent · lucide Send
  "message-tool": "wrench", // message tool · lucide Wrench
  "messages": "multi-bubble", // messages · lucide MessagesSquare
  "mic": "microphone", // microphone · lucide Mic
  "mod-age": "clock", // how old a mod's facts are · lucide Clock
  "mod-icon-activity": "activity", // a mod's own icon, the word `activity` · lucide Activity
  "mod-icon-alert": "warning-triangle", // a mod's own icon, the word `alert` · lucide TriangleAlert
  "mod-icon-archive": "archive", // a mod's own icon, the word `archive` · lucide Archive
  "mod-icon-bell": "bell", // a mod's own icon, the word `bell` · lucide Bell
  "mod-icon-bot": "sparks", // a mod's own icon, the word `bot` · lucide Bot
  "mod-icon-branch": "git-branch", // a mod's own icon, the word `branch` · lucide GitBranch
  "mod-icon-bug": "bug", // a mod's own icon, the word `bug` · lucide Bug
  "mod-icon-chart": "stats-report", // a mod's own icon, the word `chart` · lucide ChartColumn
  "mod-icon-check": "check", // a mod's own icon, the word `check` · lucide Check
  "mod-icon-clock": "clock", // a mod's own icon, the word `clock` · lucide Clock
  "mod-icon-commit": "git-commit", // a mod's own icon, the word `commit` · lucide GitCommitHorizontal
  "mod-icon-cpu": "cpu", // a mod's own icon, the word `cpu` · lucide Cpu
  "mod-icon-disk": "hard-drive", // a mod's own icon, the word `disk` · lucide HardDrive
  "mod-icon-file": "page", // a mod's own icon, the word `file` · lucide FileText
  "mod-icon-flag": "triangle-flag", // a mod's own icon, the word `flag` · lucide Flag
  "mod-icon-flask": "flask", // a mod's own icon, the word `flask` · lucide FlaskConical
  "mod-icon-folder": "folder", // a mod's own icon, the word `folder` · lucide Folder
  "mod-icon-gauge": "dashboard-speed", // a mod's own icon, the word `gauge` · lucide Gauge
  "mod-icon-globe": "globe", // a mod's own icon, the word `globe` · lucide Globe
  "mod-icon-inbox": "drawer", // a mod's own icon, the word `inbox` · lucide Inbox
  "mod-icon-info": "info-circle", // a mod's own icon, the word `info` · lucide Info
  "mod-icon-link": "open-new-window", // a mod's own icon, the word `link` · lucide ExternalLink
  "mod-icon-list": "task-list", // a mod's own icon, the word `list` · lucide ListTodo
  "mod-icon-lock": "lock", // a mod's own icon, the word `lock` · lucide Lock
  "mod-icon-message": "message", // a mod's own icon, the word `message` · lucide MessageSquare
  "mod-icon-more": "more-horiz", // a mod's own icon, the word `more` · lucide Ellipsis
  "mod-icon-note": "notes", // a mod's own icon, the word `note` · lucide StickyNote
  "mod-icon-pause": "pause", // a mod's own icon, the word `pause` · lucide Pause
  "mod-icon-play": "play", // a mod's own icon, the word `play` · lucide Play
  "mod-icon-plug": "plug-type-a", // a mod's own icon, the word `plug` · lucide Plug
  "mod-icon-refresh": "refresh", // a mod's own icon, the word `refresh` · lucide RefreshCw
  "mod-icon-search": "search", // a mod's own icon, the word `search` · lucide Search
  "mod-icon-send": "send", // a mod's own icon, the word `send` · lucide Send
  "mod-icon-server": "server", // a mod's own icon, the word `server` · lucide Server
  "mod-icon-settings": "control-slider", // a mod's own icon, the word `settings` · lucide Settings2
  "mod-icon-shield": "shield", // a mod's own icon, the word `shield` · lucide Shield
  "mod-icon-star": "star", // a mod's own icon, the word `star` · lucide Star
  "mod-icon-terminal": "terminal", // a mod's own icon, the word `terminal` · lucide SquareTerminal
  "mod-icon-timer": "timer", // a mod's own icon, the word `timer` · lucide Timer
  "mod-icon-trash": "trash", // a mod's own icon, the word `trash` · lucide Trash2
  "mod-icon-user": "user", // a mod's own icon, the word `user` · lucide User
  "mod-icon-wrench": "wrench", // a mod's own icon, the word `wrench` · lucide Wrench
  "mod-icon-x": "xmark", // a mod's own icon, the word `x` · lucide X
  "mod-icon-zap": "flash", // a mod's own icon, the word `zap` · lucide Zap
  "mod-paused": "pause", // a mod that is paused · lucide Pause
  "mod-step-done": "check", // a mod's step: done · lucide Check
  "mod-step-failed": "xmark", // a mod's step: failed · lucide X
  "mod-step-running": "play", // a mod's step: running · lucide Play
  "mod-step-todo": "minus", // a mod's step: not started · lucide Minus
  "mod-trouble": "warning-triangle", // a mod that failed or cannot be reached · lucide TriangleAlert
  "mod-unknown": "help-circle", // a mod mark whose state is not known · lucide CircleQuestionMark
  "modifier-lock": "lock", // a modifier key is locked · lucide Lock
  "mods": "plug-type-a", // the Mods settings section · lucide Plug
  "more-actions": "more-horiz", // open the actions menu of a block · lucide Ellipsis
  "needs-you": "one-point-circle", // only panes that need me · lucide CircleDot
  "new-agent": "plus", // start a new agent · lucide Plus
  "new-shell": "terminal", // open a new shell · lucide SquareTerminal
  "new-space": "folder-plus", // new space · lucide FolderPlus
  "note": "notes", // note · lucide StickyNote
  "notifications": "bell", // push notifications · lucide Bell
  "notifications-snooze": "bell-off", // snooze notifications · lucide BellOff
  "offline": "wifi-off", // the phone is offline · lucide WifiOff
  "ok": "check", // a calm tick in a notice: it went through · lucide Check
  "open-beside": "view-columns-2", // open beside the current pane · lucide Columns2
  "open-external": "open-new-window", // open in another place · lucide ExternalLink
  "open-here": "data-transfer-both", // open here · lucide Replace
  "option-pointer": "nav-arrow-right", // cursor on the option the agent menu points at · lucide ChevronRight
  "pairing": "key", // pair this phone with the bridge · lucide KeyRound
  "pane-count": "view-grid", // count of panes · lucide LayoutGrid
  "pane-menu": "more-vert", // open the pane menu (header) · lucide EllipsisVertical
  "pane-nav-down": "arrow-down", // pane navigation down · lucide ArrowDown
  "pane-nav-left": "arrow-left", // pane navigation left · lucide ArrowLeft
  "pane-nav-right": "arrow-right", // pane navigation right · lucide ArrowRight
  "pane-nav-up": "arrow-up", // pane navigation up · lucide ArrowUp
  "pane-navigation": "drag", // pane navigation setting · lucide Move
  "pane-settings": "control-slider", // pane settings · lucide SlidersHorizontal
  "pane-switcher": "multi-window", // switch pane (belt Switch mark) · lucide Layers
  "paste": "paste-clipboard", // paste from the clipboard · lucide ClipboardPaste
  "phone": "smartphone-device", // this phone · lucide Smartphone
  "phone-draft": "smartphone-device", // a draft kept on this phone · lucide Smartphone
  "pin": "pin", // pin · lucide Pin
  "pinned-mark": "pin", // mark on a pinned block · lucide Pin
  "pins-list": "pin", // the pinned messages list · lucide Pin
  "plan-blocked": "warning-circle", // plan step blocked · lucide CircleAlert
  "plan-done": "check", // plan step done · lucide Check
  "plan-dropped": "minus-circle", // plan step dropped · lucide CircleMinus
  "plan-in-progress": "one-point-circle", // plan step in progress · lucide CircleDot
  "plan-pending": "circle", // plan step not started · lucide Circle
  "prompt-earlier": "arrows-up-from-line", // jump to an earlier prompt · lucide ArrowUpToLine
  "prompt-user": "user", // the pinned prompt · lucide User
  "queued": "clock", // queued, not yet sent · lucide Clock
  "quick-actions": "flash", // quick actions · lucide Zap
  "recommended": "star", // the option the poster recommends · lucide Star
  "refresh": "refresh", // refresh or reload · lucide RefreshCw
  "release-line": "git-branch", // release line (Stable or Edge) · lucide GitBranch
  "remove": "xmark", // remove one item from a list · lucide X
  "remove-from-view": "eye-closed", // remove a pane from the wide view · lucide EyeOff
  "reopen": "undo-circle", // reopen a closed conversation · lucide RotateCcw
  "report-problem": "bug", // report a problem · lucide Bug
  "restore": "undo-circle", // restore defaults or run again · lucide RotateCcw
  "retry": "refresh", // try again · lucide RefreshCw
  "reuse-last": "clock-rotate-right", // reuse the last launch · lucide History
  "role-deputy": "shield", // this machine is the deputy · lucide Shield
  "role-lead": "crown", // this machine leads the crew · lucide Crown
  "rollback": "undo-circle", // roll back to the previous version · lucide RotateCcw
  "row-go": "nav-arrow-right", // this row opens another screen · lucide ChevronRight
  "run-command": "long-arrow-down-left", // run a command · lucide CornerDownLeft
  "saved-copy": "clock-rotate-right", // the screen shown is a saved copy · lucide History
  "screen": "computer", // the screen view · lucide Monitor
  "scroll-hint-left": "nav-arrow-left", // more content to the left · lucide ChevronLeft
  "scroll-hint-right": "nav-arrow-right", // more content to the right · lucide ChevronRight
  "scroll-to-latest": "arrow-down", // scroll to the newest message · lucide ArrowDown
  "search": "search", // search · lucide Search
  "secret-input": "key", // a typed secret is not echoed · lucide KeyRound
  "section-device": "control-slider", // settings section: device · lucide SlidersHorizontal
  "select-caret": "nav-arrow-down", // caret of a dropdown · lucide ChevronDown
  "select-text": "frame-select", // select text · lucide SquareDashedText
  "selected": "check", // this row or box is chosen · lucide Check
  "send": "send", // send · lucide Send
  "send-now": "long-arrow-down-left", // send the queued line now · lucide CornerDownLeft
  "send-ready": "arrow-up", // the send button once the box holds text · lucide ArrowUp
  "sent-history": "list", // sent lines record · lucide ListEnd
  "sent-ok": "check", // the send or key press went through (brief state) · lucide Check
  "sent-suggestions": "input-field", // sent line suggestions · lucide TextCursorInput
  "session": "multi-window", // the multiplexer session · lucide Layers
  "settings": "settings", // settings · lucide Settings
  "share-menu": "share-ios", // the iOS Share button · lucide Share
  "shell-pane": "terminal", // a pane that is a bare shell · lucide SquareTerminal
  "show-ignored": "eye", // ignored files are shown · lucide Eye
  "show-terminal-view": "terminal", // show the terminal behind a card · lucide SquareTerminal
  "sidebar-hide": "sidebar-collapse", // hide the sidebar · lucide PanelLeftClose
  "sidebar-show": "sidebar-expand", // show the sidebar · lucide PanelLeftOpen
  "sign-in": "log-in", // sign in · lucide LogIn
  "slash-command": "slash", // slash command · lucide Slash
  "sort-by-place": "folder", // sort panes by place · lucide FolderTree
  "sort-order": "sort", // the pane sort order setting · lucide ArrowDownUp
  "space-next": "nav-arrow-down", // next space · lucide ChevronDown
  "space-prev": "nav-arrow-up", // previous space · lucide ChevronUp
  "star-folder": "star", // star a folder · lucide Star
  "steer": "navigator", // steer a running turn · lucide Navigation
  "step-next": "nav-arrow-right", // next step · lucide ChevronRight
  "step-prev": "nav-arrow-left", // previous step · lucide ChevronLeft
  "stop": "square", // stop (a turn, a program, a recording) · lucide Square
  "storage": "hard-drive", // local storage · lucide HardDrive
  "subagent": "sparks", // agents the pane runs · lucide Bot
  "success": "check-circle", // success · lucide CircleCheck
  "tab-dashboard": "table-rows", // Dashboard tab · lucide Rows3
  "tab-fold": "nav-arrow-up", // fold or unfold the tab strip · lucide ChevronUp
  "telemetry": "stats-report", // the install count ping · lucide ChartColumn
  "terminal-draft": "terminal", // terminal draft · lucide Terminal
  "text-larger": null, // make text larger · lucide AArrowUp
  "text-smaller": null, // make text smaller · lucide AArrowDown
  "theme": "palette", // theme picker · lucide Palette
  "theme-dark": "half-moon", // dark theme · lucide Moon
  "theme-light": "sun-light", // light theme · lucide Sun
  "theme-system": "computer", // theme follows the system · lucide MonitorSmartphone
  "time": "clock", // time or recency · lucide Clock
  "todos": "task-list", // the agent's to-do list · lucide ListTodo
  "tool": "wrench", // a tool call · lucide Wrench
  "tool-create-file": "page-plus", // a tool call that creates a file · lucide FilePlusCorner
  "tool-delete": "trash", // a tool call that deletes · lucide Trash2
  "tool-edit": "edit-pencil", // a tool call that edits a file · lucide Pencil
  "tool-execute": "terminal", // a command tool call · lucide SquareTerminal
  "tool-fetch": "globe", // a fetch or web tool call · lucide Globe
  "tool-move": "input-output", // a tool call that moves a file · lucide ArrowRightLeft
  "tool-other": "wrench", // another tool call · lucide Wrench
  "tool-plan": "task-list", // a plan tool call · lucide ListTodo
  "tool-question": "help-circle", // a question tool call · lucide CircleQuestionMark
  "tool-read": "page", // a read tool call · lucide FileText
  "tool-search": "search", // a search tool call · lucide Search
  "tool-task": "sparks", // a task or subagent tool call · lucide Bot
  "tour": "compass", // the guided tour · lucide Compass
  "type-into-terminal": "terminal", // type into the terminal · lucide Terminal
  "typeface": "text-size", // the typeface setting · lucide CaseSensitive
  "undo": "undo", // undo · lucide Undo2
  "unpin": "pin-slash", // unpin · lucide PinOff
  "update-available": "arrow-up-circle", // an update is available · lucide CircleArrowUp
  "update-step-done": "check", // update step done · lucide Check
  "update-step-failed": "xmark", // update step failed · lucide X
  "update-step-skipped": "minus", // update step skipped · lucide Minus
  "update-step-warning": "warning-triangle", // update step needs attention · lucide TriangleAlert
  "user-turn": "user", // a turn or message by the person · lucide User
  "view-chat": "multi-bubble", // switch to the chat view · lucide MessagesSquare
  "view-diff": "git-compare", // show the diff view · lucide GitCompareArrows
  "view-preview": "eye", // show the preview view · lucide Eye
  "view-source": "code", // show file source · lucide Code
  "view-terminal": "terminal", // switch to the terminal view · lucide SquareTerminal
  "voice-broken": "xmark-circle", // voice option is broken · lucide CircleX
  "voice-model": "voice", // the voice model · lucide AudioLines
  "voice-on-host": "server", // voice runs on the host machine · lucide Server
  "voice-on-phone": "smartphone-device", // voice runs on this phone · lucide Smartphone
  "voice-paused": "pause", // voice option is paused · lucide CirclePause
  "voice-ready": "check-circle", // voice option works · lucide CircleCheck
  "voice-setup": "square-dashed", // voice option needs setup · lucide CircleDashed
  "warning": "warning-triangle", // a warning · lucide TriangleAlert
  "wide-layout": "layout-left", // wide layout · lucide PanelLeft
  "zen-enter": "enlarge", // zen mode · lucide Maximize2
  "zen-exit": "reduce", // leave zen mode · lucide Minimize2
  "zoom": "zoom-in", // zoom · lucide ZoomIn
  "zoom-in": "plus", // zoom in · lucide Plus
  "zoom-out": "minus", // zoom out · lucide Minus
} as const satisfies Record<IconKey, string | null>;
