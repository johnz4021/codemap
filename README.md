# codemap

Ask how your code works and get a map you can point at. Claude explores the repo and drafts the answer as a graph of
areas, steps and labeled arrows. A plain program checks every box and arrow against the real code before you see it.
Then you can take a walkthrough, select any part and ask about it, and fix a missing connection right from the map.

Design: [Codemap v1 Design](https://claude.ai/artifact/55L8tokprGe61qtfpDXJ5h).

## Use it

```
npm i
npm run build                                              # the viewer
npm run codemap -- "What happens when a user signs up?" --repo /path/to/your/repo
```

It prints a link (`http://127.0.0.1:4317/m/<id>?t=<token>`) and opens it. Maps are saved in the target repo under
`.codemap/maps/`; commit them to share. Other commands:

```
npm run codemap -- open --repo <dir>            # maps already made in that repo
npm run codemap -- check <map-id> --repo <dir>  # re-check a saved map against the code (exit 1 if a claim fails)
```

Options: `--port <n>` (default 4317), `--no-open`, `--model <id>` (default `claude-opus-5-5`, or `CODEMAP_MODEL`).

Claude access: an `ANTHROPIC_API_KEY`, or a logged-in Claude Code (the Agent SDK uses it).

To put `codemap` on your PATH: `npm link -w @codemap/server`.

### From a coding agent

`integrations/skills/codemap/SKILL.md` is a skill in the standard `SKILL.md` format. Copy the `codemap` folder into
`.claude/skills/` (Claude Code), `.agents/skills/` (Codex, Gemini CLI) or `.cursor/skills/` (Cursor). Your agent then
runs codemap when you ask how something works, and hands you the link.

### Try it without a model

```
npm run preview
```

The real server and viewer on a throwaway copy of the care-app fixture, with a scripted stand-in for Claude. Nothing
is sent anywhere. Useful for UI work and demos.

## How it works

1. **Make a map.** A deterministic scan gives Claude a head start (entry points, routes, which requests hit which
   routes, which tables are written). Claude explores with Read/Grep/Glob only and returns the map in a fixed format.
2. **Check every claim.** `check()` re-reads each cited line, verifies calls, requests and imports against code facts,
   and re-runs the search behind every "nothing does X". Claude gets up to two rounds to fix what didn't hold. Anything
   still unconfirmed is shown with a "?", never hidden.
3. **Explore.** The viewer draws areas, steps, labeled arrows and red dashed gaps, with a walkthrough Claude wrote. Select
   anything and ask: answers come at three depths (concept, how it works, code) with their sources. Claude explores
   further when the map isn't enough; what it finds is drawn only if it passes the checker.
4. **Fix from the map.** Ask for a change and Claude proposes a fix, drawn as a green dashed arrow next to the exact diff.
   Nothing changes until you approve. Then codemap writes exactly that change (refusing if the files changed since),
   re-checks the map, and offers Undo.

## Packages

| Package | What it does |
| --- | --- |
| `@codemap/facts` | What the code says, read deterministically: imports, symbols, calls, routes, table reads and writes, fetch → route links. TS/JS via oxc, Python and Go via tree-sitter. Carried over from the hackathon harness with its tests. |
| `@codemap/core` | The map format (`parseMap`), the checker (`check`), map edits, and read-only repo access that never reads secrets. |
| `@codemap/server` | The Claude map maker and explainer (Agent SDK, read-only tools, secret guard), fixes, the local HTTP/WebSocket server, and the `codemap` CLI. |
| `@codemap/viewer` | The React Flow + ELK viewer: the map, walkthrough, answers, fixes and the input bar. |

## Development

```
npm test           # every package (no model calls; Claude is scripted in tests)
npm run typecheck
npm run build      # the viewer bundle the server serves
```

`packages/core/test/fixtures/care-app` is the reference app: staff convert a patient, the app announces it, nothing
listens, so the welcome email never goes out. `care-app.map.json` is the map of that question.
