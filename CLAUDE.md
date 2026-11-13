# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## illuminate

A map you can point at and ask about, for code you didn't write yourself. Read `README.md`, then `HANDOFF.md` (who it's
for, what users asked for, the decisions and why, what's next, gotchas). The design lives in the "Codemap v1 Design"
artifact (link in both).

## Rules

- **The model writes, the code decides.** Nothing reaches the screen without passing `check()` in `@illuminate/core`. A
  model never sets a claim's status; the checker computes it from the repo every time.
- **One checker, every call site.** Publishing a map, every answer, reopening a saved map, and after a fix all call the
  same `check()`. Don't fork its logic.
- **"Nothing does X" is a claim too.** Absences carry the search that proves them, and the checker reruns it.
- **The map format is the one-way door.** Change `packages/core/src/format.ts` deliberately, with tests. Everything
  else (generator, viewer, explainer) is replaceable behind it.
- **Read-only unless approved.** Illuminate writes to a target repo only under `.illuminate/`, and edits product code only
  after the user approves a fix previewed on the map. Claude never edits: it proposes, and `applyFix` writes exactly
  the approved change, refusing if the files changed since. Only one agent edits at a time.
- **All model calls go through one `Agent`** (`packages/server/src/agent.ts`): read-only tools, the secret guard,
  structured output. Tests inject a scripted `Agent`; `npm test` never calls a model.
- **Never read secrets.** `.env*`, keys and similar files are refused by `createRepoReader` and left out of searches.
  Paths in maps must stay inside the repo.
- **No model calls in `@illuminate/facts` or the checker.** They must be deterministic and fast.
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
npm run illume -- "<question>" --repo <dir>   # the real thing (uses Claude)
npm run illume -- check <map-id> --repo <dir> # re-check a saved map (exit 1 if a claim fails)

