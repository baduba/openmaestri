# Contributing to openmaestri

Thank you for helping. openmaestri is a community project: bug reports, docs, tests, new agent presets and features are all welcome.

## Ground rules

1. **Clean room.** Do not copy code, assets, prompts or text from proprietary software, including the commercial *Maestri* app. Describe behavior you want in an issue and implement it yourself. Behavior and ideas are fine; their code is not.
2. **Be kind.** See the [Code of Conduct](CODE_OF_CONDUCT.md).
3. **Security issues are private.** See [SECURITY.md](SECURITY.md).

## Set up

```bash
git clone https://github.com/<you>/openmaestri.git
cd openmaestri
npm ci                       # needs build-essential and python3 for node-pty
npm test                     # runs real PTYs; the UI test needs Chromium
npm start                    # then open the printed URL
```

The UI test looks for Chromium via `CHROME_BIN`, then the Playwright cache. Install one with `npx playwright-core install chromium`. Without it the UI test is skipped, everything else still runs.

Use a throwaway data dir while developing so you do not touch your real workspaces:

```bash
OPENMAESTRI_DATA_DIR=/tmp/om-dev OPENMAESTRI_PORT=0 npm start
```

## Workflow

1. Find or open an issue. For anything bigger than a small fix, say what you plan to do first.
2. Branch from `main`: `git switch -c feature/short-name` (or `fix/...`, `docs/...`).
3. Keep changes focused. One concern per pull request.
4. Add or update tests. CLI behavior is tested by running `openmaestri` **inside** a terminal (see `test/e2e.test.js`); agents are faked with `test/fixtures/fake-agent.sh`, so tests need no API keys.
5. Update docs (`docs/`, README) when behavior or commands change.
6. Run `npm test` and `npm run lint` (or `scripts/sast.sh` for the full static-analysis suite), then open a pull request using the template.

## Code style

- Plain modern JavaScript (ESM), no build step, no TypeScript yet. Match the surrounding code: small functions, comments that say *why*.
- Server and CLI must run on Node 20+.
- The UI uses vanilla modules. Use `textContent`, never `innerHTML`, for anything that can contain user or agent text.
- Anything that touches the network surface (HTTP, WebSocket, socket, iframes) needs a test and a note in the PR about the security impact.

## Where to start

- Issues labelled [`good first issue`](https://github.com/baduba/openmaestri/labels/good%20first%20issue) and [`help wanted`](https://github.com/baduba/openmaestri/labels/help%20wanted).
- Add a preset for an agent CLI you use (`src/store.js`, `DEFAULT_PRESETS`) and document it in `docs/deepseek.md` or a new page.
- Improve a doc page you struggled with.
- Pick from the [roadmap](TODO.md): git-worktree floors, saved layouts, portal automation, an Electron shell, macOS/Windows support.

## Reporting bugs

Follow [How to report a bug](docs/reporting-bugs.md). Run `openmaestri debug` inside the affected terminal and paste the output.

## Releases (maintainers)

Bump `version` in `package.json`, update `CHANGELOG.md`, tag `vX.Y.Z` and push the tag. The Release workflow runs the tests, builds the `.deb` and publishes the GitHub release.
