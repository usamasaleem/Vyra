# The scheduled builder: start here

The routine "Vyra: build the next 'For Claude' card" (in the Claude app) holds only its schedule and a one-line prompt
pointing at this file. The instructions live in the repository, versioned with the code; `.claude/builder-full.md`
has the rest. Both are the builder's to improve: when a run shows a rule is wrong or missing, fix it in the same commit
as the card and say so in the card's note.

To set the routine up on another machine: create a routine whose working folder is this repository, scheduled every
30 minutes, with the prompt "Read .claude/builder.md in this repository and follow it exactly." Keep
`.claude/settings.local.json` as it is: its allow list and its PermissionRequest hook are what let an unattended run
go without stopping for approval.

## The quick check — every run starts here, and most end here

Most checks find nothing to do, and every model call re-reads the whole session, so an idle check is three calls and
writes nothing. While you are in it: write no messages between steps, read no other file (no CLAUDE.md, no memory),
run no git, and make no board writes (an update needs a version you would have to read first; that is a call).

1. Your first message (the routine's prompt asks for this) calls three tools together: Read this file, ToolSearch with
   "select:ArtifactData", and Bash `date -u +%Y-%m-%dT%H:%M:%SZ`. The date is "now"; "recent" = now minus 40 minutes.
2. In ONE message, make all three ArtifactData calls on https://claude.ai/artifact/K5TXRVHyU3gzqpqoMin4sz:
   a. get — collection "meta", doc_id "state".
   b. query — collection "items", where status == "queued", order_by queuedAt ascending, limit 1.
   c. query — collection "items", where updatedAt > recent, limit 10.
3. Decide, from what came back:
   - `builder` in meta/state (defaults: every 60). slack = min(5, ceil(every / 5)) minutes.
   - retune = `builder.tunedAt` is missing, or `builder.changedAt` is later than it.
   - changed = the cards from (c) whose updatedAt is later than the top-level `upkeepAt` (all of them if it is missing).
   - build = a card came back from (b) and either `runNow` or `runAll` is true, or `every` > 0 and `lastRunAt` is
     missing or at least (every − slack) minutes before now.
   - stale = `runNow` or `runAll` is true but nothing came back from (b); those flags need clearing.
   If build, retune, changed and stale are all false, stop now. Your whole reply is one line: "Nothing queued.", "Not due
   yet.", or "Paused on the board." Write nothing else anywhere.
   Otherwise read `.claude/builder-full.md` and follow it, carrying over everything above.
