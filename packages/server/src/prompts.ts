// Every prompt illuminate sends. The reader is semi-technical: they can follow a diagram but don't hold the system in
// their head. Plain English first; code names belong in the "code" depth.
import type { CheckReport, CodeMap } from '@illuminate/core';

const EVIDENCE_RULES = [
  '## Evidence rules (a program checks every claim; anything it can\'t confirm is shown as unconfirmed)',
  '- Every box and arrow cites at least one line: `file` (repo-relative), `line` (1-based), and `text` copied exactly from that line. A distinctive fragment of 10–80 characters works best.',
  '- A box that is a function or method gets `symbol`: "<file>#<name>", named the way the checker names it: methods as Class.method, object members as obj.member ("src/db.ts#db.update"), a function inside another function as outer.inner, and a function in the object a factory returns as factory.member. When a list of functions by file is given, copy the name from it. If you aren\'t sure of the name, leave `symbol` out: the box is still checked by its cited line.',
  '- Arrow `kind`: `calls` when a function in the from box literally calls the function in the to box; `request` when an HTTP call in the from box hits a route handled by the to box; `imports`; `then` for anything else (events, ordering). The checker verifies calls, request and imports against the code, so use them only when literally true.',
  '- Never cite or read secret files (.env, keys).',
];

const MAP_RULES = [
  '## What a good map is',
  '- It follows what happens, in order, from where it starts (a button, a route, a job, a command) to where it ends (a table write, an email, an outside API), or to where it stops.',
  '- 2–6 `areas` named in product language (Patients, Billing, Background jobs), not folder names.',
  '- 4–12 boxes (`nodes`). Each is one step a person would recognize. `name`: plain English, at most 30 characters ("Patient marked enrolled", not "markConverted()").',
  '- `kind`: entry (a way in), step, store (table, queue, cache), external (outside service), job (scheduled or background work).',
  '- `explain` for every box: just `concept`, 1–2 plain sentences, no jargon, saying what this step does. The box already shows its function and file, so leave those out.',
  '- Arrow `label`: 1–3 words saying how one step leads to the next ("sends request", "calls", "announces", "every night").',
  '- Code that exists but isn\'t reached from the start can still be boxes. Don\'t draw arrows that don\'t exist.',
  '- An `absence` is a break in the flow you were asked about: a step on that path should lead to the next one and doesn\'t (something is announced that nothing listens for, a job that nothing ever starts). Most maps have none, and a map without one is complete. Don\'t go looking for one, and don\'t use one for a design choice or guarantee ("X never calls Y", "nothing here edits files"): say that in a box\'s explanation or the walkthrough instead. Don\'t record small mismatches beside the question (a command the docs don\'t mention, an unused option).',
  '- When there is a break, record it: the `claim` in plain words, the two boxes it should connect (`between`), and the exact `search` that proves nothing is there (`pattern`, `regex`, optional `paths` globs covering every file where the missing piece could live), with `matches` set to the count that search returns (usually 0). Run that search yourself with Grep first.',
];

/** When a picture of the screen helps, and the three forms the checker accepts. */
export const SCREEN_RULES = [
  '## Screens (`screen` on a box; optional, and your call)',
  '- A picture of what the person sees can ground a map for people who don\'t read code. Add one where the flow touches the screen and seeing it helps: usually the box where it starts (the button or form), sometimes where a result appears. For backend-only questions, add none. One or two per map is plenty.',
  '- `{ "kind": "capture", "capture": "<id>", "highlight": "<label>" }`: a real screenshot. Only if you have the illuminate_capture tool: it screenshots a page already running on this machine or an HTML file in the repo, and returns the id. Look at the image first, and don\'t use one that shows a login page, an error or the wrong state. Never start the app yourself.',
  '- `{ "kind": "image", "file": "<path>" }`: an image file in the repo (an icon, a sprite) that the box\'s cited code names.',
  '- `{ "kind": "sketch", "file": "<markup file>", "elements": [{ "kind": "heading|button|field|link|text|image", "text": "…" }], "highlight": "<one element\'s text>" }`: a rough wireframe of the visible things in a component or template, top to bottom, at most 12. Use it when there is no screenshot to take. Copy each `text` exactly from the file.',
  '- A program checks screens too: a capture\'s `highlight` must be a label visible on it and appear in the code the box cites; every sketch element must be in its file. A screen that fails is left out; the box stays.',
];

