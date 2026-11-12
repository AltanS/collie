# The Hill

The Hill is the place in ColliePWA where an agent or a trick asks you a question. One question is
one Decision. You tap an answer, and the answer goes back to the session that asked.

```sh
collie hill post --title "Ship 1.28.1 to Stable now?" \
  --summary "CI is green. Stable ships 1.28.1 and reaches every user." \
  --option ship="Ship it" --option hold="Hold until CI" \
  --recommend hold --why "The e2e leg has not run yet."
```

`collie hill post` prints the Decision's id, such as `dc_k3f9x2m8q1a0`, and does not wait. The card
appears on the Hill. Your answer comes back to the agent's session as a message, and starts its next
turn.

"Hill" is the view's name, and it stays the same in every language. "Decision" is a plain word.

## What the Hill shows

The Hill is the fourth item of the Dashboard's bottom bar. It opens a page of cards, grouped by how
soon each one needs you.

| Group | Meaning |
| --- | --- |
| Now | Needs you now. A Decision marked `now` also sends a notification |
| Today | The default |
| Later | Can wait |
| Answered | The Decisions that are closed, newest first, up to 20 |

Above the cards, the Crew state control says how much you want to hear now
([Here, Quiet and Away](#here-quiet-and-away)). The header says how many Decisions are open and how
many are Now. With nothing open the page says
"The hill is clear." and "Nothing waits on you."

A card holds, from top to bottom:

- who asked, with their mark, the machine and how old the card is,
- the title and the summary,
- the pictures, as one sideways row,
- the poster's own facts, in a quiet frame captioned "From <sender>",
- the recommendation, with the reason, between two rules,
- "More", which opens the longer text and the links, and "Add a note",
- the options, numbered 1, 2, 3, and
- the line that says where your answer goes, with Dismiss beside it.

A card of Collie's own that shows code is a group of cards. It opens at "Card 1 of 4", with Back
and Next, and its options show on the last card. The yes stays off until every card was on screen
([A trick an agent proposes](#a-trick-an-agent-proposes)).

When you wrote to a session after its agent asked, the card says "You wrote to this session after it
asked." ([Clear](#clear) takes such cards away.)

The recommended option carries a star. Collie never preselects it, and never focuses it. A
recommendation that you do not read must not become the answer by default.

## What a Decision is

A Decision is one question with its choices. The sender writes all of it: a title, a summary, a
longer body behind "More", up to five options, one recommendation with its reason, links, pictures,
a small view of facts, a priority and an expiry. Every key, with its limit, is in
[The Hill](tricks-reference.md#the-hill) of the Tricks reference.

Three kinds of sender post a Decision.

- **An agent** posts with `collie hill post`, and the bridge names the agent from its pane.
- **A trick** posts with its `decisions` list
  ([A program trick](tricks-authoring.md#a-program-trick)).
- **Collie itself** posts its own cards. "Use the new version of <name>?" asks about a trick's new
  code ([A new version of a trick](tricks.md#a-new-version-of-a-trick)). "Switch on the trick <id>?"
  asks about a trick an agent proposed ([A trick an agent proposes](#a-trick-an-agent-proposes)).

A Decision is in one of seven states. A closed one keeps its state and shows it.

| State | The card says |
| --- | --- |
| `open` | |
| `answered` | "Answered" |
| `dismissed` | "Dismissed" |
| `expired` | "Expired" |
| `withdrawn` | "Withdrawn by the poster" |
| `superseded` | "Replaced by a newer Decision" |
| `undeliverable` | "Could not be delivered" |

## How an agent posts

```sh
collie hill post ...
collie hill status dc_k3f9x2m8q1a0
collie hill withdraw dc_k3f9x2m8q1a0
collie hill list
collie hill state
```

An agent runs these verbs in its own pane. They talk to the running bridge over a private socket, and
Collie asks for no token. `post` prints the new id and never waits for the answer. `status` prints the
state, where the answer goes, and the answer when there is one. It works for the poster and for the
session the answer goes to, and nobody else. `withdraw` takes an open Decision back, and `list` lists
your own Decisions, open first. `state` reads the crew state.

`collie hill --help` prints every verb, how to word a card, and the rules. Every verb and flag is in
[`collie hill`](tricks-reference.md#collie-hill) of the Tricks reference. `clear`, `on`, `off`, and
`state` with a word are the person's ([Clear](#clear), [Switch the Hill off](#switch-the-hill-off),
[Here, Quiet and Away](#here-quiet-and-away)).

`status` prints the format below. This is the output on a Decision that is answered, with a test
fixture's names:

```text
dc_k3f9x2m8q1a0 answered
title: Ship 1.28.1 to Stable now?
goes to: repo#one on desk
answer: ship (Ship it)
  Go ahead after the e2e gate.
by: dv_0123456789abcdef
delivery: typed
```

### The flags of `post`

`--title` and `--summary` are required, and each option is one `--option <intent>="<label>"`. An intent
is a lower-case word of at most 32 characters of `a-z`, `0-9` and `-`, starting with a letter.
`answer` and `dismiss` are Collie's own. The body goes after `--`, in Markdown. With no body after
`--`, it is read from stdin when stdin is not a terminal.

- `--priority now` sends a notification. The default is `today`.
- `--reply-to <address>` sends the answer to another session. Use an address from `collie walky who`.
- `--supersedes dc_...` replaces an open Decision of yours. Post again with this flag, and never
  repost.
- `--request-id <uuid>` makes a retry safe: the same id posts once, and the same id with other content
  is refused.

The [reference](tricks-reference.md#collie-hill) lists every flag.

Before it posts, `collie hill post` warns on stderr when the words are weak: a title past 60
characters or with no question mark, a summary past two sentences or 200 characters, and an option
that is only Yes, No or OK. A warning never refuses the post.

### The words of a card

The person opens the card cold, between other things.

- The title is the decision as a question the options answer, in about 8 words. "Ship 1.28.1 to
  Stable now?" is good. "Are the new kinds right?" is not.
- The title holds no inner names or ids the person would not know.
- The summary is at most two sentences. The first says what the recommended option does. The second
  gives the one fact that decides it. Put the evidence in the view or the body.
- Each option starts with a verb and says what happens, such as "Ship it" or "Hold until CI". Never
  a bare Yes or No.
- `--priority now` sends a notification to the phone. Use it only for what cannot wait.

### The rules an agent gets

Every agent that has the Collie skill installed reads these rules, and `collie hill --help` prints
them ([Install the skill](walky-talky.md#install-the-skill)).

1. Post a decision only for what needs the person.
2. Always write the summary in plain words, and recommend one option with a why.
3. One question per decision. To change one, post again with `--supersedes`. Never repost.
4. Do not wait in a loop. The answer arrives as a WalkyTalky message and starts your next turn.
5. If no answer arrived, read it with `collie hill status <id>`.
6. An answer typed into your session for a decision you did not post carries only the id and the
   option word. Read the rest with `collie hill status <id>`.
7. A worker with a lead asks its lead first.
8. A `--view` only shows facts. No buttons: the options are the taps.
9. When your operator settles the question in your session, take the card back:
   `collie hill withdraw <id>`.
10. Before you post, read the crew state: `collie hill state`. here: post as usual. quiet: post, but
    do not wait for a fast answer. away: post nothing that needs an answer now; do work that needs no
    answer, then end your turn.
11. A typed answer or a post result can end with a line such as "Crew state: away." It is the state
    at that moment.

### Pictures

```sh
collie hill post --title "Ship the new header?" --summary "The shots are attached." \
  --option ship="Ship it" --option redo="Redo it" \
  --image shots/header.png="The header at 390 px"
```

A picture is a path. The bridge reads the file itself, so the bytes do not travel through the
command. A picture must be a regular file of at most 2 MB, and a PNG, JPEG or WebP by its first bytes,
never by its name. A link on the way is refused. The bridge runs with a private temporary folder and
cannot see `/tmp`, so Collie copies a picture under `/tmp` for it and removes the copy when the
request ends.

In a `--view`, an `image` node names one of your pictures by its place, from 0, such as
`{"kind":"image","attrs":{"ref":"0","focus":"50 20 2"}}`. The `focus` crops the picture on the phone,
so you need no image tool. A `compare` holds two such images. A picture the view places shows among
the facts, and not again in the row above.

### When a post fails

A refusal prints `hill: <reason> (<code>)` on stderr, then the request id and the command that sends
the same post once.

| Exit | Meaning |
| --- | --- |
| 0 | Done |
| 1 | It failed in a way no other code names, such as a bridge that answered with no Decision |
| 2 | A usage error: a flag is wrong or missing |
| 3 | A state of the machine. The Hill is off (`hill_off`), or no bridge on this machine knows this pane. A retry can pass once that changes |
| 4 | The bridge refused the post for a reason it names, such as `too_many_open`, `walky_off` or `request_id_reused` |
| 5 | No running Collie answered, or the bridge took the post and did not answer in time, or a crew member's lead did not answer. The post may still arrive. Send it again with the same `--request-id`, and the Hill keeps one Decision |

A session holds at most 20 open Decisions. The agents of one machine hold at most 40 together, and the
Hill at most 200. With the Hill off, every post is refused with: "the Hill is off on this Collie; your
person can switch it on in Settings, Alerts, on the phone, or with: collie hill on".

## How you answer

Each option is a button. Tap one, and the answer goes. A few rules shape that tap.

- An option with a confirm word arms on the first tap, shows the word, and sends on the second. One
  button of a card is armed at a time.
- "Add a note" opens a field. The note goes with the option you tap. A Decision that asks for words
  shows the field open, and its buttons send what you wrote.
- A Decision with no options is answered in words, with "Send answer".
- Dismiss closes the card and asks for a second tap. It sends no option.

Your answer is typed into the session as your own WalkyTalky message. The bridge writes the receipt,
closes the Decision, and then sends. The message holds the Decision's id, the option, and your words.

```text
Answer to dc_k3f9x2m8q1a0 "Ship 1.28.1 to Stable now?"
Option: ship (Ship it)
Go ahead after the e2e gate.
```

That message goes to the session that posted. When the answer goes to another session, because the
post named `--reply-to`, or because a trick asked, the message does not quote the title or the label.
It holds only the id, the option's word, your words and the line "Read the decision with: collie hill
status <id>". Another session must not carry the poster's own words with your authority.

## Receipts

After a tap the card says "Sending…", then one line that says what came of it.

| The card says | What happened |
| --- | --- |
| "Sent to <session>" | The answer was typed into the session |
| "Sent. <session> gets it when its turn ends" | The session was busy, and the message waits for its turn |
| "Sent, not confirmed" | The send did not confirm. The session can read the answer with `collie hill status` |
| "Dismissed" | The card is closed, and nothing was sent |
| "Recorded by <trick>" | A trick took your answer |
| "Now running the new version." | You said yes to a trick's new version or to a proposed trick |
| "Kept the old version." | You kept the version that runs |
| "Sent, but <trick> did not take it" | The message went, and the trick's program failed on the answer. Collie does not retry it |
| "Not accepted" or "Not accepted: <reason>" | The bridge refused it. For example "an answer in words is required" |
| "This Decision was already answered" | Someone answered first |
| "The session that asked has ended" | There is no session to send to. The Decision closes as undeliverable |
| "This Decision is closed" | It expired or was withdrawn |
| "This device may not answer" | The device is read-only |
| "<machine> is not answering. Your answer was not sent." | A crew machine is down. The card stays open, and you can answer again |
| "Not sent." with "Try again" | The answer did not reach the bridge |

When a Decision closes before your answer lands, the card keeps your words under "Your answer, not
delivered" and offers "Copy your answer", so you do not lose them.

The same record is in `status` as `delivery`: `typed`, `held`, `unknown` or `none`. A Decision is
never closed because a crew machine went away. Dismiss still closes it, and the phone then says the
session was not told ([Decisions from any machine](crew.md#decisions-from-any-machine)).

## Clear

Clear removes the Decisions that are closed.

- On the phone, the Answered group has a **Clear** button. It asks "Clear 3 entries?", and a second
  tap confirms.
- In a terminal, run `collie hill clear`. It prints "Cleared 3 closed decisions." or "Nothing to clear:
  no closed decisions."

A second Clear, "Clear cards you answered in the session", handles the open cards marked "You wrote
to this session after it asked." It withdraws them and clears them, and types nothing. In a terminal
it is `collie hill clear --spoken`, which refuses in a pane where an agent works.

`collie hill clear` without `--spoken` never touches an open Decision, and it works with the Hill off. Collie keeps a small marker of
each cleared Decision, so a repeated post with the same request id is refused and not posted twice,
and a late answer still reads as gone.

## Switch the Hill off

```sh
collie hill off
collie hill on
```

In Settings → Alerts, the first card is the switch **The Hill**: "Agents and tricks ask you here.
Off: they cannot post, and the Hill leaves the bar." Settings → Tricks shows the Hill too, as its
first row, tagged "Built in". The row opens an About sheet with the same switch, and it has no Remove.
If a question waits, the first tap on the switch asks you to tap again before it switches off. The
commands move the same switch, for every phone of this Collie, and the bridge reads it with no
restart.

With the Hill off:

- Agents and tricks cannot post, and agents cannot propose a trick. Nothing about a Decision is
  pushed.
- The phone takes no answer, so no message is typed and no trick runs.
- The Hill leaves the bar. Its page says "The Hill is off." and offers "Switch the Hill on".
- The open Decisions stay, and their expiry still runs. They show again when you switch it on.
- An agent can still run `status`, `list` and `withdraw`, so it can clean up.
- The crew state and "Tell all sessions now" are off too.

A post is refused with: "the Hill is off on this Collie; your person can switch it on in Settings,
Alerts, on the phone, or with: collie hill on".

Notifications for Decisions marked `now` are in
[Voice input and Web Push](voice-and-push.md#web-push-optional).

## Here, Quiet and Away

The crew state tells your agents how much you want to hear now. Only you set it.

```sh
collie hill state
collie hill state quiet
```

The Crew state control sits at the top of the Hill. It has three states:

| State | The phone says | What changes |
| --- | --- | --- |
| Here | "Agents post as usual." | Nothing. This is the default |
| Quiet | "No push. Agents post but do not wait." | No Decision sends a notification. Agents post, and do not wait for a fast answer |
| Away | "No push. Agents hold questions that need an answer now." | No Decision sends a notification. Agents post nothing that needs an answer now |

The bridge refuses no post because of the state. The agents read it with `collie hill state` before
they post, as their rules say, and an answer or a post result ends with a line such as "Crew state:
away." Under Quiet and Away the control says who set it and when. It stays until you tap Here, or run
`collie hill state here`.

`collie hill state` with a word refuses in a pane where an agent works. On a crew member it is
refused too: the state lives on the lead.

### Tell all sessions now

Under Quiet or Away, the control shows **Tell all sessions now**. One tap types the line "Crew state:
away." (or "quiet") into each agent session that waits on the Hill, as a message from you. Those are
the sessions with an open Decision, or one posted in the last hour, at most 20 of them, newest first.
A busy session gets the line when its turn ends.

The button then says "Told 3 sessions", or "No session was waiting", and stays off until the state
changes again. It uses a budget of its own, so it never uses up the messages that carry your answers.

## A trick an agent proposes

An agent can hand you a trick it wrote. It arrives as a card of Collie's own, and nothing of it runs
before your yes.

```sh
collie trick propose ~/work/disk-space
```

The card's title is "Switch on the trick <id>?". Its summary is Collie's own facts: who proposed it,
how many files it has, and what it asks for. Below come the powers it asks for, the warnings of the
text search, the author's words under "Its author's words. Collie did not check them.", and then
every file of its code, as a group of cards.

- **Switch it on** asks for a second tap, "Yes, switch on". Collie reads the stored files again and
  installs them only when their hash matches the card. The trick is then on, approved as exactly that
  code.
- **Not now** drops the stored copy. So do Dismiss, an expiry, and a newer proposal from the same
  session.

Collie never recommends either option. A proposal is code from an agent, and your own reading is the
whole check. So the yes stays off until every card of the code was on screen.

A trick that a proposal made can get a new version the same way. Its card asks "Use the new version
of <id>?" and replaces the code only on your yes.

An agent cannot propose a trick that has rules or an agent view: "A trick that gives agents
instructions cannot be proposed by an agent. Ask your person to add it on the machine." The limits on
files and on how many proposals wait are in
[A proposal from an agent](tricks-reference.md#a-proposal-from-an-agent) of the Tricks reference.

## The Hill in a crew

A crew has one Hill, on the lead. An agent on any machine can post with `collie hill post`. The phone
shows every Decision, with the machine it came from. Your answer goes back through the lead. Decisions
from a member need Collie 1.29.0 on the lead and on that member
([Decisions from any machine](crew.md#decisions-from-any-machine)).

## Where to go next

- [Tricks](tricks.md), for the tricks that ask you here.
- [Write a trick](tricks-authoring.md#a-program-trick), to post from a trick.
- [WalkyTalky](walky-talky.md), for the messages that carry your answer.
