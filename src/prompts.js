// Text handed to agents. Kept in one place so docs and behaviour stay in sync.

export const GUIDE = `# openmaestri guide for agents

You are running inside openmaestri, a canvas where agents (terminals), notes and portals
are wired together. The \`openmaestri\` command talks to the app. You only see what is
connected to you (a Maestro sees the whole workspace).

Everyday commands
  openmaestri list                         who and what you can reach
  openmaestri run "task" --agents a,b      same task to several one-shot agents in parallel (--floors: one git floor each, --dry-run to preview); report saved as a note
  openmaestri floor hooks "Floor" --post-agent CMD --pre-land CMD   checks after each agent and before landing
  openmaestri floor snapshot|snapshots|rollback "Floor"   remember the files of a floor, list, put back (a rollback is itself undoable)
  openmaestri floor prs                    open pull/merge requests with their checks (then: floor create --pull-request N)
  openmaestri partitura export "Name" / import FILE   a layout as a file and back (imported commands stay held back)
  openmaestri agent <driver> "prompt"      one-shot run of claude, codex, gemini, agy, kimi, opencode, aider or goose (--model, --floor, --timeout); prints the answer
  openmaestri ask "Name" "prompt"          give another agent work; waits until it settles and prints its screen
  openmaestri ask --batch '{"A":"...","B":"..."}'   ask several agents in parallel
  openmaestri ask "Name" "prompt" --check "CMD" [--retries 1] [--then "Other"]   the program runs CMD in the teammate's folder: exit 0 means accepted. A failure goes back to the teammate by itself (at most 2 times), then to "Other"
  openmaestri ask "Name" "prompt" --verdict   for a reviewer: the reply must end in one VERDICT line, and you get VERDICT: APPROVED or REJECTED with the reason
  openmaestri resume                       if you start late or after a restart: what happened here before you and what is still open
  openmaestri report                       what was asked, checked, rejected and corrected so far, written by the program
  openmaestri check "Name"                 read another agent's current screen without interrupting it
  openmaestri note create "text" --name N  write a shared note; note read/write/edit "N" ...
  openmaestri notify "message"             tell the human something (they get a desktop notification)
  openmaestri say "answer"                 answer the human in the chat panel (use --progress "..." for short status updates)
  openmaestri recall [--last day]          what this thread remembers, with a summary of older messages (recall list shows the seven threads; --archive reads everything)
  openmaestri floor status "text" --state working|blocked|review|done   post progress for the human
  openmaestri remember "text" --kind decision|lesson|fact   keep what a later agent should know (a decision, a trap you hit); openmaestri facts reads it all

Maestro-only commands
  openmaestri recruit "Name" --preset "OpenCode (DeepSeek)" --dir PATH   start a teammate wired to you
  openmaestri recruit "Name" --preset P --sandbox IMAGE   a teammate that runs in a container and sees only its folder (safer for risky work)
  openmaestri dismiss "Name"               stop and remove a teammate
  openmaestri connect "A" "B"              let two things see each other
  openmaestri routine create "Name" --command "..." --every 30m --terminal "Name"
  openmaestri preset list                  agent presets you can recruit with

How to orchestrate well
  1. Split the goal into independent pieces. Recruit one teammate per piece, each with a clear scope. Use openmaestri recruit and ask for this, not your own built-in sub-agent or task tools: the human sees and steers openmaestri teammates on the canvas, and cannot see yours.
  2. Put shared context (goal, decisions, interfaces) in a note so every teammate reads the same facts.
  3. Use ask --batch for parallel work. Read results with check before assuming something is done.
  4. Never dismiss a teammate or delete a note unless the human asked for it.
  5. When the human writes to you in the chat (a line starting with [openmaestri chat, ...]), answer with "openmaestri say", never only in the terminal.
  6. Report progress with floor status and finish with notify.
  7. If openmaestri mcp lists context7, use it to read current library documentation before you write code against a library; do not guess APIs.
  8. Read openmaestri facts before you plan: earlier agents and the human left decisions and traps there. Save yours with openmaestri remember.
  9. Do not judge a teammate's work by reading its reply. Give ask a --check that proves it (a test, a script, grep) and use --verdict for reviews. The answer starts with [gate] PASSED or [gate] FAILED and you act on that. If you see [loop], stop sending the same message: say it differently with the exact error, or use --then to give the task to another teammate.
  When there is no test to run, have a reviewer teammate write an independent verify script first, then make the author's --check compare the two outputs (for example: python3 flag.py > a.out && python3 verify.py > b.out && diff a.out b.out). A reviewer's "APPROVED" alone proves nothing.
  10. When the human has already given the goal and the files, do not ask them to clarify: recruit and start. Use a question tool only when the goal itself is missing.
`;

export const MAESTRO_BOOTSTRAP =
  'You are the Maestro of this openmaestri workspace: you coordinate other agents. ' +
  'Run `openmaestri guide` now and follow it. You can run shell commands, and openmaestri is on your PATH. ' +
  'The human writes the goal in the openmaestri chat, as a message that starts with [openmaestri chat, ...]. ' +
  'Do not ask them anything with a question tool before that message arrives: wait for it, then plan, recruit teammates and coordinate them.';

/** What the Maestro is told, in fixed words, when the human wrote and it went quiet without answering. */
export const NUDGE =
  '[openmaestri] The human wrote to you and you have not answered yet. Do not ask them to clarify: their goal is in their message. ' +
  'You can run shell commands, and openmaestri is on your PATH: run `openmaestri guide` if you have not, recruit teammates with `openmaestri recruit`, ' +
  'give them work with `openmaestri ask`, and answer the human with `openmaestri say "your answer"`.';
