---
title: Floors
---

# Floors

A workspace has a **ground floor** (the project directory) and any number of extra **floors**. Each floor is its own canvas. In a git project a floor can also have its own checkout and branch, so agents on different floors never edit the same files.

## Why

Three agents on three features in one working tree step on each other. Give each feature a floor: its agents run in that floor's folder, on that floor's branch. When a feature is done, **land** the floor: its branch is merged into the project and the floor goes away.

## Kinds

| Kind | What it is | When |
|---|---|---|
| `worktree` | `git worktree add` under `<project>/.openmaestri/floors/<name>`, on a new branch `floor/<name>` | default in a git project; cheap, shares objects |
| `clone` | an independent `git clone --local` (`--copy`) | full isolation (own `.git`, own hooks) |
| `dir` | a folder you already have (`--dir PATH`) | your own worktree; nothing is checked out |
| `plain` | no checkout; shares the project folder (`--no-git`, or not a git project) | notes-only or non-git work |

The floors folder is added to the repository's `.git/info/exclude`, so it never shows up in `git status`.

## From the CLI (Maestro)

```bash
openmaestri floor create "Login" [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground] [--partitura P]
openmaestri floor create "Mine" --dir ~/work/my-worktree
openmaestri floor prs                               # open pull/merge requests with their checks
openmaestri floor create --pull-request 123          # fetches the pull request into a floor (GitLab: merge request)
openmaestri recruit "Dev" --preset "OpenCode (DeepSeek)" --floor "Login"
openmaestri floor status "tests passing" --state review --progress 4/5
openmaestri floor list
openmaestri floor land "Login" [--into main] [--delete-branch] [--keep-floor]   # from the ground floor
openmaestri floor delete "Login" [--keep-branch] [--keep-folder] [--force]       # from the ground floor
openmaestri floor unload "Login"                      # stop its terminals; they restart when you open the floor
```

Agents see the cables that reach them, as always. A Maestro also sees everything on its own floor. `recruit --floor` places the teammate on another floor and wires it to you across floors.

## From the UI

The floor bar at the bottom left switches floors (`+ Floor` creates one). The palette (Ctrl+K) has `Go to floor`, `Land floor`, `Delete floor` and `Floor status`. Each floor remembers its status message, shown in the toolbar.

## Landing, safely

`floor land` refuses unless both the floor and the ground floor have no uncommitted changes. It merges the floor's branch into the project's current branch (or `--into BRANCH`). If the merge conflicts, it **aborts the merge, changes nothing, keeps the floor**, and lists the conflicting files; merge the project branch into the floor first and resolve them there.

`floor delete` refuses a floor with uncommitted changes unless `--force`, and keeps a branch that has unmerged commits (it tells you).

## Limits

- Undo/redo covers the canvas of every floor, but creating or deleting a floor itself (and its checkout) is not undoable.
- Hooks that run on floor creation or landing are not implemented yet.
- **Repository hooks do not run** during floor operations (`post-checkout`, `pre-merge-commit`...): they are code from the repository. Set `OPENMAESTRI_GIT_HOOKS=1` before starting openmaestri if you want them.
- Everything shells out to your installed `git`, with argument arrays (no shell), validated branch names and a 60 second timeout.

## Pull requests and merge requests

`openmaestri floor prs` lists the open pull requests (GitHub, through `gh`) or merge requests (GitLab, through `glab`) of the workspace repository, with the state of their checks:

```
#12   ok   feat/x         ana     Add the files browser
#9    FAIL draft wip      bo      WIP
```

`ok`, `FAIL`, `...` (running) and `-` (no checks) come from GitHub's check results. GitLab's list does not include pipelines, so merge requests show `?`. `--json` prints the rows for scripts, `--provider github|gitlab` is needed only when the `origin` URL is on a self-hosted host.

Then `openmaestri floor create --pull-request 12` (a number, `#12`, or the page URL) fetches that request into its own floor, on a branch `pr-12`, so an agent can review or fix it without touching your checkout.

- It uses **your** `gh` or `glab`, already signed in; openmaestri never sees or keeps a token. If the program is missing, the message tells you where to get it.
- It is read-only: nothing is pushed, commented or merged. Titles, branch names and authors are written by other people, so control characters and direction-changing characters are removed before they are shown.
- A `gh` or `glab` that resolves inside the workspace is refused, like the agent CLIs.

## Snapshots and rollback

A snapshot remembers every file of a floor at one moment: edited files, new files and deletions. Ignored files (what `.gitignore` lists) are not part of it. It is stored inside the repository as a hidden git object under `refs/openmaestri/snapshots/`, so nothing appears in `git status`, `git log` or your branches.

```bash
openmaestri floor snapshot "Work" --label "tests pass"
openmaestri floor snapshots "Work"          # newest first
openmaestri floor rollback "Work"           # back to the latest one
openmaestri floor rollback "Work" 20261102093015123-a1b2
```

- **A rollback can be undone.** Before putting the files back it takes a snapshot of how they are now, and prints the command that returns to it.
- **Automatic ones.** `openmaestri run --floors` takes a snapshot of each agent's floor when the agent finishes (the report prints its id), and `floor land` takes one just before landing.
- **What it restores:** files. It does not move the branch: commits made after the snapshot stay (the rollback tells you when that happened), and the staging area is not restored.
- It refuses while an agent in that floor is printing output, because files would change under it.
- Only the last 20 snapshots of a floor are kept, and deleting the floor removes them. A snapshot of a floor with very large files takes room in `.git`.
- A tree with more than 20000 new files that git does not ignore (for example a `node_modules` that is missing from `.gitignore`) is refused with advice, because every snapshot would be slow and heavy. `OPENMAESTRI_SNAPSHOT_MAX_FILES` raises the limit.
- It needs the floor folder to be the top of a git repository or worktree. The ground floor works too.
