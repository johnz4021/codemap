// Preview the whole app without calling Claude: the real server and viewer, on a throwaway copy of the care-app
// fixture, with a scripted stand-in for Claude (it streams progress, returns the fixture map, answers, proposes a fix).
// For UI work and demos:  npm run preview   (then open the printed link)
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentRequest } from '../src/agent';
import { MAP_SCHEMA, QUICK_ANSWER_SCHEMA } from '../src/schemas';
import { startServer } from '../src/server';

const fixture = (p: string) => fileURLToPath(new URL(`../../core/test/fixtures/${p}`, import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'illuminate-preview-'));
cpSync(fixture('care-app'), root, { recursive: true });
const MAP = JSON.parse(readFileSync(fixture('care-app.map.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function narrate(req: AgentRequest, steps: [string, string][]) {
  for (const [kind, text] of steps) {
    await sleep(450);
    req.onProgress?.({ kind: kind as 'read' | 'search' | 'list', text });
  }
}

const agent: Agent = async (req) => {
  if (req.schema === MAP_SCHEMA) {
    await narrate(req, [
      ['read', 'Reading src/ui/PatientHeader.tsx'],
      ['read', 'Reading src/server/routes.ts'],
      ['read', 'Reading src/patients/service.ts'],
      ['search', 'Searching for "patient\\.converted"'],
      ['read', 'Reading src/automations/evaluate.ts'],
      ['read', 'Reading src/jobs/nightly.ts'],
    ]);
    return { output: MAP, sessionId: 'preview-maker', cost: 0 };
  }
  // Only the question itself (the line after "## Their question"), not the instructions around it.
  const q = req.prompt.slice(req.prompt.indexOf('## Their question')).split('\n')[1] ?? '';
  // The map-only first try: questions about where things run or changes need the code; anything else is on the map.
  if (req.schema === QUICK_ANSWER_SCHEMA) {
    await sleep(600);
    // Billing isn't part of this map (or this app): the "different part of the app" card.
    if (/invoice|bill/i.test(q)) return { output: { route: 'elsewhere', newQuestion: 'How does the app bill patients and send invoices?' }, sessionId: null, cost: 0 };
    if (/make|change|fix|right away|immediately|where|when|run/i.test(q)) return { output: { route: 'code', missing: 'Code the map doesn\'t show.' }, sessionId: null, cost: 0 };
  }
  if (/make|change|fix|right away|immediately/i.test(q)) {
    await narrate(req, [['read', 'Reading src/events/bus.ts'], ['search', 'Searching for "bus\\.on\\("']]);
    return {
      output: {
        concept: 'The email goes out right away if something listens for the "patient converted" announcement and runs the rules. Adding a small listener does that; the nightly job stays as a backup.',
        refs: ['s4', 'miss', 'u1'],
        moves: { focus: 's4', highlight: ['s4', 'u1', 'miss'] },
        fix: {
          summary: 'Run the automation rules as soon as a patient converts, by listening for the announcement. The nightly job stays as a backup.',
          edits: [],
          creates: [{ file: 'src/automations/listeners.ts', content: "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nbus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n" }],
          connects: { from: 's4', to: 'u1', label: 'now listens', evidenceFile: 'src/automations/listeners.ts', evidenceText: "bus.on('patient.converted'" },
        },
      },
      sessionId: 'preview-explainer',
      cost: 0,
    };
  }
  if (/where|when|run/i.test(q)) {
    await narrate(req, [['search', 'Searching for "evaluateRules\\("'], ['read', 'Reading src/jobs/nightly.ts']]);
    return {
      output: {
        concept: 'The rules only run in a nightly job at 2:00 am, and only for patients created the day before. A patient who converts today waits until tonight at the earliest.',
        refs: ['j1', 'ej', 'u1', 'n-yesterday'],
        add: {
          nodes: [{ id: 'n-yesterday', area: 'jobs', name: "Yesterday's patients only", symbol: 'src/jobs/nightly.ts#runNightly', explain: { concept: 'The nightly job only looks at patients created the day before.' }, evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter: yesterday' }] }],
          edges: [{ id: 'e-yesterday', from: 'j1', to: 'n-yesterday', kind: 'then', label: 'filters', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: "db.where('patients'" }] }],
        },
        moves: { focus: 'j1', highlight: ['j1', 'n-yesterday', 'ej', 'u1', 'eu12', 'u2', 'eu23', 'u3'] },
      },
      sessionId: 'preview-explainer',
      cost: 0,
    };
  }
  await narrate(req, [['read', 'Reading src/patients/service.ts']]);
  return {
    output: {
      concept: 'This is where the app tells the rest of the system that a patient just enrolled, so other parts can react, for example by sending the welcome email. Right now nothing is listening, so that reaction never happens.',
      route: 'answer',
      refs: ['s4', 'miss'],
      moves: { focus: 's4', highlight: ['s4', 'miss', 'u1'] },
    },
    sessionId: 'preview-explainer',
    cost: 0,
  };
};

const cleanUp = () => rmSync(root, { recursive: true, force: true });
// No autoStop here (a preview stays up for UI work), but the page's Stop button still ends it.
const server = await startServer({ root, port: Number(process.env.PORT ?? 4318), agent, onStop: () => { cleanUp(); process.exit(0); } });
const id = server.startMap('What happens when a patient converts? Does the welcome email go out?');
console.log(`\nilluminate preview (scripted Claude, no model calls) on a copy of the care app:\n\n  ${server.pageUrl(id)}\n`);
const stop = () => void server.close().then(() => { cleanUp(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
