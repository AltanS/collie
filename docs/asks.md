# Asks

Asks is the list of open questions from all your sessions, on your phone. An ask is a question that an
agent leaves for you. It stays open until you answer it or the agent takes it back. It sends no
notification.

```sh
collie walky ask "Ship to Stable now?" \
  --option ship="Ship it" --option hold="Hold until CI" \
  --fact "CI is green. Stable reaches every user." \
  --recommend hold --why "The e2e leg has not run yet."
```

`collie walky ask` prints the ask's id, such as `ak_k3f9x2m8q1a0`, and does not wait. The agent goes on
with the work that does not need the answer. You open Asks when you have time, tap an answer for each
question, and tap Send. Your answers come back to the agent's session as one message, and that message
starts its next turn.

Asks is an experiment. It is off until you switch it on, so no agent or trick can ask before that. See
[Turn Asks on or off](#turn-asks-on-or-off). A Collie that updates from a release with the same list under
its old name starts with Asks off and empty ([After an update](#after-an-update)).

## Turn Asks on or off

In the app, open Settings → Tricks. Asks is the first row of the trick list. It is labelled "Built in",
and it has its own switch, which does not depend on the Tricks switch above the list. Tap the switch to
turn Asks on or off. If a question waits, the row says how many, and the first tap on the switch asks
you to tap again before it turns off.

A tap on the row's name opens the Asks page of Settings, with the switch at the top. The page says what
Asks is, who can ask, what to do when nothing arrives, and where Asks comes from, and it links to this
page.

On the machine, run:

```sh
collie asks on
collie asks off
```

The commands move the same switch, for every phone of this Collie, and the bridge reads it with no
restart. `collie asks on` refuses in a pane where an agent works: switching Asks on is your choice.

With Asks off:

- Agents and tricks cannot ask. The refusal says how to turn Asks on.
- The phone takes no answer to an open ask, so no message is typed and no trick runs.
- Asks leaves the bottom bar. Its page says that Asks is off and offers a button to turn it on.
- The open asks stay stored. They show again when you turn Asks on.
- An agent can still run `collie walky asks`, `collie walky status` and `collie walky cancel`, so it can
  clean up.
- The Mode bell is not shown, and "Tell all sessions now" is refused.

The installed WalkyTalky skill names asks only while Asks is on. Each change of the switch writes the
skill again, as `collie skill sync` does. A session that started before you turned Asks on may not know
it. Tell it, or start a new session.

A crew member with no switch file of its own follows the lead. It does not refuse an ask on its own: it
sends the ask to the lead, and the lead's switch decides. On a crew member, the installed skill follows
that machine's own switch, not the lead's. To give the agents on a member the Asks text, run
`collie asks on` on that member. See [Asks from any machine](crew.md#asks-from-any-machine).

Collie's own cards about a trick are not asks of an agent, so they need no switch. A proposed trick, a
new version, a trick's changed rights and a carried trick still get their card with Asks off. They wait
under **Waiting for your yes** in Settings → Tricks. While Asks is off, the Dashboard also shows a line
about the card, such as "An agent proposes a trick: `<name>`.", with the button **Review**, which opens
the oldest card.

## What an ask is

An ask is one question with its answers. The agent writes all of it, and only two parts are needed.

| Part | Needed | What the phone shows |
| --- | --- | --- |
| The question | yes | The question, in the content font. At most 90 characters, and it ends with `?` |
| Options | yes, 2 to 5, or `--words` | One answer card for each. A label should start with a verb, at most 60 characters. A bare Yes, No, OK or Cancel is refused |
| `--fact` | no | The situation, under the question. At most 240 characters |
| `--does <id>=<text>` | no | "Then": what happens when you pick that answer. At most 300 characters |
| `--cost <id>=<text>` | no | "Cost": what that answer costs or risks. At most 300 characters |
| `--recommend <id> --why <text>` | no, both or none | The star line "`<session>` suggests: `<option>`", a Recommended badge and "Why" on that answer only. `why` is at most 200 characters |
| A background | no | The Context page: Markdown text from `--body <file.md>` or after `--`, at most 20,000 characters |
| `--file <path>[#heading\|:line]` | no | Up to 10 files of the agent's workspace, in the Context page |
| `--image <path>=<caption>` | no | Up to 4 pictures, in the Context page |

The phone shows a line only when the agent sent it. An agent that sends only the question and its
options costs no more tokens than that.

One ask holds one question. A second question is a second ask. A session has at most five open asks.

Every ask with options also takes "Your own answer", in your words. A `--words` ask has no options: you
answer in words.

An ask is in one of these states. A closed one keeps its state and shows it.

| State | The phone says |
| --- | --- |
| open | |
| answered | "Answered", and the answer |
| answered in the session | "You answered it in the session." |
| taken back | "The agent took this ask back.", and its reason when it gave one |
| replaced | "The agent sent a newer ask in its place." |
| cleared | "The conversation was cleared. This ask is closed." |
| gone | "The session that asked has ended." |

An answered ask, and one you answered in the session, stay under **Answered** until you clear them. An
ask that closed without you, because it was taken back, replaced, cleared or gone, leaves by itself after
about a minute. The agent can still read its state with `collie walky status`.

Three kinds of sender ask. **An agent** asks with `collie walky ask`, and the bridge names the agent from
its pane. **A trick** asks with its `asks` list ([An ask from a trick](#an-ask-from-a-trick)). **Collie
itself** sends its own cards: "Use the new version of `<name>`?" asks about a trick's new code
([A new version of a trick](tricks.md#a-new-version-of-a-trick)), and "Switch on the trick `<id>`?" asks
about a trick an agent proposed ([A trick an agent proposes](#a-trick-an-agent-proposes)).

## What an agent does

An agent runs these verbs in its own pane. They talk to the running bridge over a private socket, and
Collie asks for no token.

```sh
collie walky ask "<question>" --option <id>="<label>" ...
collie walky asks
collie walky status ak_k3f9x2m8q1a0
collie walky cancel ak_k3f9x2m8q1a0 --answered
```

- `ask` sends one ask and prints its id and its card. It never waits for the answer.
- `asks` lists the open asks that this session sent, oldest first.
- `status <id>` prints the state of one ask, and the answer when there is one.
- `cancel <id>...` takes back 1 to 5 asks at once. It takes `--answered` when you answered in the
  session or the work settled the ask, or `--because "<reason>"`. Use `--replaces <id>` on a new ask
  when the question changed.

`collie walky asks` is the agent's own list. `collie asks` holds your commands, such as `on` and
`clear`. An agent does not run those.

`collie walky ask --help` prints the flags and the rules in at most 1,500 bytes, so an agent reads them
when it runs it. Add `--dry-run` to print the card the person would see and send nothing.

The agent writes for a reader who knows nothing of its session. The rules it gets:

1. One ask holds one decision. A second question in the body is a second ask.
2. Write for a stranger to your session. Explain each name they would not know.
3. The body adds what you found and what can go wrong. Do not repeat the options in it.
4. Send the ask when you meet the decision, not as a group at the end of the turn.
5. Put no open question in a file or in your reply. Point to the ask id.
6. Do not wait for the answer. Go on with the work that does not need it.
7. A dialog that blocks a command is not an ask. A permission prompt is such a dialog.

The help calls the background the body: `--body <file.md>`, or text after `--`. After the rules it says
how an ask stays open and how to close it.

The skill an agent has installed holds a short Asks section while Asks is on: one example, a few of these
rules in prose, how to close an ask, and a pointer to `collie walky ask --help`
([Install the skill](walky-talky.md#install-the-skill)).

A refusal prints one line on stderr and gives an exit code.

| Exit | Meaning |
| --- | --- |
| 0 | Done |
| 1 | It failed in a way no other code names |
| 2 | A usage error: a flag is wrong or missing, or an old `collie hill` verb. The line names the new verb |
| 3 | A state of the machine. Asks is off, no bridge on this machine knows this pane, or the machine has no socket (Windows). With several ids, `cancel` also exits 3 when one id failed. A retry can pass once that changes |
| 4 | The bridge refused the ask for a reason it names, such as too many open asks |
| 5 | No running Collie answered, or the bridge took the ask and did not answer in time, or a crew member's lead did not answer. The ask may or may not have arrived. Send it again with the same `--request-id <uuid>`, and Asks keeps one ask |

A session holds at most five open asks. `--request-id <uuid>` makes a retry safe: the same id sends once,
and the same id with other content is refused.

## What you see on the phone

Asks is the fourth item of the Dashboard's bottom bar, with the count of asks that wait on you. On a
large screen the bar is gone, and Asks is a button in the Dashboard's header, beside Actions. The
Mode control is the bell in the page's header ([Here, Quiet and Away](#here-quiet-and-away)).

**The list** has three parts, top to bottom. The header says "5 open in 3 sessions", and its right end holds
the Mode bell ([Here, Quiet and Away](#here-quiet-and-away)).

**Next up** is one card with the question to answer first: the session's name and state, the question, the
agent's suggestion when it sent one, and **Answer**, the one filled button of the page. It opens the first
open ask that has no answer marked here. When every ask has an answer marked, the card says "2 of 2
answered" and its button is **Send 2**, for the first session with marks. With several sessions open, a line
beside the button says that a warm session's cache runs out first, or that a working session takes the answer
when its turn ends. On a large screen the keys `prefix+a` do what the button does, from any screen: the
button wears the key while the prefix waits. The action is `answer_next_ask`, and you can change its key in
`shortcuts.toml` ([Keyboard shortcuts](keyboard-shortcuts.md)).

**The sessions** follow under "All open asks, by cache time left", with "5 open · 1 answered" at the right.
There is one card for each session that has an open ask. A card says the session's status mark, name,
where it works and its state, and the time its prompt cache has left ("12 min left", or "cold"). Under it,
one row for each question, with a plain number that counts within the card, and, at the right end, "Next"
on the question that Next up shows, your answer as "Answered: Stop it", or a chevron. A card whose session
has answers marked ends with a foot: "1 of 2 answered", and **Send 1**, which opens the Send sheet for that
session. The sessions stand in the order of their cache: warm sessions with the fewest minutes left
first, then working ones, then the rest. A cold session's card has no fill. The asks that the agent has
not checked sink to the end of their card and turn muted. With nothing open, the page says
"No asks wait on you."

**An ask** opens on its own screen, from top to bottom:

- the header: back up one level, the session's name, "asked 14 h ago" and the cache words, and "ask 1 of 13",
- the question, and the situation under it when the agent sent one,
- one **Context** row, such as "165 words · 2 images · 1 file", when there is a background, a picture or a
  file behind it,
- the star line "`<session>` suggests: `<option>`", when the agent recommends one,
- the hint "Tap to answer. Answers wait here until you tap Send.",
- the answer cards, and
- "Your own answer", last.

An answer card carries its number on the top-left edge, and the Recommended badge on the top-right edge.
Under the title it shows "Then", "Cost" and "Why", each on its own line, only when the agent sent it.
Collie never marks the recommended answer for you. A recommendation that you do not read must not become
the answer by default.

**Mark an answer.** Tap a card, or press the key `1` to `9`. A sheet opens with your answer, a fold
**Add a note**, **Confirm** and **Cancel**. Enter confirms and Escape cancels. A confirmed card stays
marked on the ask's screen, and you can tap **Change answer**. Nothing goes to the agent yet, and the
screen does not move on by itself: tap **Previous** or **Next** to move between asks.

**Ask back.** When the question is not clear to you, tap **Ask back** in the bottom bar and write what
is missing. The agent gets "I need more context" with your words, and sends the ask again with a better
background and `--replaces`.

**Send.** The line above the bottom bar says "No answers yet", or "2 of 4 answered", with **Send 2**.
A Send belongs to one session, so one Send answers every marked ask of that session in one message.
A partial Send is allowed: an ask with no answer stays open, and the message says so. Send opens a sheet
with the message the agent gets, its length against the limit of 4,000 characters, and one line about the
cache. Under Quiet or Away the message ends with the line "Crew state: quiet." or "Crew state: away."
([Here, Quiet and Away](#here-quiet-and-away)). A warm session takes it as one cheap turn. A working
session gets it when its turn ends. A cold session starts a turn at full price. Tap **Hold** to wait.

The message is one line for each ask, with the id first:

```text
ak_k3f9x2m8q1a0 "Ship to Stable now?": hold (Hold until CI), as recommended.
ak_p4d8n2c7v1bz "Rename the flag?": Your own answer: Keep the old name for now.
ak_w9m3t6y1h5qe "Drop the old API?": no answer yet, it stays open.
```

**The context page** opens from the Context row. It holds the question, the agent's background in
Markdown, the pictures, and the files with **Open**, which opens the file in the Files view. Back goes up
one level, to the answers.

**Keys.** Left and right arrows, `j` and `k` move between asks. `1` to `9` mark an answer. Enter confirms
and Escape closes a sheet or goes up one level. Every key has a button. On every screen `prefix+a` opens
the next ask that waits for your answer.

**Answered in the session.** Say you answer in the terminal and not on the phone. The agent closes the
ask with `collie walky cancel <id> --answered`, and the phone shows "You answered it in the session."
Such an ask is never closed without a trace.

A closed ask stays under **Answered**, newest first, up to 20, until you clear it ([Clear](#clear)).

## How an agent is reminded

An agent does not confirm an ask. Silence means the ask is still open. A reminder rides on your next
prompt instead.

On Claude Code, the agent gets its open asks next to each prompt you send in that session, as a note it
reads before it starts. The note comes from Collie's hooks. The first time an ask is listed, the note
holds the question and how to close it. After that, each prompt gets one short line with the ids of the
open asks. If your prompt or its work settles an ask, the agent closes it with
`collie walky cancel <id> --answered`. An ask that is still true stays open, and the agent does nothing.

- After a compaction, a resume or a fork, the agent gets the full list again.
- A `/clear` closes the session's open asks with the reason "conversation cleared", and the phone shows
  that. The next reminder then starts from nothing.
- The note is left out when the prompt is Collie's own "Answers to your asks" message, because that
  message already lists the open asks.
- The note never holds an answer of yours. It holds the agent's own questions and fixed sentences.

Each ask shows how far the agent has seen it, in these words:

| The phone says | What it means |
| --- | --- |
| "Asked 14:02" | The ask is new, and no prompt came after it |
| "Still open. The agent saw it 15:10" | A prompt came after it, and the agent read it in a turn that finished |
| "You wrote in this session since. Not checked." | A prompt came after it, and Collie did not see the agent read it. The row sinks to the end of its card and turns muted |

The reminder needs the hooks of `collie hooks install claude` and Asks switched on. Other agents, such as
Codex, get no reminder, and their asks never read "Still open. The agent saw it". A crew member's sessions
get no reminder either: their asks live on the lead, which never sees the member's turns, so they read
"Not checked". With no hooks, every ask reads "Asked" or "Not checked". `collie hooks status` and
`collie doctor` say whether the entries are in place.

What it costs: one short process start per prompt and no model call. The note adds text to the prompt
only when the session has open asks: a few lines once per ask, then one short line.

## Other cards

Cards that are not asks of an agent stand in a last group under **Other cards**: an ask from a trick,
and Collie's own cards. No card has a priority, so the cards stand in one list, the oldest first. The
heading "Other cards" shows when asks of agents are open too. No card sends a notification.

A card holds, from top to bottom: who asked, with the machine and the card's age; the title and the
summary; the pictures, as one sideways row; facts from the sender in a quiet frame; the recommendation,
with its reason; "More", which opens the longer text and the links, and "Add a note"; the options, numbered
1, 2, 3; and the line that says where your answer goes, with Dismiss beside it. The recommended option
carries a star, and Collie never preselects it.

A card of Collie's own that shows code is a group of cards. It opens at "Card 1 of 4", with Back and
Next, and its options show on the last card. The yes is a hold of 1.5 seconds
([A trick an agent proposes](#a-trick-an-agent-proposes)).

You answer such a card with one tap on an option. An option with a confirm word arms on the first tap,
shows the word, and sends on the second. A note goes with the option you tap. A card that asks for words
shows the field open. A card with no options is answered in words, with "Send answer". Dismiss closes the
card and asks for a second tap. It sends no option.

Your answer is typed into the session as your own WalkyTalky message. The bridge writes the receipt,
closes the card, and then sends. The message holds the card's id, the option, and your words.

```text
Answer to ak_k3f9x2m8q1a0 "Rerun the failed check?"
Option: rerun (Rerun it)
Go ahead, then tell me.
```

That message goes to the session that asked. When the answer goes to another session, because a trick
named a `replyTo`, the message does not quote the title or the label. It holds only the id, the option's
word, your words and the line "Read the ask with: collie walky status `<id>`". Another session must
not carry the sender's own words with your authority.

## Receipts

After a tap on one of these cards, the card says "Sending…", then one line that says what came of it.

| The card says | What happened |
| --- | --- |
| "Sent to `<session>`" | The answer was typed into the session |
| "Sent. `<session>` gets it when its turn ends" | The session was busy, and the message waits for its turn |
| "Sent, not confirmed" | The send did not confirm. The session can read the answer with `collie walky status` |
| "Dismissed" | The card is closed, and nothing was sent |
| "Recorded by `<trick>`" | A trick took your answer |
| "Now running the new version." | You said yes to a trick's new version or to a proposed trick |
| "Kept the old version." | You kept the version that runs |
| "Sent, but `<trick>` did not take it" | The message went, and the trick's program failed on the answer. Collie does not retry it |
| "Not accepted" or "Not accepted: `<reason>`" | The bridge refused it. For example "an answer in words is required" |
| "This ask was already answered" | Someone answered first |
| "The session that asked has ended" | There is no session to send to. The card closes as undeliverable |
| "This ask is closed" | It expired or was taken back |
| "This device may not answer" | The device is read-only |
| "`<machine>` is not answering. Your answer was not sent." | A crew machine is down. The card stays open, and you can answer again |
| "Not sent." with "Try again" | The answer did not reach the bridge |

When the line Collie typed was not confirmed, the answered card under Answered also says "Your answer may
not have arrived. Check the session." Collie does not send it again.

When a card closes before your answer lands, it keeps your words under "Your answer, not delivered" and
offers "Copy your answer", so you do not lose them. The same holds for a note you were still writing when
its card closed.

The same record is in `collie walky status` as `delivery`: `typed`, `held`, `unknown` or `none`. An ask is
never closed because a crew machine went away. Dismiss still closes a card, and the phone then says the
session was not told ([Asks from any machine](crew.md#asks-from-any-machine)).

An ask or a card closes on a fact Collie read, never on a guess. The bridge looks at the open ones every
15 seconds.

| What it read | The card closes as |
| --- | --- |
| The card's expiry passed | expired |
| The session the answer goes to is gone, at two looks in a row | could not be delivered |
| The machine the answer goes to was removed from the crew | could not be delivered |

A session counts as gone only when the multiplexer answered the look and did not list it. A look that
failed, a bridge that just started, and a crew machine that does not answer close nothing. An ask or a
card of a trick that closed without you, because it expired, was taken back or replaced, or could not be
delivered, stays for about a minute with its state, and then leaves by itself. Collie's own cards stay
until you clear them.

Writing in the session does not close an ask. An ask stays open until you answer it, the agent takes it
back or replaces it, or the session is gone.

## Clear

Clear removes the asks and cards that are closed.

- On the phone, the Answered group has a **Clear** button. It asks "Clear 3 entries?", and a second tap
  confirms.
- In a terminal, run `collie asks clear`. It prints how many closed asks it cleared, or says that there
  was nothing to clear.

A second Clear, "Clear cards you answered in the session", handles the open cards marked "You wrote to
this session after it asked." It takes them back and clears them, and types nothing. In a terminal it is
`collie asks clear --spoken`, which refuses in a pane where an agent works. An ask never takes that mark,
because writing in the session leaves an ask as it is. The mark and this Clear apply only to a plain card
that an agent sent with an older Collie on the same machine.

`collie asks clear` without `--spoken` never touches an open ask, and it works with Asks off. Collie keeps
a small marker of each cleared ask, so a repeated ask with the same request id is refused and not sent
twice, and a late answer still reads as gone.

The agent that asked still reads the state of a cleared ask: `collie walky status <id>` prints, for
example, "ak_k3f9x2m8q1a0 is withdrawn; it has left Asks".

## Here, Quiet and Away

The crew state tells your agents how much you want to hear now. Only you set it. It has one effect: a
line of words that your agents read.

```sh
collie asks state
collie asks state quiet
```

`collie asks state` prints the state and since when it holds. The Mode control is a bell in the header of
Asks. In Here it is the bell alone. In Quiet or Away it is a crossed bell with the word, so a state that
quiets your agents is never hidden. Tap it to open the menu "How agents ask you". It has three rows, and
under each one the menu says in words what the agents do:

| State | The phone says |
| --- | --- |
| Here | "Agents ask as usual." |
| Quiet | "Agents ask, but do not wait for your answer." |
| Away | "Agents keep back questions that need an answer now." |

Here is the default. Under Quiet and Away, Collie adds the line "Crew state: quiet." or "Crew state: away."
to the end of the result of each `collie walky ask`, and to the end of each answer you send. Collie does
nothing more with the state: the bridge refuses no ask, holds none back, and sends no notification. The
agent reads the line and decides. The result of `collie walky ask` has no such line under Here.

Under Quiet and Away the menu also says who set the state and when ("Set by `<device>` at `<time>`.", or
"Set from a terminal at `<time>`."). The state stays until you choose Here in the menu, or run
`collie asks state here`.

`collie asks state` with a word refuses in a pane where an agent works. On a crew member it is refused
too: the state lives on the lead.

**Tell all sessions now.** Under Quiet or Away, the menu shows this button. One tap types the line
"Crew state: away." (or "quiet") into each agent session that waits on Asks, as a message from you. Those
are the sessions of the lead's own machine with an open ask, or one asked in the last hour, at most 20 of
them, newest first. A busy session gets the line when its turn ends. The button then says "Told 3
sessions", or "No session was waiting", and stays off until the state changes again. It uses a budget of
its own, so it never uses up the messages that carry your answers.

## An ask from a trick

A program trick can put an ask in the same list. It lists it in the `asks` key of its output, with the
helper's `t.ask`. The list is declarative: after each run that succeeded, Collie makes Asks agree with
it. A trick's ask shows under **Other cards**, and the answer comes back to the trick as a `tap`, and
to a session when the trick names one with `replyTo`.

A trick that sends your answer to a session says so in its manifest with `asks = "reply"`, and its details
page names that power. Every key, with its limit, is in [Asks](tricks-reference.md#asks) of the Tricks
reference, and [A program trick](tricks-authoring.md#a-program-trick) shows one in use.

## A trick an agent proposes

An agent can hand you a trick it wrote. It arrives as a card of Collie's own, and nothing of it runs
before your yes.

```sh
collie trick propose ~/work/disk-space
```

The card's first line reads "Collie tricks" with the tricks glyph. Its title is "Switch on the trick
`<id>`?". Its summary is Collie's own facts: who proposed it, how many files it has, and what it asks for.
Below come the powers it asks for, the warnings of the text search, the author's words under "Its
author's words. Collie did not check them.", and then every file of its code, as a group of cards.

- **Hold to switch on**: keep a finger on it for 1.5 seconds. A fill grows across the button, and the yes
  goes out when it is full. Lift early, slide off the button, or leave the page, and nothing is sent.
  While you hold, the chat stays still under your finger. With a keyboard or a switch device, press it
  twice. Collie reads the stored files again and installs them only when their hash matches the card. The
  trick is then on, approved as exactly that code.
- **Not now** drops the stored copy. So do Dismiss, an expiry, and a newer proposal from the same session.

Your answer is typed into the session that proposed the trick, and it starts a turn there. After the
option, the card shrinks to one line that stays in the conversation and scrolls away with it: the tricks
glyph, "Collie tricks", the trick's name and what happened, for example "hadoken: switched on" or
"hadoken: not switched on". For a new version it reads "new version in use" or "kept the old version".
A Dismiss types nothing. A vertical swipe that starts on the card, the Hold button included, scrolls the
conversation; only a finger that stays on the button holds.

The first card names the files Collie ships, byte for byte: the helper `trick.ts` and the `AGENTS.md`
that `collie trick init` writes. No card shows them. Notes the agent changed show only the change. A
proposal never carries `config.toml`. When the trick drew nothing without it, the first card says the
trick may show nothing until you add its settings file on the machine.

Collie never recommends either option. A proposal is code from an agent, and your own judgement is the
whole check. "Read the code" opens every file on the card. Reading it is up to you: the yes does not wait
for it. A card that cannot show every byte of the code offers no yes.

A trick that a proposal made can get a new version the same way. Its card asks "Use the new version of
`<id>`?" and replaces the code only on your yes, a hold of 1.5 seconds on "Hold to use".

An agent cannot propose a trick that has rules or an agent view: "A trick that gives agents instructions
cannot be proposed by an agent. Ask your person to add it on the machine." The limits on files and on how
many proposals wait are in
[A proposal from an agent](tricks-reference.md#a-proposal-from-an-agent) of the Tricks reference.

## Asks in a crew

A crew has one Asks list, on the lead. An agent on any machine can ask with `collie walky ask`. The phone
shows every ask, with the machine it came from. Your answer goes back through the lead
([Asks from any machine](crew.md#asks-from-any-machine)). The lead keeps a copy of its open asks on its
deputy ([Open asks come along](crew.md#open-asks-come-along)).

The lead must be a Collie that takes asks from other machines. An ask from a member also takes no
`--file`, and its session gets no reminder. [Asks from any machine](crew.md#asks-from-any-machine) has
the refusals in words.

## What is not there

This build does not do these things:

- Question cards of durable agents do not show in the list. They stay on their own pages
  ([Durable agents](durable-agents.md#what-the-phone-shows)).
- One answer does not settle the same question asked by two sessions. Each ask is answered on its own.
- An ask of a crew member's session takes no `--file`.
- An answer does not reach a session in the middle of its turn. A working session gets your answers when
  its turn ends.
- An ask has no priority and sends no notification. An ask of an agent never expires: it stays open until
  you answer it or the agent takes it back. A trick's ask and Collie's own cards can expire.
- Asks has no test button. It has no card that Collie sends to show you how it works.

## After an update

Asks keeps nothing from the list that earlier releases showed under another name. Nothing carries over
at the update:

- Asks is off. Switch it on again ([Turn Asks on or off](#turn-asks-on-or-off)).
- Here, Quiet and Away is at Here.
- The old open cards and the old closed list are gone, and so are their pictures and the answer
  receipts. A late retry of an old answer reads "gone".
- A trick posts its asks again on its next run, as new asks.
- The old folder stays in the state folder, untouched and never read.
- A trick that still writes the old names is refused or loses its asks until its author moves it
  ([Names that changed](tricks-authoring.md#names-that-changed)).

## Where to go next

- [Tricks](tricks.md), for the tricks that ask you here.
- [Write a trick](tricks-authoring.md#a-program-trick), to ask from a trick.
- [WalkyTalky](walky-talky.md), for the messages that carry your answers.
