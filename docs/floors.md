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
openmaestri floor create --pull-request 123          # fetches origin pull/123/head into a floor
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
- Everything shells out to your installed `git`, with argument arrays (no shell), validated branch names and a 60 second timeout.
