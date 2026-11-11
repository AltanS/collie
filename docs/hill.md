# The Hill

The Hill is the place on your phone where an agent or a trick asks you a question. One question is
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

The header says how many Decisions are open and how many are Now. With nothing open the page says
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

The recommended option carries a star. Collie never preselects it, and never focuses it. A
recommendation that you do not read must not become the answer by default.

## What a Decision is

A Decision is one question with its choices. The sender writes all of it.

| Part | What it is | Limit |
| --- | --- | --- |
| Title | The question, as a sentence the options answer | 120 characters. Aim for 60 |
| Summary | What the recommended option does, and the one fact that decides it | 280 characters. Aim for two sentences |
| Body | Longer text in Markdown, behind "More" | 4000 characters |
| Options | The choices. Each has a word the sender reads back, a label, and optionally a detail and a confirm word | Up to 5. Label 40, detail 120, confirm 24 characters |
| Recommendation | One option, with a reason | Reason 200 characters |
| Text | Whether you may or must add words | `optional` (default), `required` or `none` |
| Links | Web pages that give more | Up to 5. Label 40, address 500 characters |
| Pictures | PNG, JPEG or WebP | Up to 4, 2 MB each, caption 80 characters |
| View | A small set of facts under the summary | 8 KiB, 100 nodes, 4 levels |
| Priority | `now`, `today` or `later` | One sender holds at most 3 open `now` Decisions. A further one shows as `today` |
| Expiry | When it closes by itself | 14 days by default, at most 30 |

Three kinds of sender post a Decision. An agent posts with `collie hill post`, and the bridge names
the agent from its pane. A [trick](tricks-authoring.md#posting-a-decision-from-a-trick) posts with its
`decisions` list. Collie itself posts one kind of card, "Use the new version of <name>?", when a trick
has new code ([A new version of a trick](tricks.md#a-new-version-of-a-trick)).

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

An agent runs these verbs in its own pane. They talk to the running bridge over a private socket, and
Collie asks for no token. `collie hill --help` prints every verb, how to word a card, and the rules.

| Verb | What it does |
| --- | --- |
| `collie hill post ...` | Post one Decision and print its id. It never waits for the answer |
| `collie hill status <id> [--json]` | Print the state, where the answer goes, and the answer when there is one. Works for the poster and for the session the answer goes to, and nobody else |
| `collie hill withdraw <id> [--json]` | Take an open Decision back |
| `collie hill list [--json]` | List your own Decisions, open first |
| `collie hill clear [--json]` | Remove every closed Decision from the Hill. Open ones stay. Prints how many went |
| `collie hill on`, `collie hill off` | Switch the Hill on or off for this Collie |

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

`--title` and `--summary` are required.

| Flag | What it does |
| --- | --- |
| `--title "<question>"` | The question |
| `--summary "<plain words>"` | The summary |
| `--option <intent>="<label>"` | One option. Repeat it for each. An intent is a lower-case word of at most 32 characters of `a-z`, `0-9` and `-`, starting with a letter. `answer` and `dismiss` are Collie's own |
| `--recommend <intent> --why "<reason>"` | The recommendation. The two go together |
| `--confirm <intent>="<word>"` | The option needs a second tap, and this word shows on the first |
| `--detail <intent>="<line>"` | A line under the option |
| `--priority now\|today\|later` | Default `today`. `now` sends a notification |
| `--text none\|optional\|required` | Default `optional`. `none` needs at least one option |
| `--link "<label>=https://..."` | A link. Repeat it, up to 5 |
| `--about here\|<address>` | The session whose Chat the card opens. `here` is your own |
| `--reply-to <address>` | Send the answer to this session, not to you. Use an address from `collie walky who` |
| `--supersedes dc_...` | Replace an open Decision of yours. Post again with this flag, and never repost |
| `--expires 2h\|3d` | Close as expired after this time. A number and `m`, `h`, `d` or `w`. At most 30 days |
| `--request-id <uuid>` | Retry a post. The same id posts once. The same id with other content is refused |
| `--image <path>[="<caption>"]` | A picture, up to 4 |
| `--view <file.json>` | A small view of facts. At most 16 KiB of file, then 8 KiB of compact JSON |
| `--json` | Print the whole Decision as JSON, not only its id |
| `-- "<body>"` | The body in Markdown. With no body after `--`, it is read from stdin when stdin is not a terminal |

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

Clear never touches an open Decision, and it works with the Hill off. Collie keeps a small marker of
each cleared Decision, so a repeated post with the same request id is refused and not posted twice,
and a late answer still reads as gone.

## Switch the Hill off

In Settings → Alerts, the **The Hill** switch turns it off. `collie hill off` moves the same switch.

With the Hill off, agents and tricks cannot post, and nothing about a Decision is sent. The phone
answers nothing, so no message is typed and no trick runs. The Hill leaves the bar. The open
Decisions stay as they are, and show again when you switch it on. A page you reach from an old
notification says "The Hill is off." and offers "Switch the Hill on".

Notifications for Decisions marked `now` are in
[Voice input and Web Push](voice-and-push.md#web-push-optional).

## The Hill in a crew

A crew has one Hill, on the lead. An agent on any machine can post with `collie hill post`. The phone
shows every Decision, with the machine it came from. Your answer goes back through the lead. Decisions
from a member need Collie 1.29.0 on the lead and on that member
([Decisions from any machine](crew.md#decisions-from-any-machine)).

## Where to go next

- [Tricks](tricks.md), for the tricks that ask you here.
- [Writing a trick](tricks-authoring.md#posting-a-decision-from-a-trick), to post from a trick.
- [WalkyTalky](walky-talky.md), for the messages that carry your answer.
