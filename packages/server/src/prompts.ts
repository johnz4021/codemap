// Every prompt codemap sends. The reader is semi-technical: they can follow a diagram but don't hold the system in
// their head. Plain English first; code names belong in the "code" depth.
import type { CheckReport, CodeMap } from '@codemap/core';

const EVIDENCE_RULES = [
  '## Evidence rules (a program checks every claim; anything it can\'t confirm is shown as unconfirmed)',
  '- Every box and arrow cites at least one line: `file` (repo-relative), `line` (1-based), and `text` copied exactly from that line. A distinctive fragment of 10–80 characters works best.',
  '- A box that is a function or method gets `symbol`: "<file>#<name>" (methods as Class.method, object members as obj.member, e.g. "src/db.ts#db.update").',
  '- Arrow `kind`: `calls` when a function in the from box literally calls the function in the to box; `request` when an HTTP call in the from box hits a route handled by the to box; `imports`; `then` for anything else (events, ordering). The checker verifies calls, request and imports against the code, so use them only when literally true.',
  '- Never cite or read secret files (.env, keys).',
];

const MAP_RULES = [
  '## What a good map is',
  '- It follows what happens, in order, from where it starts (a button, a route, a job, a command) to where it ends (a table write, an email, an outside API), or to where it stops.',
  '- 2–6 `areas` named in product language (Patients, Billing, Background jobs), not folder names.',
  '- 4–12 boxes (`nodes`). Each is one step a person would recognize. `name`: plain English, at most 30 characters ("Patient marked enrolled", not "markConverted()").',
  '- `kind`: entry (a way in), step, store (table, queue, cache), external (outside service), job (scheduled or background work).',
  '- `explain` for every box: `concept` (1–2 plain sentences, no jargon), `how` (the mechanism; define any term you use), `code` (function and file names).',
  '- Arrow `label`: 1–3 words saying how one step leads to the next ("sends request", "calls", "announces", "every night").',
  '- When the trail stops, or something that should be connected isn\'t, record an `absence`: the `claim` in plain words, the two boxes it should connect (`between`), and the exact `search` that proves nothing is there (`pattern`, `regex`, optional `paths` globs), with `matches` set to the count that search returns (usually 0). Run that search yourself with Grep first.',
  '- Code that exists but isn\'t reached from the start can still be boxes. Don\'t draw arrows that don\'t exist; use an absence.',
];

const TOUR_RULES = [
  '## Walkthrough (`tour`, written last)',
  '- 4–7 stops in the order a newcomer should read them: what the map shows → the path → the problem, if there is one → what it means.',
  '- Each stop: `title`, `text` (2–3 plain sentences), `focus` (ids of the areas, nodes, edges or absences it\'s about), optional `terms` it uses that need defining, and `ask` with 1–2 good next questions.',
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

export function evidenceRepairPrompt(report: CheckReport): string {
  const lines = [
    ...Object.entries(report.nodes).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- box ${id}: ${c.reasons.join('; ')}`),
    ...Object.entries(report.edges).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- arrow ${id}: ${c.reasons.join('; ')}`),
    ...Object.entries(report.absences).filter(([, c]) => c.status !== 'confirmed').map(([id, c]) => `- absence ${id}: ${c.reasons.join('; ')}${c.locations.length ? ` (found at ${c.locations.slice(0, 5).map((l) => `${l.file}:${l.line}`).join(', ')})` : ''}`),
  ];
  return [
    'The checker re-read the code and could not confirm these claims:',
    ...lines,
    '',
    'For each one: fix the citation (exact line text, right line number, real symbol name, right arrow kind), or remove the claim if it isn\'t true. If an absence was wrong, the code is connected after all: draw that connection instead. Keep everything that was confirmed. Return the complete corrected map.',
  ].join('\n');
}

export type SelectionLine = { id: string; label: string };

export function explainerPrompt(map: CodeMap, report: CheckReport, selection: readonly SelectionLine[], question: string): string {
  const unconfirmed = [
    ...Object.entries(report.nodes), ...Object.entries(report.edges), ...Object.entries(report.absences),
  ].filter(([, c]) => c.status !== 'confirmed').map(([id]) => id);
  return [
    'You answer questions about a code map for someone semi-technical. You can Read, Grep and Glob the repo; you cannot edit anything.',
    '',
    '## The map (JSON)',
    JSON.stringify(map),
    unconfirmed.length ? `\nThe checker could not confirm: ${unconfirmed.join(', ')}. Don\'t rely on those without checking.` : '\nThe checker confirmed every claim in the map.',
    '',
    selection.length ? `## They selected\n${selection.map((s) => `- ${s.id}: ${s.label}`).join('\n')}` : '## They selected nothing (the question is about the whole map)',
    '',
    `## Their question\n"${question}"`,
    '',
    '## How to answer',
    '- `concept`: 2–4 plain sentences, no jargon. `how`: the mechanism; define any term you use. `code`: function names, files and lines.',
    '- `refs`: ids of the boxes, arrows and absences your answer relies on.',
    '- If the map doesn\'t cover it, explore, then put what you found in `add` (new areas, nodes, edges or absences with evidence, same rules as the map; ids must be new). Connect new boxes to existing ones with arrows where the code really connects them.',
    '- `moves`: `focus` on the most relevant id; `highlight` the ids that make up the path that answers the question.',
    '- If they ask for a change, don\'t edit (you can\'t). Propose a `fix`: codemap shows it to them on the map, and if they approve, codemap applies exactly your edits and re-checks the map. So describe it as a proposal waiting for their approval, never as something for them to apply by hand.',
    '- The `fix`: `summary` in plain words; `edits` as exact replacements (`find` copied exactly from the file, occurring once; `replace` is the new text); `creates` for new files. If the fix creates a connection between two boxes, fill `connects` with `from`, `to`, a short `label`, and `evidenceFile` + `evidenceText` (text that will appear in the new code). Keep fixes small and in the style of the surrounding code.',
    '- `followUps`: up to 3 short next questions.',
    '',
    ...EVIDENCE_RULES,
  ].join('\n');
}