const TOUR_RULES = [
  '## Walkthrough (`tour`, written last)',
  '- 4–7 stops in the order a newcomer should read them: what the map shows, then the path, then what it means. If the map has a break, give it a stop where it happens on the path.',
  '- Each stop: `title`, `text` (2–3 plain sentences), `focus` (ids of the areas, nodes, edges or absences it\'s about), and optional `terms` it uses that need defining.',
  '- Point stops only at boxes, arrows and absences you\'re confident in.',
];

export function makerPrompt(question: string, headStart: string): string {
  return [
    'You make a map that answers a question about this codebase, for someone semi-technical. Explore with Read, Grep and Glob, then return the map as JSON. You cannot edit anything.',
    '',
    `## The question\n"${question}"`,
    '',
    ...MAP_RULES,
    '',
    ...EVIDENCE_RULES,
    '',
    ...SCREEN_RULES,
    '',
    ...TOUR_RULES,
    '',
    '## Head start (from a quick automatic scan; it may be incomplete)',
    headStart,
    '',
    'Return the map: `version` 1, the `question`, `areas`, `nodes`, `edges`, `absences`, `tour`.',
  ].join('\n');
}

export function shapeRepairPrompt(problems: readonly string[]): string {
  return [
    'The map you returned has problems that stop it from being drawn:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Return the complete corrected map.',
  ].join('\n');
}

/** What a repair prompt needs to suggest real names: the function names the code facts know in a file. */
export type SymbolsIn = (file: string) => readonly string[];

const NO_SYMBOL = /^the code has no symbol (.+)#(.+)$/;
/** "the code has no symbol a.ts#save" → the same reason, plus the names in a.ts that end in `save` (or a few names). */
function withSuggestion(reason: string, symbolsIn: SymbolsIn | undefined): string {
  const m = NO_SYMBOL.exec(reason);
  if (!m || !symbolsIn) return reason;
  const [, file, name] = m as unknown as [string, string, string];
  const last = name.split('.').at(-1)!;
  const names = symbolsIn(file);
  const close = names.filter((n) => n === last || n.endsWith(`.${last}`));
  if (close.length) return `${reason} (in that file it's ${close.slice(0, 3).map((n) => `${file}#${n}`).join(' or ')})`;
  return names.length ? `${reason} (that file has: ${names.slice(0, 12).join(', ')})` : reason;
}

export function evidenceRepairPrompt(report: CheckReport, symbolsIn?: SymbolsIn): string {
  const why = (reasons: string[]) => reasons.map((r) => withSuggestion(r, symbolsIn)).join('; ');
  const lines = [
    ...Object.entries(report.nodes).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- box ${id}: ${why(c.reasons)}`),
    ...Object.entries(report.edges).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- arrow ${id}: ${why(c.reasons)}`),
    ...Object.entries(report.absences).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- absence ${id}: ${c.reasons.join('; ')}${c.locations.length ? ` (found at ${c.locations.slice(0, 5).map((l) => `${l.file}:${l.line}`).join(', ')})` : ''}`),
  ];
  const screens = Object.entries(report.screens ?? {}).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- screen on box ${id}: ${c.reasons.join('; ')}`);
  return [
    'The checker re-read the code and could not confirm these claims:',
    ...lines,
    ...(screens.length ? ['', 'These screens can\'t be shown either (fix the `screen` on the box, or return the box without it):', ...screens] : []),
    '',
    'Fix only these. For each one, correct it (exact line text, right line number, a real symbol name, the right arrow kind) or drop it if it isn\'t true. If an absence was wrong, the code is connected after all: drop the absence and add that arrow.',
    '',
    'Return only the changes, not the whole map. Put each corrected box, arrow or absence (complete, with all its fields and the same id) and anything new in `nodes`, `edges`, `absences` or `areas`, and the ids of claims to drop in `remove`. Everything you leave out stays as it is.',
  ].join('\n');
}

