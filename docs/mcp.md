---
title: MCP servers and library docs
---

# MCP servers and library documentation

Agents guess APIs when the model's training is older than the library. An MCP server such as **Context7** hands them the current documentation. openmaestri keeps one list of MCP servers for the workspace and writes it into the project config of the agents that read one, so every teammate starts with the same tools.

```bash
openmaestri mcp add context7                     # preset: current docs for libraries (remote, works without a key)
openmaestri mcp add context7 --key CONTEXT7_API_KEY   # with a key for higher limits (see below)
openmaestri mcp add tools --command "node tools/server.js" --env MODE=fast
openmaestri mcp                                  # list
openmaestri mcp install "Dev"                    # dry run: the diff of the file that would change
openmaestri mcp install "Dev" --apply            # write it (a backup is made first)
openmaestri mcp install "Dev" --remove --apply   # take them out again
openmaestri mcp rm tools
```

## Which agents

| Agent | File written in the agent's folder | Notes |
|---|---|---|
| Claude Code | `.mcp.json` (`mcpServers`) | Claude asks you to approve each project server the first time |
| OpenCode | `opencode.json` (`mcp`) | `${VAR}` becomes `{env:VAR}`. A project with `opencode.jsonc` is left alone |

Codex, Goose and Gemini keep MCP servers in a global file, so openmaestri does not touch them. Other entries in the file are kept; only the servers of the workspace list are added, replaced or removed.

## Keys never go in the file

A header or environment value is plain text or exactly `${VAR}`. Anything that looks like a credential is refused. Put the key where your agents already get theirs, in `~/.openmaestri/env` (`CONTEXT7_API_KEY=...`, or `secret://` references, see [secrets](secrets.html)), and the placeholder is resolved when the agent starts.

## Safety

An MCP server is a program or a network service that your agent starts and trusts. So: only the Maestro adds or installs servers, a remote server must use `https` (plain `http` only for localhost) with no credentials in the URL, a local command is plain words with no shell, an install is a dry run until you pass `--apply`, nothing is written outside the workspace, and a symbolic link is never followed. If the file is committed, so is the server; read the diff.

The guide tells agents to use `context7`, when it is listed, before writing code against a library.
