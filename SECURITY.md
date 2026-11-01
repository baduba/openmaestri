# Security policy

openmaestri starts shells and runs AI agents, so security bugs can be serious. Thank you for reporting them responsibly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
<https://github.com/baduba/openmaestri/security/advisories/new>

Please include what you found, steps to reproduce, the impact you see, and your version (`openmaestri version`). You should get a first answer within a few days. We will credit you in the fix unless you prefer otherwise.

## Supported versions

Only the latest release receives fixes while the project is 0.x.

## What is in scope

- Anything that lets a web page, another local user, or another origin reach the UI server, the WebSocket, or the agent socket without the token
- Bypassing the connection-based visibility rules (an agent acting on something it is not connected to) or the Maestro-only checks
- Path traversal in static file serving, note files or workspace storage
- Secrets leaking into workspace files, logs or the network
- Escapes from the portal iframe sandbox

## Design notes for reviewers

- The UI server binds `127.0.0.1` only, requires a per-install token, and checks `Host` and `Origin`.
- The agent socket is `0600` in a `0700` directory. A process that can connect already runs as the same user; the in-app permission model limits what an *agent* can do to the rest of the workspace, not what a hostile local process can do.
- Agents run with your privileges. That is inherent to terminal agents; do not point openmaestri at untrusted prompts or untrusted repositories with an agent that has shell access.

## Threat model in short

| Asset | Threat | Mitigation |
|---|---|---|
| A shell on your machine (the UI) | A web page or another origin reaching the server | loopback bind, 192-bit token, `Host`/`Origin` allow-list, CSP, `frame-ancestors 'none'`, `SameSite=Strict` cookie |
| The agent socket | Another local user | `0600` socket in a `0700` directory |
| Workspace files | Path traversal through ids | ids must be canonical UUIDs (`safeId`) |
| Your API keys | Ending up in repositories | read from `~/.openmaestri/env`, never written to workspace files; a warning is printed if the file is group or world readable |
| The human's attention | A looping agent spamming notifications | 20 notifications per minute per terminal |
| Roles | Persistent instructions planted through a repository or a symlink | dry run by default, backup, marked block, symlink and outside-workspace targets refused, repository roles need --trust, Maestro only |
| Saved prompts and prices | Path tricks in names; hostile numbers in the prices file | strict name rule, O_NOFOLLOW reads, 64 KB cap; prices file is validated as plain numbers |
| Mentions | Reading files or notes the user did not intend to share with the agent | `@file:` only inside the workspace, 32 KB, never secret-looking, symlinks refused, preview before sending, notes limited by wiring for agents |
| Chat | Script injection through agent text; leaking files through attachments; keystrokes smuggled to the Maestro | text rendered with `textContent`; attachments only from the workspace, never secret-looking files, copied to a `0600` vault; control characters stripped; rate limit; thread ACL |
| Portal and cloud | A page or an agent reaching the machine's cloud credentials or the control port | metadata and link-local addresses and openmaestri's own port are refused in the URL check and inside the browser |
| Repositories | Code in repository hooks running during floor operations | hooks off by default, opt in with OPENMAESTRI_GIT_HOOKS=1 |
| Resource use | Recruiting terminals until the machine stalls | ceiling of 40 running terminals (OPENMAESTRI_MAX_TERMINALS) |
| Portal browsers | A page or an agent reaching local files or other processes | only http/https; `file:`/`chrome:`/`devtools:` blocked in the browser; DevTools over a pipe (no TCP port); throwaway profile per portal; uploads limited to workspace folders |
| Agent-to-agent traffic | **Prompt injection**: text returned by `ask`/`check` is untrusted input for the agent that reads it | not solvable by the app; give agents least-privilege directories and review what a Maestro recruits |

Run `scripts/sast.sh` before sending a pull request that touches the network surface. Details: [docs/security-scanning.md](docs/security-scanning.md).
