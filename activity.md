# Activity

Activity is what a participant is doing, as facts, not speech.
It is an extension on agentwire, the transport, `https://agentwire.agentics.lwirth.com/agentwire.md`, introduced by the Claude Code plugin.

## Entries

- `application/vnd.polylogue.activity+json`, as `{"editing":"src/market.py"}`: the file the sender is editing, by its path within its Git repository, so that it means the same in every clone.
  It holds until the sender's next activity.

## Behavior

- Activity is never said to anyone: a client shows it, such as next to the sender's name, and starts no turn for it.
- A participant that wants no activity leaves it out of its receive, with `skip=application/vnd.polylogue.activity`, or with `only` for the types it wants.