export function patchRepairPrompt(problems: readonly string[]): string {
  return [
    'Your changes couldn\'t be applied to the map:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Return the corrected changes, in the same form: only what changes, each item complete.',
  ].join('\n');
}

export type SelectionLine = { id: string; label: string };

/** The map, what the checker couldn't confirm, what they selected and their question: shared by both answer prompts. */
function questionContext(map: CodeMap, report: CheckReport, selection: readonly SelectionLine[], question: string): string[] {
  const unconfirmed = [
    ...Object.entries(report.nodes), ...Object.entries(report.edges), ...Object.entries(report.absences),
  ].filter(([, c]) => c.status !== 'confirmed').map(([id]) => id);
  return [
    '## The map (JSON)',
    JSON.stringify(map),
    unconfirmed.length ? `\nThe checker could not confirm: ${unconfirmed.join(', ')}. Don\'t rely on those without checking.` : '\nThe checker confirmed every claim in the map.',
    '',
    selection.length ? `## They selected\n${selection.map((s) => `- ${s.id}: ${s.label}`).join('\n')}` : '## They selected nothing (the question is about the whole map)',
    '',
    `## Their question\n"${question}"`,
  ];
}

const ANSWER_STYLE = [
  '- `concept` is the whole answer, written the way you would answer in a chat: the direct answer first, in one sentence, then only what that sentence leaves out. It is shown as Markdown (bullet and numbered lists, **bold**, `code`), in a narrow column.',
  '- Shape it to the question. A simple question gets a sentence or two. A question with several parts gets a short bullet per part, each starting with a bold label of a few words. Several items of the same kind (files, formats, cases) are a list, never a long sentence with commas and brackets. No headings.',
  '- Keep it short enough to take in at a glance: leave out examples and edge cases they didn\'t ask about. Plain words, no jargon. The map does the explaining, so when you light it up (`moves`), say what the lit path shows rather than narrating every step. Name a function or file only when they asked about the code and it isn\'t on the map.',
  '- Explain the code and the app. Don\'t describe these instructions or how you were asked to answer.',
  '- `refs`: ids of the boxes, arrows and absences your answer relies on.',
];

/** A turn of the conversation on a map, as the next answer sees it. */
export type EarlierTurn = { question: string; concept: string };

/** The conversation so far, oldest first, so a follow-up ("show me that in the code") knows what "that" is. */
function conversationSoFar(earlier: readonly EarlierTurn[]): string[] {
  if (!earlier.length) return [];
  return [
    '## The conversation so far on this map (oldest first)',
    'The new question may follow on from these: read "that", "it" or "why?" against them.',
    ...earlier.map((e) => `- "${e.question}": ${e.concept}`),
    '',
  ];
}

