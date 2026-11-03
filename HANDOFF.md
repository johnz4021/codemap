# Handoff: where codemap came from, what's decided, what's next

Context for anyone (person or agent) picking codemap up. The code and `README.md` say *what* exists; this says *why*,
what was learned along the way, and what's still open. As of 2026-11-02.

## 1. The problem

When you build mostly by directing AI agents, you lose your model of the system. Fixes become band-aids: each change is
judged locally ("did the error go away?") rather than against how the system is meant to work, and nobody notices the
same spot being patched five times. Call it **comprehension debt**: code that exists but that no person understands.

The founding example is real. On an EHR workflow builder (care journeys, journey templates, automations such as "send
this email after the patient converts"), the concepts kept getting rewired, and the frontend looked finished. It was
impossible to tell how the backend was wired, or whether it was wired at all. *"I just trusted what I saw on the
frontend."*

## 2. Who it's for

- **Main user: semi-technical builders who ship with agents.** They know enough to act on what a map shows ("nothing
  listens for this event" is obviously a bug), but can't hold the whole system in their head. This group is growing
  fastest.
- **Not fully non-technical people.** They want "make it work and don't make me think about the backend", which works
  against the product. They're also mostly inside Lovable, Replit or Bolt, which own the screen.
- **Not senior engineers, mostly.** They already hold the model. The exception is an unfamiliar codebase.
- **Buyer later: teams and eng leads** worried about agent-written code nobody understands.
- **Framing:** it's not "leveling the playing field". It's "stay in control of what your agent builds, and get better
  at it as you go."

## 3. What people said (Oct 2026 interviews)

- **Jay** struggles with UX iteration; that's a different product, so leave it out. Separately, he worries whether V1 will
  hold up for V2 and V3, and has no visibility into the backend his technical cofounder owns. That suggests **the map as
  a shared language between a non-technical founder (who views and asks) and a technical cofounder (who acts).**
  Promise "you'll see where V2 will hurt", not "you'll know it scales".
- **The integration interviewee is the clearest signal.** He had to change a client's data integration, asked GPT how
  the workflow worked, and got a wall of text instead of a diagram. *Consultants working in client codebases* may be a
  sharp segment: they hit this on every new client.
- **The third person** plans heavily and says AI implements well "but…". The note cut off. **Follow up**: this is either
  the toughest customer or evidence that the pain is smaller for disciplined planners.
- **The bar to clear is "ask Claude for a Mermaid diagram".** That's free and solves maybe 60% of "wall of text". Codemap
  has to win on things people notice: claims checked against the code, click-through to the code, the same drawing every
  time, and **showing what's missing**.

## 4. What the user wants from the interface (direct feedback)

- **Point at anything and ask.** Select a box, an arrow or a region; answers appear next to what was selected.
- **Plain English first.** Translating code into concepts *is* the value. Three depths: Concept, How it works, Code.
  Define jargon. Use a small concrete example from their own code.
- **A real graph:** areas as containers, steps inside, labeled arrows between them. An early design with lane rows of
  blocks was rejected as "unintuitive, not an actual graph".
- **A walkthrough written with each map,** because a graph alone is hard to start reading. Stops go in the order that
  makes sense to a newcomer, and you can ask at every stop.
- **No "guess what happens next" prompts.** That idea was rejected.
- **The agent can fix things from the map**, not just explain them (see decision 5).
- **Model-agnostic is wanted.** The simplest version: codemap runs its own Claude explainer, and any coding agent
  launches it.
- **Learning from walkthroughs:** a diagram of the user's own vibecoded architecture lost them. Every diagram needs its
  question and a line of context on top, 5 to 7 boxes at first with details on click, and plain labels.

## 5. Design decisions and why

1. **v1: Claude explores, a plain program checks.** No deterministic graph engine yet, because it isn't needed for
   "ask, get a map". Claude explores with Read/Grep/Glob and returns the map in a fixed format. `check()` re-reads every
   cited line and verifies calls, requests and imports against code facts. Later, the engine can replace the explorer
   behind the same format.
2. **The map format (`packages/core/src/format.ts`) is the one-way door.** Everything else is replaceable. Statuses are
   never stored; they're computed on every check.
3. **"Nothing does X" is a claim with proof.** Absences carry the search that proves them, and the checker reruns it.
   The missing connection is the bug people care about, and only a graph that can show absences can show it.
4. **Codemap runs its own Claude explainer,** separate from the user's coding chat. It works with any agent and keeps
   explanation quality consistent. It can read the whole repo: the map is a starting point, not a fence. Anything it
   adds is drawn only if the checker confirms it.
5. **Fixes:** Claude proposes. The fix is drawn as a green dashed arrow next to the exact diff. Nothing changes until
   approval. Then codemap writes exactly that diff, refusing if the files changed since the proposal, re-checks the map,
   and offers Undo. Only one agent edits at a time. If codemap is ever connected to the user's coding chat, that agent
   makes the edit instead.
6. **Delivery:** the basic version works everywhere through a skill, the `codemap` CLI and a browser tab. Optional
   upgrades (not built):
   - **Channels:** Claude Code only, research preview. An MCP server pushes the user's question into the running chat.
   - **MCP Apps:** Cursor, VS Code Copilot, ChatGPT, Claude Desktop. The viewer embeds in the chat, and `ui/message` sends
     questions.
   - **Codex:** no documented way to push into a running session. Its desktop app has a Browser with an Annotate picker
     and WebMCP, which might allow something similar; untested.
7. **Local only:** binds to 127.0.0.1, a token is required, Host and Origin are checked, and secrets are never read.

## 6. Graphify, for comparison (github.com/Graphify-Labs/graphify, read at v0.9.97)

- **Agent-facing.** Code goes to a graph through tree-sitter (no LLM). Query is keyword match, then BFS spreading in every
  direction. Clusters (Leiden) are named after their busiest node. Updates happen after commits, asynchronously, in
  seconds. There are no ordered flows, no fetch → route links, and no events or queues for JS. Its "benchmark" measures
  tokens, not task success. Graphify Cloud (YC S26) adds architecture rules.
- **Ideas worth borrowing:**
  - An edge counts as EXTRACTED only with import evidence; ambiguous matches are dropped rather than guessed.
  - Edges belong to the file they come from, so a change evicts only that file's edges.
  - Keep cluster IDs stable between rebuilds.
  - Stamp the graph with `built_at_commit`.
  - Hook messages phrased as facts, not commands. They found imperative wording gets ignored as prompt injection.
- **Don't build on it.** Codemap's edge is everything it lacks.

## 7. What's built (verified)

- **Tests:** four packages, 102 tests, no model calls.
- **Viewer:** tested in Chrome with scripted Claude (`npm run preview`): making a map, the walkthrough, select and ask,
  a follow-up that adds checked steps, a fix (approve, reload, undo).
- **Real Claude, on the care-app fixture:**
  - The map came back 20 of 20 confirmed on the first pass, for about $0.21.
  - It also found a bug nobody planted: nothing ever starts the nightly job.
  - A real question cost about $0.14 and added two confirmed gaps.
  - A real fix cost about $0.24, was approved and applied, and re-checked 22 of 22.
- **Demo frontend:** `examples/care-app-ui/index.html`, the patient app as staff see it. Convert a patient and no welcome
  email arrives, even though the automation is active.

## 8. Not built yet, and next steps

- **Questions, answers and fix proposals live in server memory** and are lost on restart; maps are saved to disk.
- **Hand-off to the user's coding agent** (channels / MCP Apps) and an MCP `publish_map` tool for agents that explore on
  their own.
- **Big repos are untested.** The head-start scan reads the whole repo.
- **Next, in order:**
  1. **Run Phase 0 with the integration interviewee:** his real question, codemap vs "Claude + Mermaid" side by side.
  2. Try codemap on a real repo, or a fresh Scout copy (`../scout-run`; never `../scout-agent`).
  3. Persist sessions.
  4. Channels hand-off in Claude Code.
  5. MCP Apps.
- **Later (Phase 3 of the plan):**
  - A fast graph engine with updates on every edit (incremental, LSP-style).
  - Live agent activity on the map.
  - "Working somewhere you haven't explored" and a per-user explored-regions map.
  - "This step was patched 5 times this week" counters. That's the *band-aid detector*, and it needs a time dimension.

## 9. Gotchas that cost time

- **Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.296), verified from its types:**
  - The call is `query({ prompt, options: { cwd, model, tools, allowedTools, permissionMode: 'dontAsk', settingSources: [], strictMcpConfig, outputFormat: { type: 'json_schema', schema }, resume, hooks } })`.
  - The answer arrives as `structured_output` on the `result` message.
  - PreToolUse hooks can return `permissionDecision` and `updatedInput`.
  - Auth is an API key or the Claude Code login.
- **React Flow 12:**
  - With controlled nodes, measurements live on `getInternalNode(id).measured`, not on your node objects.
  - Nodes that aren't selectable or draggable get `pointer-events: none` unless `onNodeClick` is set. Steps carry
    `nopan` so a pan doesn't swallow clicks.
- **ELK:** spacing options apply per container, so each area repeats them.
- **Chrome automation:**
  - A hidden tab renders no React Flow edges and drops input; check `document.visibilityState` and drive the page with
    in-page events.
  - The first click after a navigation is often dropped.
- **zsh `echo` mangles backslashes in JSON.** Write curl output to a file instead.
- **Channels with a custom server:**
  - Launch with `claude --dangerously-load-development-channels server:<name>`.
  - Claude Code won't register a channel server on MCP protocol 2026-07-28; `MCP_SDK_GENERATION=v1` works around it.
  - The page needs its own sender check (a token): an ungated channel is a prompt-injection risk.

## 10. Links

- Design spec, current: [Codemap v1 Design](https://claude.ai/artifact/55L8tokprGe61qtfpDXJ5h)
- Longer-term plan with the engine: [Point-and-Ask Architecture](https://claude.ai/artifact/7hWiwFyugpB6hT6x3DKoJs)
- Graphify vs. ours: [Two Code Graphs Compared](https://claude.ai/artifact/8u9v9BAXW4pTLkz72exhv5)
- Early concept frames (Figma): https://www.figma.com/design/i8aTiDS47Eb68QeoKvQopW
- Hackathon origin, reference only: `../Speedhacks-project` (the Interpretability harness)
- Claude Code channels: https://code.claude.com/docs/en/channels · MCP Apps client matrix:
  https://modelcontextprotocol.io/extensions/client-matrix
