---
name: illuminate
description: Draw a checked, interactive map that answers how something in this codebase works ("what happens when a user signs up?", "where does this email get sent?", "how does billing connect to accounts?"). Use when the user wants to understand a flow, asks how parts connect, or asks for a map, diagram or walkthrough of the code. Every box and arrow on the map is verified against the code.
---

# illuminate

illuminate turns a question about this repo into a map the person can explore in their browser: areas of the app, the
steps in order, labeled arrows, and red dashed arrows where something that should be connected isn't. A plain program
checks every claim against the code before it's shown. In the map they can take a walkthrough, select any box or arrow
and ask about it, and approve fixes that illuminate applies and re-checks.

## When to use it

- The user asks how something works across several files: "what happens when…", "how does X reach Y", "where does Z
  get triggered".
- The user is about to change code they don't understand yet and wants to see it first.
- The user asks for a map, diagram, graph or walkthrough of part of the code.

Don't use it for a question about a single line or function; answer that directly.

## How to run it

**In Claude Code with the illuminate MCP server** (you have an `illuminate_map` tool): call `illuminate_map` with the
user's question in their own words. It opens the map in their browser and hands you work as requests: explore the code,
then `illuminate_submit` your output. Keep going while results hold another request. Once the map is ready, call
`illuminate_listen` and leave it running: it moves to the background, and returns with a request when the user asks
something on the map. Do it, submit it, and call `illuminate_listen` again. If it returns saying nothing was asked yet,
call it again without mentioning it; if it says illuminate stopped listening, don't. If the user says "listen to
illuminate", call `illuminate_listen`. Don't edit files while working on a request, and keep what you say in the terminal to a
sentence or two: the map does the explaining. `illuminate_open` opens saved maps.

**Otherwise**, run the CLI from the repo root (or pass `--repo`). It needs `ANTHROPIC_API_KEY`:

```bash
illume "What happens when a patient converts?" --repo "$(git rev-parse --show-toplevel)"
```

It starts a small local server and opens the map in the user's browser by itself, where they watch Claude explore
(about a minute for a small repo). Don't pass `--no-open`. It also prints the link
(`http://127.0.0.1:4317/m/<id>?t=<token>`): tell the user the map is opening, and give them the link in case the tab
didn't appear. Run the command in the background and don't wait for it to exit. Don't stop it yourself either: it stops
on its own a little after the user closes the last illuminate tab (never while Claude is still working), or when they
press Stop illuminate on the page. If an illuminate server is already running, the new one picks another free port.

Other commands:

- `illume list` prints the maps already made in this repo (saved under `.illuminate/maps/`), one `<map-id>  <question>`
  per line. Use it to find a map's id, or to check whether a map for the question already exists.
- `illume open [<map-id>]` opens those maps in the user's browser (one map, or the list of all of them).
- `illume check <map-id>` re-checks a saved map against the current code and prints anything that no longer holds.
  It exits with 1 if a claim fails, so it can run in CI.

## Notes

- illuminate reads the code and never changes it, except for a fix the user approves in the map.
- It never reads secret files (`.env`, keys) and only listens on 127.0.0.1.
- In Claude Code it uses the session it runs in, so no key. The CLI needs `ANTHROPIC_API_KEY`.
- If `illume` isn't on the PATH, it hasn't been installed. Tell the user to install it from the illuminate repo
  (see its README) instead of guessing another command.