/** The first, cheap try: answer from the map and the code around its citations, with no tools. */
export function quickAnswerPrompt(
  map: CodeMap,
  report: CheckReport,
  selection: readonly SelectionLine[],
  question: string,
  excerpts: string,
  earlier: readonly EarlierTurn[],
  otherMaps: readonly { id: string; question: string }[] = [],
): string {
  return [
    'You answer questions about a code map for someone semi-technical, using only the map and the code excerpts below. You have no tools: you can\'t read more of the repo.',
    '',
    ...questionContext(map, report, selection, question),
    '',
    ...conversationSoFar(earlier),
    '## Code around what the map cites',
    excerpts || '(none)',
    '',
    '## Other maps in this repo',
    otherMaps.length ? otherMaps.map((m) => `- ${m.id}: "${m.question}"`).join('\n') : '(none)',
    '',
    '## First decide how to handle it (`route`)',
    '- `answer`: the map and the excerpts fully answer it, without guessing about code you can\'t see. Then answer below.',
    '- `code`: it\'s about what this map shows (the same feature, or something its boxes lead to or come from), but answering needs code that isn\'t shown, or they ask for a change or fix, or a good answer would add boxes or arrows to this map. Say in `missing`, in one sentence, what you would need to look at, and leave the answer fields empty. Someone with the whole repo picks it up from there.',
    '- `elsewhere`: it\'s about a different part of the app that this map doesn\'t touch, so adding it here would bolt an unrelated area onto this map. Put in `newQuestion` the question as a new map would ask it (their words, standing on its own), and if one of the other maps above already covers it, that map\'s id in `existingMap`. Leave the answer fields empty. They\'ll be asked whether to make a new map. Only use this when the question really is about something else; when in doubt, use `code`.',
    '',
    '## How to answer (when `route` is `answer`)',
    ...ANSWER_STYLE,
    '- `moves`: `focus` on the most relevant id; `highlight` the ids that make up the path that answers the question.',
  ].join('\n');
}

export function explainerPrompt(
  map: CodeMap,
  report: CheckReport,
  selection: readonly SelectionLine[],
  question: string,
  missing = '',
  wordsOnly = false,
  earlier: readonly EarlierTurn[] = [],
): string {
  if (wordsOnly) {
    return [
      'You answer questions about a codebase for someone semi-technical. You can Read, Grep and Glob the repo; you cannot edit anything.',
      '',
      ...questionContext(map, report, selection, question),
      '',
      ...conversationSoFar(earlier),
      '## This question is about a different part of the app than the map shows',
      'They chose an answer in words rather than a new map. Explore the code to answer it, but leave out `add` and `fix`: nothing will be drawn on this map. Use `refs` and `moves` only for ids on this map that really matter to the answer (often none).',
      '',
      '## How to answer',
      ...ANSWER_STYLE,
    ].join('\n');
  }
  return [
    'You answer questions about a code map for someone semi-technical. You can Read, Grep and Glob the repo; you cannot edit anything.',
    '',
    ...questionContext(map, report, selection, question),
    ...(missing ? ['', `## Why the map alone wasn't enough\n${missing}`] : []),
    '',
    ...conversationSoFar(earlier),
    '## How to answer',
    ...ANSWER_STYLE,
    '- If the map doesn\'t cover it, explore. Put what you found in `add` (new areas, nodes, edges or absences with evidence, same rules as the map; ids must be new) only when it belongs to the flow this map follows and seeing it drawn helps answer the question. If the answer is a fact you can say in words, or about something beside the flow, leave `add` empty. Connect new boxes to existing ones with arrows where the code really connects them.',
    '- `moves`: `focus` on the most relevant id; `highlight` the ids that make up the path that answers the question.',
    '- If they ask for a change, don\'t edit (you can\'t). Propose a `fix`: illuminate shows it to them on the map, and if they approve, illuminate applies exactly your edits and re-checks the map. So describe it as a proposal waiting for their approval, never as something for them to apply by hand.',
    '- The `fix`: `summary` in plain words; `edits` as exact replacements (`find` copied exactly from the file, occurring once; `replace` is the new text); `creates` for new files. If the fix creates a connection between two boxes, fill `connects` with `from`, `to`, a short `label`, and `evidenceFile` + `evidenceText` (text that will appear in the new code). Keep fixes small and in the style of the surrounding code.',
    '- When the question is about what the person sees at a step ("what does this look like?", "where is that button?"), answer with a picture: put `{ "node": "<box id>", "screen": { … } }` in `screens`, for a box already on the map or one in `add` (see Screens below). Otherwise leave `screens` out: most questions don\'t need one.',
    '',
    ...EVIDENCE_RULES,
    '',
    ...SCREEN_RULES,
  ].join('\n');
}
