<div align="center">

<img src="assets/icon.svg" alt="openmaestri" width="96" height="96" />

# openmaestri

### A spatial canvas terminal workspace for AI agents. Open source.

**Put your coding agents on an infinite canvas. Wire them together. Let one Maestro orchestrate the rest, even with cheap open models like DeepSeek.**

[![CI](https://github.com/baduba/openmaestri/actions/workflows/ci.yml/badge.svg)](https://github.com/baduba/openmaestri/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-4cc38a?style=flat-square)](CONTRIBUTING.md)

[Quick start](#quick-start) · [How it works](#how-it-works) · [DeepSeek and open models](#deepseek-and-open-models) · [CLI](#the-openmaestri-cli) · [FAQ](#faq) · [Docs](https://baduba.github.io/openmaestri/) · [Report a bug](docs/reporting-bugs.md)

</div>

> [!NOTE]
> openmaestri is an independent, community project. It is **not affiliated with, endorsed by, or derived from the code of** the commercial app *Maestri*. It is a clean-room implementation of the same idea (a canvas of agents that can talk to each other), written from observed behavior and public documentation.

<br />

## Why

Running three agents in three terminals means you are the message bus: copy this, paste that, check which one finished. openmaestri makes the agents first-class neighbors instead.

- **A canvas, not tabs.** Terminals, notes and web portals live on one pannable, zoomable surface. You see everything at once.
- **Connections are permissions.** An agent only sees what is wired to it. Draw a cable between two agents and they can `ask` each other.
- **A Maestro that orchestrates.** Mark one agent as Maestro and it can recruit teammates, split work, run them in parallel and read their results, using the same `openmaestri` CLI available in every terminal.
- **Any agent, any model.** OpenCode, Aider, Claude Code, Codex, Gemini CLI, Goose, or a plain shell. Presets for **DeepSeek** are built in.
- **Local and private.** One Node process on `127.0.0.1`. No account, no telemetry, no cloud. Your keys live in a `0600` file on your machine.

## Quick start

### Debian / Ubuntu (`.deb`)

```bash
# Node.js 20+ is required (https://nodejs.org or NodeSource)
sudo apt install ./openmaestri_0.7.0_amd64.deb
openmaestri serve --open
```

Download the `.deb` from the [latest release](https://github.com/baduba/openmaestri/releases/latest).

### From source

```bash
git clone https://github.com/baduba/openmaestri.git
cd openmaestri
npm ci            # compiles node-pty: needs a C++ toolchain (build-essential, python3)
npm start         # prints the UI URL, e.g. http://127.0.0.1:7777/?token=...
```

Open the printed URL (it carries a one-time token that is stored as a cookie). Click **+ Terminal**, pick a preset, and you are running an agent on the canvas.

## How it works

```
┌────────────────────────── browser (canvas UI, xterm.js) ───────────────────────────┐
│  terminals · notes · portals · connections · workspaces                              │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │ WebSocket (token + same-origin checks), loopback only
┌───────────────┴──────────────── openmaestri daemon (Node) ───────────────────────────┐
│  store (JSON, atomic)   PTYs (node-pty) + headless xterm   scheduler (routines)       │
│                         ▲                                                             │
└─────────────────────────┼─────────────────────────────────────────────────────────────┘
                          │ Unix socket (0600)         env: OPENMAESTRI_SOCKET / TERMINAL_ID
              ┌───────────┴────────────┐
              │ agent terminal         │  agents run `openmaestri ask "Alice" "..."`
              │  $ openmaestri list    │  and the daemon routes it to the connected terminal
              └────────────────────────┘
```

Every terminal is spawned with `OPENMAESTRI_SOCKET` and `OPENMAESTRI_TERMINAL_ID`, and `openmaestri` on its `PATH`. The daemon keeps a headless xterm mirror of each screen, so `check` and `ask` return what a human would see, not raw escape codes.

## DeepSeek and open models

openmaestri does not call any model itself. Your agent CLI does, so any model that your agent supports works. For DeepSeek:

```bash
mkdir -p ~/.openmaestri && install -m 600 /dev/null ~/.openmaestri/env
cat >> ~/.openmaestri/env <<'ENV'
DEEPSEEK_API_KEY=sk-...
OPENMAESTRI_DEEPSEEK_MODEL=deepseek-flash
ENV
```

Then pick **OpenCode (DeepSeek)**, **Aider (DeepSeek)** or **Maestro (OpenCode + DeepSeek)** in the New terminal dialog. OpenCode also needs `opencode auth login` once (or `/connect` inside it). Details and model ids: [docs/deepseek.md](docs/deepseek.md).

## The `openmaestri` CLI

Available inside every terminal started by openmaestri.

| Command | What it does |
|---|---|
| `openmaestri list` | Agents, notes and portals you can reach |
| `openmaestri ask "Alice" "prompt"` | Send a prompt, wait until Alice settles, print what she produced |
| `openmaestri ask --batch '{"A":"…","B":"…"}'` | Ask several agents in parallel, get a JSON array |
| `openmaestri ask "Alice" --raw "2\n"` | Send raw keystrokes (menus, Ctrl-C with `\x03`) |
| `openmaestri check "Alice"` | Read Alice's screen without interrupting her |
| `openmaestri note create/read/write/edit/delete` | Shared notes, stored as plain Markdown files |
| `openmaestri notify "msg"` | Desktop notification for the human |
| `openmaestri recruit "Bob" --preset "OpenCode (DeepSeek)"` | Maestro: start a teammate wired to you |
| `openmaestri routine create "nightly" --command "run tests" --daily 02:00` | Maestro: scheduled prompts |
| `openmaestri guide` | The instructions an agent should follow to orchestrate well |

Full reference: [docs/cli.md](docs/cli.md).

## Status

openmaestri is **early (0.x)**. What works today: canvas, terminals, notes, portals (URL panes), connections, workspaces, routines, presets/roles, the full agent CLI, `.deb` packaging, and 16 automated end-to-end tests that run real PTYs and a real browser. See the [roadmap](TODO.md) for what is next: git-worktree floors, saved layouts (partituras), portal page automation, an Electron shell.

## Security

An app that opens shells must be careful. The web UI listens on loopback only, requires a random per-install token, and rejects foreign `Host`/`Origin` headers (DNS rebinding). The agent socket is `0600` in a `0700` directory. Portals run in sandboxed iframes. Read [SECURITY.md](SECURITY.md) and report vulnerabilities privately.

## FAQ

**Is this the same as Maestri?** No. It is a separate open implementation of a similar idea. It shares no code with it.

**Does it work on macOS or Windows?** The daemon is plain Node plus node-pty, so macOS should work from source. It is tested on Linux only. Windows needs ConPTY work. Contributions welcome.

**Do I need an API key?** Only for the agent you run. openmaestri itself has no account or cloud.

**Why can't an agent see another agent?** Visibility follows connections. Connect them (the ⚭ button, or `openmaestri connect A B` from a Maestro). Maestros see the whole workspace.

**An agent's answer is cut off or arrives too early.** `ask` waits for the terminal to be quiet for a moment. Slow models may need `--timeout 5m`, and `check` always shows the current screen.

## Documentation

- [Getting started](docs/getting-started.md) · [CLI reference](docs/cli.md) · [DeepSeek and open models](docs/deepseek.md)
- [Architecture](docs/architecture.md) · [Troubleshooting](docs/troubleshooting.md) · [How to report a bug](docs/reporting-bugs.md)
- Site: https://baduba.github.io/openmaestri/

## Contributing

This is a community project and help is the whole point. Start with [CONTRIBUTING.md](CONTRIBUTING.md); issues labelled `good first issue` are picked to be approachable. Found a bug? [Open an issue](https://github.com/baduba/openmaestri/issues/new/choose) and run `openmaestri debug` inside the affected terminal to attach diagnostics.

## License

[MIT](LICENSE)
