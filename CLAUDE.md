# codemap

A map you can point at and ask about, for code you didn't write yourself. Read `README.md` first. The design lives in
the "Codemap v1 Design" artifact (link in the README); follow its build order.

## Rules

- **The model writes, the code decides.** Nothing reaches the screen without passing `check()` in `@codemap/core`. A
  model never sets a claim's status; the checker computes it from the repo every time.
- **One checker, every call site.** Publishing a map, every answer, reopening a saved map, and after a fix all call the
  same `check()`. Don't fork its logic.
- **"Nothing does X" is a claim too.** Absences carry the search that proves them, and the checker reruns it.
- **The map format is the one-way door.** Change `packages/core/src/format.ts` deliberately, with tests. Everything
  else (generator, viewer, explainer) is replaceable behind it.
- **Read-only unless approved.** Codemap writes to a target repo only under `.codemap/`, and edits product code only
  after the user approves a fix previewed on the map. Claude never edits: it proposes, and `applyFix` writes exactly
  the approved change, refusing if the files changed since. Only one agent edits at a time.
- **All model calls go through one `Agent`** (`packages/server/src/agent.ts`): read-only tools, the secret guard,
  structured output. Tests inject a scripted `Agent`; `npm test` never calls a model.
- **Never read secrets.** `.env*`, keys and similar files are refused by `createRepoReader` and left out of searches.
  Paths in maps must stay inside the repo.
- **No model calls in `@codemap/facts` or the checker.** They must be deterministic and fast.
- **Plain English in anything a person reads.** Jargon belongs in the code tab and in engineering detail.
- TypeScript strict, with `noUncheckedIndexedAccess`. Vitest. Pin dependency versions exactly.
- **Don't guess Agent SDK or Claude Code APIs** (channels, MCP Apps, hooks). Check the docs first.

## Commands

```
npm i
npm test             # every package, no model calls
npm run typecheck
npm run build        # viewer bundle (the server serves packages/viewer/dist)
npm run preview      # whole app with a scripted Claude, on a copy of the care-app fixture
npm run codemap -- "<question>" --repo <dir>   # the real thing (uses Claude)
```

## Context

- Packages: `facts` (deterministic code facts) → `core` (format, checker, map edits, safe repo reads) → `server`
  (maker, explainer, fixes, HTTP/WebSocket server, CLI) → `viewer` (React Flow + ELK). The viewer imports server and
  core types only (`import type`), never their runtime code.
- The agent skill is `integrations/skills/codemap/SKILL.md`.
- `@codemap/facts` was carried over from the hackathon harness (`../Speedhacks-project/packages/core`) with its tests.
  The harness is a separate project; don't import from it or edit it from here.
- Test fixtures: `packages/facts/test/{alias-repo,fixture-py,fixture-go}` and `packages/core/test/fixtures/care-app`
  (planted missing listener). Its `.env` holds a fake key for the secret-refusal tests.
