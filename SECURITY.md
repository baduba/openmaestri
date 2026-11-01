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
