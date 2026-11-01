---
title: Portals
---

# Portals

A portal is a web page on the canvas that **both you and your agents can drive**. It is a real Chromium running on your machine, shown as a live view; you click and type in it, and agents use `openmaestri portal ...` on the same page.

## Requirements

Chrome or Chromium on the machine that runs openmaestri (`apt install chromium`, or Google Chrome). openmaestri looks in the usual places; set `OPENMAESTRI_CHROME=/path/to/chrome` to choose one. Without a browser, a portal falls back to a plain sandboxed iframe: you can look at the page, but agents cannot act on it, and many sites refuse to be framed.

In containers where Chrome's own sandbox cannot start, set `OPENMAESTRI_CHROME_NO_SANDBOX=1` (this weakens the browser's isolation; do not browse untrusted sites that way).

## The agent loop

```bash
openmaestri portal create http://localhost:3000 "App"
openmaestri portal snapshot "App"          # the page as an accessibility tree, with @refs
openmaestri portal fill "App" @e2 "ada@example.com"
openmaestri portal click "App" @e5
openmaestri portal wait "App" "#dashboard" 8000
openmaestri portal text "App" "#dashboard h1"
openmaestri portal screenshot "App"        # prints the path of a PNG
```

`snapshot` prints one line per useful element:

```
page: Sign in  http://localhost:3000/login
heading "Sign in" [level=1]
@e1 heading "Sign in" ...
@e2 textbox "Email" value=""
@e3 textbox "Password" [required]
@e4 checkbox "Remember me"
@e5 button "Sign in" [disabled]
```

A **target** is `@e3` (from the last snapshot), a CSS selector, or `x,y` page pixels. References belong to one snapshot: after the page navigates they are rejected with "run `portal snapshot` again", so an agent never clicks the wrong element.

## Commands

| Command | Does |
|---|---|
| `portal create URL ["Name"] [--size WxH]` | New portal wired to you (http and https only) |
| `portal edit "P" --url URL` · `portal close "P"` | Navigate · remove (the browser is closed) |
| `snapshot` (alias `a11y`) | Accessibility tree with `@e` references |
| `click` · `hover` · `drag A B` | Mouse actions on a target |
| `fill T "text"` · `type "text"` · `clear [T]` | Set a field (fires `input`/`change`) · type into the focused element · empty a field |
| `key "Enter"` | Key press; modifiers as in `ctrl+a`, `cmd+c`, `shift+tab`; also F1-F12, arrows, Home/End |
| `focus T` · `selectall [T]` · `select T "Option"` | Focus, select text, pick a `<select>` option by its text |
| `check [T]` · `uncheck T` | Tick or clear a checkbox (`check` with no target takes a screenshot) |
| `navigate "url"` · `back` · `forward` · `reload` | History |
| `scroll down 300 [T]` · `scrollintoview T` | Scroll the page, or the container under a target |
| `text T` · `html` · `info` | Read element text, page HTML (cut at 200 KB), url/title/viewport |
| `wait T [ms]` | Wait until a target is on the page and visible (default 5000 ms) |
| `evaluate "js"` | Run JavaScript in the page and print the result as JSON |
| `logs-start` · `logs` | Capture console output and page errors, then read and clear them |
| `screenshot` | PNG saved under `~/.openmaestri/portals/<id>/` (the last 20 are kept) |
| `resize W H` · `ua [preset]` | Exact viewport in CSS pixels · `ios`, `android`, `chrome`, `edge`, `firefox`, `desktop` |
| `upload T file...` | Fill a file input; files must be inside the workspace or a floor |

Android device portals (`portal devices`, `tap`, `swipe`, ...) are not implemented yet.

## What a portal can and cannot do

- Only **http and https** pages open. `file:`, `chrome:`, `devtools:`, `view-source:`, `ftp:` and `javascript:` are refused for agents and blocked inside the browser (a page that redirects to `file:///etc/passwd` stays where it was).
- Each portal has its **own temporary profile**: no cookies or logins from your normal browser, and nothing is kept after the portal closes.
- The browser is controlled over a **pipe**, not a TCP debugging port, so no other process can attach to it.
- Pages that open new windows are kept in the same portal; dialogs (`alert`, `confirm`) are answered automatically.
- A portal's browser is shut down when its node is deleted, when openmaestri stops, or after 15 idle minutes with nobody viewing it; it restarts at the last URL on the next use.
- `evaluate` and `upload` act with your privileges inside the page and on the workspace folder. Treat agents that browse untrusted sites like you would any automation: prompt injection through page content is possible (see [SECURITY.md](https://github.com/baduba/openmaestri/blob/main/SECURITY.md)).
