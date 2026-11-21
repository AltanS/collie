# Terminology

The words Collie uses, in plain words. Each entry is short and links to the page that covers it.
Where another tool uses a different word for the same thing, the entry says so.

## Collie (an instance)

One running bridge process. It serves one phone URL and watches one terminal, and it can show
durable agents beside it. A host can run more than one, each with its own port and state folder
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).
In a crew, the instances of one host show as one machine
([A machine can run several Collies](crew.md#a-machine-can-run-several-collies)).

## Session

One run of an agent, with its own history. A pane shows it, and Chat reads it from the harness
([Sessions](sessions.md)). In the app and in these docs, "session" alone means this and nothing else.

Herdr, tmux, zellij and Rex call their own top-level group a session too. Collie shows that group as a
[space](#space), and older versions of the app said "session" for it. A trick's own screen is a
[page](#page), never a session.

## Space

A group of tabs, with a folder. It is the top level on the phone. A Herdr workspace is a space, a
tmux session is a space, a zellij session is a space, a Rex session is a space, and a [durable agent](#durable-agent) is a space.
The switcher in the header says **Spaces** and **All spaces**. A space is not a [session](#session).

## Tab

A group of panes. A Herdr tab is a tab, and a tmux window is a tab
([Terminals](multiplexers.md#what-changes-compared-with-herdr)).

## New tab sheet

The sheet a workspace's **+** opens: that machine's agents and command rows, then **Just a shell** and
**More options** ([A new tab from the plus](configure.md#a-new-tab-from-the-plus)).

## Pane

One thing you can open on the phone. In a terminal it is a pane with a screen. In a durable agent it is
one conversation, and it opens in Chat only. A pane holds an agent or a plain shell. When it holds an
agent, the pane shows that agent's [session](#session).

On a large screen several panes show side by side, in a [row of panes](#row-of-panes)
([Large screens](configure.md#large-screens)).

## Pane menu

The menu under the three dots, the ⋮, in a pane's header. It holds the pane's own actions: Find, History,
Copy output, Pane settings, Zen mode, Rename, Close and more. On a large screen it opens beside the dots.
Open it with the [prefix key](#prefix-key) and then `m`
([Keyboard shortcuts](keyboard-shortcuts.md#the-actions)).

## Row of panes

The panes of one space, side by side, on a large screen. Each space keeps its own row, and the row
scrolls sideways. A pane in it is a [pane](#pane), never a column
([Large screens](configure.md#large-screens)). Taking a pane out of the row is
[Remove from view](#remove-from-view).

## Remove from view

The action that takes a pane out of the [row of panes](#row-of-panes). The agent in it keeps running,
and the pane is still in the sidebar. It is not closing a tab or stopping the agent
([Large screens](configure.md#large-screens)).

## Prefix key

The key you press before an action key on a keyboard, `Ctrl+B` by default, the same as Herdr's. It
says that the next key is for Collie. Press it twice to send it to the pane
([Keyboard shortcuts](keyboard-shortcuts.md#the-prefix)).

## Shortcut list

The list of every keyboard action with its keys, opened with the [prefix key](#prefix-key) and then
`?`. It also names each line of `shortcuts.toml` that Collie dropped, and why
([Keyboard shortcuts](keyboard-shortcuts.md#the-actions)).

## Key cap

The small label that shows a key on a control while the [prefix key](#prefix-key) waits, for example
`g` on the Actions button. It shows the key you set in `shortcuts.toml`, and only on a control you
can see ([Keyboard shortcuts](keyboard-shortcuts.md#the-prefix)).

## Actions

The searchable list of everything Collie can do on this screen, and of the panes to go to. An action
is one thing Collie can do, by a key or by its name. A pane's own actions also sit in its pane menu.
Open it with the Actions button, or with the [prefix key](#prefix-key) and then `g`
([Keyboard shortcuts](keyboard-shortcuts.md#the-actions)).

## Navigate mode

A mode of the keyboard that puts a focus ring on the rows of the sidebar. `j` and `k`, or the arrow
keys, move the ring and change nothing else. `Enter` opens the focused row and leaves the mode. `Esc`
leaves it and changes nothing
([Keyboard shortcuts](keyboard-shortcuts.md#navigate-mode-and-resize-mode)).

## Resize mode

A mode of the keyboard that stays on until `Esc` or `Enter`. The keys `h` and `l` make the focused
pane narrower or wider in the [row of panes](#row-of-panes)
([Keyboard shortcuts](keyboard-shortcuts.md#navigate-mode-and-resize-mode)).

## Terminal (mux)

Herdr, the Herdr core (`herdr-core`), tmux, zellij, tuios, Tern or Rex, the program that holds your
shells and agents. Other tools call it a multiplexer, or a mux. You choose it with `COLLIE_MUX`
([Terminals](multiplexers.md#pointing-collie-at-a-multiplexer)).

The Herdr TUI (`herdr`) and the Herdr core (`herdr-core`) are two products. `hc` is the core's
command line, and herdr-app is the window that draws its terminals. One Collie drives one of them
([herdr-core notes](multiplexers.md#herdr-core-notes)).

## Durable agent

An agent that runs as its own process, with its own storage. It attaches to Collie over the durable
wire. You build one with the Durable SDK, or with any program that serves the wire. It lays out its
own spaces, tabs and panes. It is experimental, and you attach it with `collie durable attach`
([Durable agents](durable-agents.md)). Its [conversations](#conversation) are sessions too.
The API and the code still call the channel `program`.

## Harness

The agent that runs in a pane: Claude Code, Codex, pi, OmO, or a durable agent
([Claude Code on your phone](claude-code-on-your-phone.md)).

## Settings pages

Settings has eleven pages, each with one line on the index that says what it holds: **Look and feel**
(theme, light or dark, language, fonts, text sizes), **Chat and terminal** (what a pane shows),
**Keys and touch** (Enter sends, the Keys pad, shortcuts, gestures, haptics, zen), **Notifications**,
**Voice**, **Dashboard and projects** (pane order, repo search, worktree folder), **Profiles**,
**Tricks and the Hill** (the Tricks switch, your tricks, the Hill), **Devices and machines** (pairing,
paired devices, your machines, the connection), **Privacy and data** (saved chat copies, telemetry)
and **Updates and about**. The search at the top of Settings finds a setting by its name, and says
where a setting is when it lives in a pane's own sheet. The pages used to be Appearance, Harness
configurations, Device, Alerts, Experiments and System; an old link opens the page that holds its
settings now.

## Profile

A profile is signed in on its own, for example Work with your work subscription beside Default with
your personal one. You pick the profile when you start a session, and the session stays in it. Add
one in **Settings → Profiles**; with none added, nothing changes. Profiles belong to one machine: a
crew member's profiles are its own. **Change login** gives a profile another login, and its sessions
follow ([Profiles](configure.md#profiles)). Edge builds of 1.29 called it an account.

## Default profile

The profile every agent has, shown as **Default**. It is the agent's normal folder, started with
nothing set. A plain **Claude Code** entry on the New page keeps using it
([Profiles](configure.md#profiles)).

## Shared profile

A Claude Code profile that Collie makes in a new folder, `~/.claude-<name>`. It links the Default
profile's setup and history into that folder, so your sessions, `/resume`, skills and settings stay
one set, and only the login is its own. An **Own** profile is the other kind: a folder you already
use, taken as it is. The other agents offer Own profiles only ([Profiles](configure.md#profiles)).

## Change login

The button that moves a profile to another login without a new session. It starts the agent's own
sign-in, and the old login stays until the new sign-in works. After **Finish**, Collie asks the agent
who is signed in. Claude Code sessions that run go on with the new login from their next message.
Codex, pi and Grok use it for sessions you start afterwards
([Change the login of a profile](configure.md#change-the-login-of-a-profile)).

## Sign-in code field

The field where you paste the code that a browser sign-in gives you. The agent's sign-in screens show
as cards, and the card's button opens only the agent's own sign-in address. The code and the address
are not stored, logged or sent anywhere else
([Change the login of a profile](configure.md#change-the-login-of-a-profile)).

## Usage window

One limit that an agent reports, with the share used and the time it resets. For Claude and Codex it
is usually the 5-hour window, shown as "5 hours", and the 7-day window, shown as "Week". A plan that
reports one limit shows one ([Usage windows](configure.md#usage-windows)).

## Plugin (Claude Code)

The small Claude Code plugin that `collie harness link claude` installs. It is an experiment and is off
until you link. A linked Claude Code takes plain messages, WalkyTalky messages and permission answers
as data, and every other send keeps the screen road. It is not the Herdr plugin `herdr.collie`, which is
how Collie installs in Herdr
([Send by data](claude-code-on-your-phone.md#send-by-data-optional-experimental)).

## Crew

The lead plus its members. It gives you one phone URL for many machines
([Crews](crew.md#two-machines-one-crew)). One machine needs no crew to show a terminal and a
durable agent together. The word is crew and not pack: pack needs a dog-pack picture before it means
anything and sounds like "package", while a crew has a lead by nature.

## Lead

The Collie your phone talks to. It merges the lists of its members and relays their panes
([Crews](crew.md)).

## Member (peer)

One Collie that joined a crew. The two words mean the same thing. "Member" is the crew's word, and
"peer" is the word for a Collie that runs beside another one
([Crews](crew.md#how-a-crew-is-wired)).

## Deputy

The one member that the lead named ahead of time to take over when the lead goes quiet. You name it with
`collie crew deputy <member>`. It keeps a read-only copy of the lead's launcher rows, and a copy of each
trick that is on, so they work after a takeover ([Crews](crew.md#how-a-crew-is-wired)).

## Standby door

The listener that a deputy binds so that your phone can reach it while the lead is gone. It has four
routes and is never published. The lead's silence arms it, and your own pairing credential spends it. It
exists only when `COLLIE_STANDBY_PORT` is set on the lead and on the deputy
([The standby door](deployment.md#the-standby-door--a-crews-failover-path)).

## Release line

The kind of release a machine takes. **Stable** is the default and takes final releases only, for
example `1.23.0`. **Edge** also takes Edge builds, such as `1.23.0-edge.2`, which are GitHub
pre-releases cut a few days before the final release. You set the line in **Settings → Updates and
about → Release line**, and the switch installs nothing. A crew follows its lead's line
([Release lines](upgrading.md#release-lines)).

## Urgent line

The one sentence on the update card, under an **Urgent** label, that says why a patch must be taken today.
It is rare. An urgent patch keeps the daily update cadence, and its version stays an ordinary patch
([From the phone](upgrading.md#from-the-phone)).

## Question card (ask)

A question that a durable agent raises. The phone shows it as a card, and one tap answers it
once. Collie never answers for you ([Durable agents](durable-agents.md#what-the-phone-shows)).

## Belt

The action row above the composer. Its harness section holds the harness's own buttons
([Configure](configure.md#one-off-commands-and-their-history)).

## Permission hold

How the phone answers a Claude Code permission. A hook holds the request, and the phone shows a card,
"Permission: `<tool>`", with the tool and the input shown. Your tap becomes Claude's answer to that one
permission, and a tap at the desk wins when it comes first. A held request waits up to 290 seconds,
then Claude shows its own dialog. Collie never allows or denies on its own. It is not a held send,
which is a message that waits for the turn to end
([Permissions held for the phone](multiplexers.md#permissions-held-for-the-phone)).

## Stop

The Belt button that presses the agent's own stop key, once. You hold it for two seconds, and it
fills while you hold. Lift early and nothing is pressed. With a keyboard or a screen reader it takes
two presses, **Stop?** first. It types nothing and sends no message
([Stop a turn](configure.md#stop-a-turn)).

## Keys pad

The grid of keys under the composer, opened with **Keys**: Esc, Tab, Ctrl, the arrows and more. You
rearrange it with the pencil next to **Keys**, and Collie keeps it in this browser. If Esc, Enter or an
arrow is missing from your pad, a quiet line says so, with **Put back**
([Your own key pad](configure.md#your-own-key-pad)).

## Send anyway

The button that sends your message although Collie cannot check the screen. It has one name in both
places: on the card for a screen Collie cannot read, and in the notice under the box. The word does not
say whether Enter goes. The answer after your tap says what happened. It is not offered on a sign-in
field, a question or permission Collie read, a screen that changed since you looked, or a menu or
yes/no prompt ([Send anyway](multiplexers.md#send-anyway)).

## Type mode

The composer mode where each key goes to the terminal as you type. It turns itself off after 60
seconds with no key, when the pane's agent changes, or when the app goes to the background. Collie
never writes the characters you type in it to the audit log
([Security](security.md)). While it is on, a keyboard takes only the [prefix key](#prefix-key)
([Keyboard shortcuts](keyboard-shortcuts.md#type-mode)).

## Put back

The button on a text that did not go out. Collie keeps such a text above the box as "Not sent, kept
here". **Put back** writes it into the empty box again and sends nothing. With a draft in the box, it
tells you to empty the box first. It is not the **Put back** of the Keys pad, which returns a missing
key.

## Pins

A copy of one Chat block (your message, a reply or a tool card) that the machine owning the pane keeps
for one [session](#session). To pin a block, tap it, then its **⋯**, or hold it. The [belt](#belt) shows a mark with
their count, and a tap opens them
([Pinned messages](configure.md#chat-view)). They are not the **Pin to top** of a pane, which keeps the
pane at the top of a list.

## Starter

A row on the New page that makes a new pane in a durable agent
([Starters from a durable agent](configure.md#starters-from-a-durable-agent-experimental)).

## Source

The word `sources.json` uses for one durable agent entry. You meet it only in that file name and its
fields. Nothing on the phone says "source"; the phone says [durable agent](#durable-agent)
([Attach a durable agent](durable-agents.md#attach-a-durable-agent)).

## Cap

One thing a durable agent says it can do: `asks`, `starters`, `send`, `steer`, `abort`, `rename`, `close`,
`actions`, `history` or `reopen`. The phone draws a control only for a cap the durable agent named. The
push limits are also called caps, and they are a different thing
([Pushes from a durable agent](voice-and-push.md#pushes-from-a-durable-agent)).

## Hello

The first thing a durable agent tells Collie: the wire versions it speaks, its caps and its name. Collie
reads nothing more from a durable agent whose versions do not meet its own
([Versions](durable-agents.md#versions)). A crew link has a hello of its own, between a lead and
a member ([Crews](crew.md)).

## Epoch

A label a durable agent makes each time it starts. A position in a conversation only counts inside one
epoch. When the epoch changes, Collie reads the conversation again from the start
([Durable agents](durable-agents.md)).

## Receipt

The record of one thing a phone asked a durable agent to do: an answer, a send, a stop or a starter tap.
It holds the request id and the outcome, and it lets a retry replay and not run twice. Collie keeps
receipts in its state folder
([Where Collie keeps a durable agent's data](durable-agents.md#where-collie-keeps-a-durable-agents-data)).

A [WalkyTalky](#walkytalky) message has a receipt too. It says whether the message is queued, typed
into the pane, waiting in the inbox or refused, and why ([Receipts](walky-talky.md#receipts)).

Your answer to a [Decision](#decision) has a receipt as well. The card says whether the answer was
typed into the session, is waiting for its turn, was refused, or was taken by the trick that asked
([Receipts](hill.md#receipts)). A tap on a [trick](#trick)'s button keeps a receipt too, so a tap
that is sent again runs once.

## Conversation

How the phone's Durable agents pages name a durable [session](#session). The conversation list
shows what waits on you first, then the other open ones, then the closed ones
([What the phone shows](durable-agents.md#what-the-phone-shows)).

## Durable agents section

The group on the dashboard that lists every durable agent, one row each. It moves above your spaces while
a question waits, and it shows nothing when no durable agent is attached
([What the phone shows](durable-agents.md#what-the-phone-shows)).

## Wire

The rules Collie and a durable agent use to talk: a hello, then snapshots, events and answers. There is
one version today, version 1. It runs over a private socket or over https with a token
([Versions](durable-agents.md#versions)).

## WalkyTalky

A short message from one agent session to another, or from you to a session. It works on any
harness and across a crew, and every message has an id and a [receipt](#receipt). The command is
`collie walky` ([WalkyTalky](walky-talky.md)). Across a crew a message goes through the lead, and the
lead tells the sender's machine how it ended.

WalkyTalky is the name of the feature, written as one word. The CLI verb is `collie walky`. The skill
and the docs page keep their file names, `walky-talky`.

## Nudge

The one line that an agent's message types into the target pane. It holds the sender's header and
the two commands that read and answer the message, and no body. The agent reads the body with
`collie walky inbox <id>`
([What the target pane receives](walky-talky.md#what-the-target-pane-receives)).

## Inbox

The messages kept for one pane, on the machine that owns the pane. A message waits there until the
pane reads it with `collie walky inbox`. It lands there when Collie could not type it, too
([Reply, read and check](walky-talky.md#reply-read-and-check)).

## Pane instance

One pane as Collie follows it, from the first time Collie sees it until it has been gone for 30
seconds. A terminal gives a closed pane's id to the next pane, so Collie gives each pane a token of
four characters too. A [WalkyTalky](#walkytalky) address carries it after a `#`, for example
`local/w6:p3#k3f9`, and reaches that pane only. A new pane that takes the same pane id is a new
pane instance, with a new token and an empty [inbox](#inbox) ([Addresses](walky-talky.md#addresses)).
It is not a Collie instance: that word means one running bridge ([Collie (an instance)](#collie-an-instance)).

## Pair limit

The most messages that two panes may trade in 10 minutes, in either direction. It is 12 by default.
`COLLIE_WALKY_PAIR_LIMIT` sets it from 1 to 100, and each machine counts for itself. A message over it
is refused as `pair limit`. The other [WalkyTalky](#walkytalky) limits are 30 messages per sender in 10
minutes, a body of at most 4,000 characters, and a reply chain of at most 4 replies
([Limits and switches](walky-talky.md#limits-and-switches)).

## Trick

A folder that adds its own parts to Collie: a small program, rules for an agent, or both. Collie draws
what it shows, in Collie's own look. Tricks are an experiment: they run only while the
[tricks switch](#tricks-switch) is on, a trick is off until you switch it on too, and its program runs
as you ([Tricks](tricks.md)). There are two kinds, a [program trick](#program-trick) and an
[agent view](#agent-view). The old word for a trick was "mod". The mods folder of herdr-app is a
different thing, a panel of that app
([The Collie panel for herdr-app](multiplexers.md#the-collie-panel-for-herdr-app)).

## Tricks switch

The one switch for tricks as a whole on a machine, in Settings → Tricks and the Hill and in
`collie tricks on|off|status`. Tricks are an experiment, so it is off until you switch it on. While it
is on, that page shows the list of tricks under it. While it is off no trick runs or draws, and each
trick keeps its own switch for when you switch it on
([Switch tricks on or off](tricks.md#switch-tricks-on-or-off)).

## Program trick

A trick with a program on your machine. The bridge runs it on a timer or on your tap, reads the one
JSON document it prints, and the phone draws the parts in it. It can also ask you on the Hill
([Example 1: a program trick](tricks.md#example-1-a-program-trick)).

## Agent view

A trick that one agent session's own agent draws: one screen, in a view beside Terminal and Chat. It
has no program, only a [rules file](#rules-file). You switch it on per session, and a tap sends the
agent the words you saw on the screen
([Example 3: Morph, an agent view](tricks.md#example-3-morph-an-agent-view)).

## Rules file

The plain text file, named by `rules` in an agent view's manifest, that tells the agent how to draw.
The agent reads it with the command at the end of the first message a view sends. The details page
shows it whole, and a change to it always asks you again
([How an agent learns the rules](tricks.md#how-an-agent-learns-the-rules)).

## Official tricks

The tricks in Collie's own repository. Each release names the exact version of each one, and Add, in
Settings → Tricks and the Hill or with `collie trick add <name>`, fetches that version and nothing else. They
arrive off, like every trick ([Official and community tricks](tricks.md#official-and-community-tricks)).

## Community tricks

The tricks anyone else writes, each in a repository of its own. The app never fetches a list of them:
you add one by its address, and its row says "ColliePWA did not check this code."
([Official and community tricks](tricks.md#official-and-community-tricks)).

## Place

A spot on the phone where a trick can show (a surface). A program trick draws in seven: `belt`,
`session` (shown as Page), `dashboard`, `status`, `tabbar`, `menu` (rows in a session's settings) and
`float` (a small moving picture over the app, "Moving pictures from tricks" in Settings → Look and feel).
An agent view is the eighth, `agent-view`. The Hill is built in, and a trick posts there without
naming it. A place is not a [space](#space). Each place is
described in [Places](tricks-reference.md#places).

## Page

A trick's own screen: a row on the Dashboard under Tricks, and the screen it opens. A tap on the
trick's tile, bottom bar item or chip opens it too. It has no reply box, because a trick is not an
agent you talk to. A [draft button](#draft-button) on it can fill the reply box of the session you
opened it from. The code word in `places` is `session`, and older versions of the app said
"session" for a page. A page is not an agent [session](#session)
([Where a trick can show](tricks.md#where-a-trick-can-show)).

## Draft button

A button on a trick's [page](#page) that puts a text into the reply box of the agent
[session](#session) you opened the page from, then opens that session. It fills only an empty box, and
it never sends: you read the text and tap Send. Opened from the Dashboard or the bottom bar, the page is
for no session, and the button says "Open a session first". The trick asks for it with
`drafts = "session"` in `trick.toml`, a [power](#power)
([Parts](tricks-reference.md#button)).

## Part

What a trick draws in one place: one mark on the Belt, one chip, one tile, one bottom bar item, rows
in a session's settings, or one Page. The word also names the pieces a screen is built from, such as a row, a chip or a
button, from a closed list of 22 kinds. A part is data, never code, and one bad part does not hide the
others ([The parts](tricks.md#the-parts), [Parts](tricks-reference.md#parts)).

## Power

What a trick may reach beyond its own code: the environment names it asks for (`env`), the places it
draws in (`places`), the files it reads from your agent sessions (`inputs`), and when it runs on its
own (`on`, `watch`), how much of the local API it reads (`access`), and whether its buttons may put text
into your reply box (`drafts`). The details page lists them. A new version that changes a power always waits for your yes. Settings and `collie trick on`
sometimes say "rights" for the same thing ([What a trick may and may not do](tricks.md#powers-the-environment-and-the-warnings)).

## Access (of a trick)

How much of Collie's [local API](#local-api) a trick reads: `none` (the default), `see` or `read`. `see`
holds your machines, your sessions and their states, your usage and the Hill, and never the text of a
screen. `read` adds what is on a session's screen. The trick says it with `access` in `trick.toml`, and it
is a [power](#power): a version that raises it waits for your yes. The level is what the trick declares,
and the bridge checks it for each read through the [run token](#run-token)
([Reading Collie through the local API](tricks-reference.md#reading-collie-through-the-local-api)).

## Run token

A random token Collie makes for one run of a trick that declares [access](#access-of-a-trick). It is in
the run's facts and nowhere else, and it dies when the run ends. The [local API](#local-api) answers only
a connection that names a live one. The token keeps a program that only finds the socket out of this
socket, and nothing more. A program that runs as you can still read a pane through the multiplexer, read
another program's memory, and read Collie's local secret file and use it on the bridge's loopback address,
which still answers the routes that return a session's text. Collie does not stop that
([The local API](commands.md#the-local-api-experimental)).

## Details page

The page that opens when you tap a trick's name in Settings → Tricks and the Hill, or the info button in the header of
the trick's own page. It used to be a sheet, the About sheet. It shows the trick's description
and its own text, then the facts Collie knows: where it draws, what it reads, which environment names it
asks for, what a text search of its code found, and where it came from
([The details page](tricks.md#the-details-page)).

## Trick setting

A value a trick asks you for, such as a repository or a branch. The trick lists its settings in
`trick.toml` as `[[field]]`; you set them on the phone, on the trick's details page. A
setting is your data: the trick gets it, Collie runs nothing with it
([Settings a trick asks you for](tricks-authoring.md#settings-a-trick-asks-you-for)).

## Decision

One question that an agent or a trick puts on the Hill, with the options you pick from. You answer it by
tapping an option, and the answer goes back to the session that asked, as your own message. A Decision
is not a [question card](#question-card-ask): that card is a durable agent's own question
([Decisions](hill.md#what-a-decision-is)).

## Proposal card

The card of a trick that an agent wrote for you. It is titled "Switch on the trick `<id>`?", and it
shows what the trick asks for, the warnings of the text search, and every file of its code. Nothing
runs before your yes. The yes is a hold of 1.5 seconds, or two presses of a key. Reading the code is
up to you ([A trick an agent proposes](hill.md#a-trick-an-agent-proposes)).

## Version card

The card of a new version of a trick that a proposal made. It asks "Use the new version of `<id>`?",
and the code is replaced only on your yes ([A trick an agent proposes](hill.md#a-trick-an-agent-proposes)).

## Hill

The page of Decisions that wait for you, grouped Now, Today and Later, with the answered ones below.
It is the fourth item of the Dashboard's bottom bar, and on a large screen a button beside Actions in
the dashboard's header. One crew has one Hill, on the lead. "Hill" is the
view's name and stays the same in every language ([The Hill](hill.md)).

## Event

A short note the bridge makes when an agent session changes state, ends a turn or opens a question:
`session.status`, `turn.end` or `ask.open`. It holds ids and states, never text. A trick that lists
`on` runs on events, and the [local API](#local-api) answers them. An event can come twice, so a
program must be safe against a repeat ([When a trick reacts](tricks-reference.md#when-a-trick-reacts)).

## Watch

The files a trick asks to run on: when one of them changes, the trick runs again. Like `on`, it is a
[power](#power) the card names, and a new one waits for your yes
([When a trick reacts](tricks-reference.md#when-a-trick-reacts)).

## Local API

A read-only Unix socket on the machine that a trick's run reads with `t.api`: list the sessions, read a
screen with secrets masked, follow the [events](#event). It is on while tricks are switched on, and it
answers only a connection that names a live [run token](#run-token). `collie api` lists its operations.
It is experimental, and it is closed to other users, other machines and browser pages
([The local API](commands.md#the-local-api-experimental)).

## Project file

A `collie.toml` file inside a repository. It changes what Collie shows for the sessions that work in
that repository, and nothing else: it never adds a command, a key or a hook. The nearest one to a
session's folder wins ([A project's own picture](configure.md#a-projects-own-picture)).

## Project picture

The picture a [project file](#project-file) names with `[project] icon`. It takes the agent logo's
place wherever Collie draws the logo of that project's sessions, with the agent logo small in its
corner. The Collie mark is never replaced. **Project pictures** in Settings, Look and feel,
turns it off on one device ([A project's own picture](configure.md#a-projects-own-picture)).
