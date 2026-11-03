---
name: codemap
description: Draw a checked, interactive map that answers how something in this codebase works ("what happens when a user signs up?", "where does this email get sent?", "how does billing connect to accounts?"). Use when the user wants to understand a flow, asks how parts connect, or asks for a map, diagram or walkthrough of the code. Every box and arrow on the map is verified against the code.
---

# codemap

codemap turns a question about this repo into a map the person can explore in their browser: areas of the app, the
steps in order, labeled arrows, and red dashed arrows where something that should be connected isn't. A plain program
checks every claim against the code before it's shown. In the map they can take a walkthrough, select any box or arrow
and ask about it, and approve fixes that codemap applies and re-checks.

## When to use it

- The user asks how something works across several files: "what happens when…", "how does X reach Y", "where does Z
  get triggered".
- The user is about to change code they don't understand yet and wants to see it first.
- The user asks for a map, diagram, graph or walkthrough of part of the code.

Don't use it for a question about a single line or function; answer that directly.

## How to run it

Run from the repo root (or pass `--repo`). Use the user's question in their own words:

```bash
codemap "What happens when a patient converts?" --repo "$(git rev-parse --show-toplevel)"
```

It starts a small local server, explores the code with Claude (about a minute for a small repo), and prints a link
like `http://127.0.0.1:4317/m/<id>?t=<token>`. Give the user that link and tell them to open it. The command keeps
running to serve the map: run it in the background, and don't wait for it to exit.

Other commands:

- `codemap open` lists the maps already made in this repo (they're saved under `.codemap/maps/`).
- `codemap check <map-id>` re-checks a saved map against the current code and prints anything that no longer holds.
  It exits with 1 if a claim fails, so it can run in CI.

## Notes

- codemap reads the code and never changes it, except for a fix the user approves in the map.
- It never reads secret files (`.env`, keys) and only listens on 127.0.0.1.
- It needs Claude access: `ANTHROPIC_API_KEY`, or a logged-in Claude Code.
- If `codemap` isn't on the PATH, it hasn't been installed. Tell the user to install it from the codemap repo
  (see its README) instead of guessing another command.