npm test -w @illuminate/core -- test/check.test.ts      # one file
npm test -w @illuminate/server -- -t "<test name>"      # one test by name
npm run dev -w @illuminate/viewer   # Vite on :5317, proxies /api and /ws to a server on ILLUMINATE_SERVER_PORT (4317)
```

- No build step for the TS packages: every `package.json` points `main` at `src/index.ts`, and `bin/illuminate.mjs`
  runs the CLI through tsx. Only the viewer is built, so rebuild it after viewer changes before `npm run illume`
  (`preview` rebuilds for you).
- Vitest only picks up `test/*.test.ts` (not nested). Fixture directories are excluded from each `tsconfig`.

## Context

- Packages: `facts` (deterministic code facts) → `core` (format, checker, map edits, safe repo reads) → `server`
  (maker, explainer, fixes, HTTP/WebSocket server, CLI) → `viewer` (React Flow + ELK). The viewer imports server and
  core types only (`import type`), never their runtime code.
- The agent skill is `plugin/skills/illuminate/SKILL.md`. The Claude Code plugin is `plugin/` (its MCP server runs
  `npx -y @johnz4021/illuminate@<version> channel`), listed by `.claude-plugin/marketplace.json` at the repo root.
- Publishing: `npm run release` builds `release/` (server, core and facts bundled by esbuild into one file, plus the
  built viewer; third-party packages stay pinned dependencies). Bump the version in `release/package.json`,
  `plugin/.claude-plugin/plugin.json` and the `npx` args together, then `cd release && npm publish --access public`.
- `@illuminate/facts` was carried over from the hackathon harness (`../Speedhacks-project/packages/core`) with its tests.
  The harness is a separate project; don't import from it or edit it from here.
- Test fixtures: `packages/facts/test/{alias-repo,fixture-py,fixture-go}` and `packages/core/test/fixtures/care-app`
  (planted missing listener). Its `.env` holds a fake key for the secret-refusal tests.

## How the pieces fit

- **Make** (`server/src/maker.ts`): `headStart` (a `@illuminate/facts` scan, `hints.ts`) seeds the prompt, including every
  function name by file exactly as the checker knows it (`symbolIndex`) → `Agent` returns JSON against `MAP_SCHEMA` →
  `parseMap` → `check`. Unconfirmed claims get up to two repair rounds on the same session that return only changes
  (`MAP_PATCH_SCHEMA`, applied with `patchMap` in `core/src/edit.ts`), since writing the map is most of a map's time;
  a draft that can't be read at all is re-sent whole. The best-checked map wins. Prompts live in `prompts.ts`, output
  schemas in `schemas.ts`.
- **Symbol names** (`facts/src/facts/extract.ts`): functions inside functions are `outer.inner`, methods of an object a
  factory returns are `factory.member`; calls made in them belong to them (the checker's `within` treats `outer.inner`
  as part of `outer`, so maps citing the outer function still check).
- **Ask** (`explainer.ts`): first Claude sees the map, the code around its citations (`citedExcerpts`, plain code) and
  the repo's other maps, with no tools, and picks a `route`: `answer` (done, map unchanged), `code` (Claude explores the
  repo, resuming the explainer session; only this can add to the map, via `addToMap` in `core/src/edit.ts`, or propose
  a fix), or `elsewhere` (a different part of the app: the answer is an `offer`, and the person chooses a new map,
  linked back through `meta.parent`, or an answer in words, `wordsOnly`, that draws nothing). A selection on the map
  always means `code`, never `elsewhere`. Additions that don't pass `check` are dropped, not shown as unconfirmed.
- **Viewer layout**: the top bar only says which map this is (switcher, New map, Stop) and, in words, whether it still
  matches the code ("✓ Matches the code", or "6 parts of this map don't match the code"). The dock along
  the bottom (`dock.tsx`) starts the walkthrough, and holds the question box while the conversation is closed; zoom is
  the wheel or trackpad. The walkthrough runs in a bubble on the map (`tour.tsx`), its text and buttons together; the
  panel steps aside meanwhile (unless it has an error or Claude's progress) and the camera leaves room for the bubble.
- **Conversation** (`panel.tsx`): the panel is the conversation on a map. Each turn is the question, then the reply
  (short Markdown shaped to the question, direct answer first: the map does the explaining, and boxes carry their code), then what came with it: a
  fix, the offer of a new map, or what it added (hideable). The reply lit on the map is drawn dark; "Show on the map"
  relights an earlier one. While it's open the question box sits at its bottom (one box, never two). It opens for an
  answer, a selection, Claude's progress or an error; closed, a corner button reopens it (`history.tsx`). Drag its
  left edge to resize it (`resize.tsx`, kept in localStorage); when the map area changes width, the camera keeps its
  middle in the middle. Claude gets the last six turns (`conversationSoFar` in `prompts.ts`) in both answer steps.
  Whatever Claude writes as prose (replies, box explanations, walkthrough stops, fix summaries) is shown as Markdown
  through `markdown.tsx`: a small subset, built as React elements, never HTML strings; links open only for http(s).
  Step boxes are `NODE_W`×`NODE_H` in `layout.ts`, which must match `.step` in `styles.css`.
- **Viewer navigation** (`viewer/src/nav.ts`): moving between maps and home is in-page (`history.pushState`), and
  in-app `<a href>` clicks are taken over, so the page never reloads.
- **Layers** (viewer): what each answer added (`answer.added`) can be hidden. The layout puts the original map down
  first and fits additions around it (rows below in existing areas, new areas to the right), so known boxes never move.
- **Channel** (`channel.ts`, `bridge.ts`; `illume channel`): illuminate as a Claude Code channel, an MCP server over
  stdio that runs the local server with a bridge `Agent`, so the user's own Claude Code session does the model work. A
  request goes to a tool call that is waiting (`illuminate_map` and `illuminate_submit` wait for what comes next, so a
  map is made in one turn). Between turns Claude keeps an `illuminate_listen` call open: Claude Code moves a call
  running past two minutes to the background and wakes the session when it returns, so questions asked on the map
  reach the session without the channel flag. Claude Code drops a call quiet for 30 minutes even while it sends
  progress, so a listening call returns after 25 minutes and Claude starts another; five quiet ones in a row (about two
  hours) and Claude is told to stop until the person asks.
  Only when nothing is listening is a request pushed as a channel message and fetched with `illuminate_next`. Output is
  validated with the zod schema behind each output schema (`validatorFor` in `schemas.ts`) and problems go back to
  Claude. The session's own tools are used, so read-only and the secret guard are instructions there, not enforced.
  A session started without `--dangerously-load-development-channels` drops that push without telling anyone, so a
  request nobody picks up says so on the map after 30 s and fails after 5 min (`NOT_PICKED_UP`, `NEVER_PICKED_UP`).
- **Screens** (`core/src/screens.ts`, `server/src/screens.ts`, `viewer/src/screen.tsx`): a box may carry an optional
  `screen`, and the model decides when one helps (`SCREEN_RULES` in `prompts.ts`). Three kinds: `capture` (a screenshot
  illuminate took itself with the installed Chrome, headless, clean profile, only of localhost pages or HTML files in
  the repo; saved with a record under `.illuminate/screens/`), `image` (a repo image the cited code names) and `sketch`
  (a wireframe whose every element's text is in its markup file). `check()` reports them under `report.screens`, not as
  claims: a screen that fails is not shown, and the box stays. The channel offers `illuminate_screens` (what the repo
  can show) and `illuminate_capture` (returns the image for Claude to look at). illuminate never starts the app. The
  CLI's Agent SDK session has no capture tool yet, so there it can only use `image` and `sketch`.
- **Fix** (`fixes.ts`): `proposeFix` records file hashes → `applyFix` writes only if they still match →
  `connectAfterFix` draws the new edge and closes the gaps it fills → `undoFix`.
- **Serve** (`server.ts`, `store.ts`): maps persist as `<repo>/.illuminate/maps/<id>.json`, with their answers and where
  each fix stands. Jobs and Undo data (the files before a fix) are in memory only. Binds 127.0.0.1, requires a token,
  checks Host and Origin; the viewer gets job progress over the WebSocket. Open WebSockets also count as open tabs: with `autoStop` (the CLI and the channel set it; the channel
  after 5 s) the server stops itself once none are open and no job is running, and `POST /api/stop` is the page's Stop
  button. Tabs learn it stopped from WebSocket close code 4000 (`STOPPED_CLOSE_CODE`), so every page must keep one
  open; they then try `window.close()` (browsers allow it only for a tab with one page of history) and otherwise say
  illuminate stopped. In the channel, a stopped page server ends any listening call (Claude is told not to listen
  again until asked), and the MCP server stays connected so the next illuminate call starts a new page server.
- Server tests use `scriptedAgent` and `copyCareApp` from `packages/server/test/helpers.ts`; follow that pattern
  rather than mocking the SDK.
