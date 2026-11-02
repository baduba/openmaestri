---
title: Files
---

# Files

A **Files** node (`+ Files` in the toolbar) shows the folder of the current floor, or the workspace folder on the ground floor, as a tree with a plain text editor beside it. It is for reading and fixing a file while you watch your agents work, not a replacement for your editor.

## What it does

- **Tree**: folders open on click; `.git` and `.openmaestri` are never shown. Files git reports as modified (orange), new (green) or deleted (red) are marked.
- **Editor**: `Ctrl+S` saves. A dot shows unsaved changes. Files over 1 MB and binary files are not opened.
- **Versions**: every save keeps the previous content (the last 10, under the workspace data folder). Pick one from the **Versions** list to bring it back into the editor, then save to keep it.
- **Markdown preview**: `Preview` renders headings, lists, quotes, code blocks, bold, italic, code and `http(s)` links. Raw HTML in the file is shown as text, never run.
- **New, rename, delete**: delete moves the item to a trash next to the version backups; nothing is erased outright.

## Tabs, search and colours

- **Tabs:** every file you open gets a tab. Switching keeps each file's unsaved text, and a ● marks a tab with changes.
- **Search:** the box above the tree searches the text of all files below the folder (not a pattern, case does not matter, two characters at least). It skips `node_modules`, build folders, `.git`, binaries, files over 1 MB and symbolic links, and stops at 200 matches. Click a result to open the file at that line.
- **Colours:** comments, strings, numbers and keywords are coloured for JavaScript, TypeScript, JSON, Python, shell, YAML and CSS files up to 200 KB. It is colouring, not parsing, so unusual code just looks plain.

## Safety rules

- Every path is checked after resolving symbolic links, and must stay inside the folder of the node. `..`, absolute paths, backslashes and NUL are refused.
- A symbolic link that points outside the folder is not listed and cannot be read; a symbolic link is never written through.
- A save is refused when the file changed on disk after you opened it (an agent may have edited it): reload, or copy your text first.
- A save writes a temporary file and renames it, and keeps the file's permissions.
- Reads use one descriptor and never block on a pipe.

## From a script

The same operations travel over the UI WebSocket as `files.op` (`list`, `read`, `write`, `create`, `rename`, `remove`, `status`, `versions`, `version`) and are only accepted for a node of kind `files`.
