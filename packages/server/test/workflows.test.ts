// Making, answering and fixing, with a scripted Claude against a copy of the care app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMap } from '@illuminate/core';
import { progressOf, secretGuard } from '../src/agent';
import { answer, citedExcerpts } from '../src/explainer';
import { applyFix, connectAfterFix, proposeFix, undoFix } from '../src/fixes';
import { makeMap } from '../src/maker';
import { ANSWER_SCHEMA, MAP_PATCH_SCHEMA, MAP_SCHEMA, QUICK_ANSWER_SCHEMA, RawFix } from '../src/schemas';
import { CARE_MAP, LISTENER_FIX, cleanup, copyCareApp, scriptedAgent } from './helpers';

afterAll(cleanup);

/** The map-only first try saying it needs the code. */
const needsCode = (missing = 'How the nightly job picks patients.') => () => ({ route: 'code', missing });

const careMap = () => {
  const r = parseMap(CARE_MAP);
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
};

describe('makeMap', () => {
  it('gives Claude a head start from the code facts, then keeps the checked map', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => CARE_MAP]);
    const progress: string[] = [];
    const r = await makeMap({ root, question: 'What happens when a patient converts?', agent, onProgress: (p) => progress.push(p.text) });
    expect(r.report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0 });
    expect(r.map.question).toBe('What happens when a patient converts?'); // the person's words, not the model's
    expect(r.rounds).toBe(1);
    const prompt = agent.calls[0]!.prompt;
    expect(prompt).toContain('POST /api/patients/{}/convert → src/server/routes.ts#convertPatient');
    expect(prompt).toContain('src/ui/PatientHeader.tsx#PatientHeader.onConvert sends POST /api/patients/{}/convert'); // the inner handler
    // Every function a box can name, exactly as the checker names them, so Claude copies instead of guessing.
    expect(prompt).toContain('Functions by file (use these exact names for `symbol`):');
    expect(prompt).toContain('  - src/ui/PatientHeader.tsx: PatientHeader, PatientHeader.onConvert');
    expect(prompt).toContain('  - src/db.ts: db.update, db.where');
    expect(prompt).toContain('patients ← src/patients/service.ts#markConverted');
    expect(agent.calls[0]!.schema).toBe(MAP_SCHEMA);
    expect(progress).toEqual(expect.arrayContaining(['Reading src/patients/service.ts', '15 of 15 claims confirmed']));
  });

  it('sends what failed back to Claude in the same session, and takes back only the changes', async () => {
    const root = copyCareApp();
    const broken = structuredClone(CARE_MAP);
    broken.nodes.find((n: any) => n.id === 'u2').evidence[0].text = 'function enqueue(';
    const fixedU2 = CARE_MAP.nodes.find((n: any) => n.id === 'u2');
    const agent = scriptedAgent([() => broken, () => ({ nodes: [fixedU2] })]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(r.rounds).toBe(2);
    expect(r.report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0 });
    expect(r.map.nodes.map((n) => n.id)).toEqual(CARE_MAP.nodes.map((n: any) => n.id)); // u2 replaced in place, the rest kept
    expect(r.map.tour).toEqual(careMap().tour);
    expect(agent.calls[1]!.resume).toBe('session-1');
    expect(agent.calls[1]!.schema).toBe(MAP_PATCH_SCHEMA);
    expect(agent.calls[1]!.prompt).toContain('box u2: src/jobs/queue.ts:3: "function enqueue(" isn\'t on line 3 or near it');
    expect(agent.calls[1]!.prompt).toContain('Return only the changes, not the whole map.');
  });

  it('suggests the real name when a box cites a function the code calls something else', async () => {
    const root = copyCareApp();
    const broken = structuredClone(CARE_MAP);
    broken.nodes.find((n: any) => n.id === 's1').symbol = 'src/ui/PatientHeader.tsx#onConvert';
    const agent = scriptedAgent([() => broken, () => ({ nodes: [{ ...broken.nodes.find((n: any) => n.id === 's1'), symbol: 'src/ui/PatientHeader.tsx#PatientHeader.onConvert' }] })]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(agent.calls[1]!.prompt).toContain(
      "box s1: the code has no symbol src/ui/PatientHeader.tsx#onConvert (in that file it's src/ui/PatientHeader.tsx#PatientHeader.onConvert)",
    );
    expect(r.report.nodes.s1).toMatchObject({ status: 'confirmed', proof: 'fact' });
  });

  it('drops claims a repair removes, with the arrows that pointed at them', async () => {
    const root = copyCareApp();
    const broken = structuredClone(CARE_MAP);
    broken.nodes.find((n: any) => n.id === 'u3').evidence[0].text = 'export async function mailEverything';
    const agent = scriptedAgent([() => broken, () => ({ remove: ['u3'] })]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(r.map.nodes.map((n) => n.id)).not.toContain('u3');
    expect(r.map.edges.some((e) => e.from === 'u3' || e.to === 'u3')).toBe(false);
    expect(r.report.summary.unconfirmed).toBe(0);
  });

  it('asks again when its changes can\'t be applied, and keeps the last good map meanwhile', async () => {
    const root = copyCareApp();
    const broken = structuredClone(CARE_MAP);
    broken.nodes.find((n: any) => n.id === 'u2').evidence[0].text = 'function enqueue(';
    const fixedU2 = CARE_MAP.nodes.find((n: any) => n.id === 'u2');
    const agent = scriptedAgent([
      () => broken,
      () => ({ edges: [{ ...CARE_MAP.edges[0], to: 'nowhere' }] }),
      () => ({ nodes: [fixedU2] }),
    ]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(agent.calls[2]!.prompt).toContain("Your changes couldn't be applied to the map:");
    expect(agent.calls[2]!.prompt).toContain('unknown node "nowhere"');
    expect(agent.calls[2]!.schema).toBe(MAP_PATCH_SCHEMA);
    expect(r.rounds).toBe(3);
    expect(r.report.summary.unconfirmed).toBe(0);
  });

  it('repairs a map whose structure is wrong before checking it', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({ ...CARE_MAP, edges: [{ ...CARE_MAP.edges[0], to: 'nowhere' }] }), () => CARE_MAP]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(agent.calls[1]!.prompt).toContain('edge "e12": unknown node "nowhere"');
    expect(r.report.summary.unconfirmed).toBe(0);
  });

  it('gives up with a readable error when the map never parses', async () => {
    const agent = scriptedAgent([() => ({}), () => ({}), () => ({})]);
    await expect(makeMap({ root: copyCareApp(), question: 'q', agent })).rejects.toThrow(/Claude's map couldn't be read/);
  });
});

describe('answer', () => {
  it('answers from the map alone when it can: no tools, map and session unchanged, refs with their status', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({
      route: 'answer',
      concept: 'This is where the app tells the rest of the system a patient enrolled. Nothing is listening.',
      how: 'markConverted emits patient.converted on the event bus; no code subscribes to it.',
      code: 'src/patients/service.ts:6 bus.emit',
      refs: ['s4', 'miss', 'invented'],
      moves: { focus: 's4', highlight: ['s4', 'miss', 'u1', 'nope'] },
    })]);
    const earlier = [{ question: 'What starts this?', concept: 'Staff press Convert.' }];
    const r = await answer({ root, map: careMap(), selection: { nodes: ['s4'] }, question: 'What does this do?', agent, session: 'session-0', earlier });
    expect(r.answer.refs).toEqual([{ id: 's4', status: 'confirmed' }, { id: 'miss', status: 'confirmed' }, { id: 'invented', status: 'unknown' }]);
    expect(r.answer.moves).toEqual({ focus: 's4', highlight: ['s4', 'miss', 'u1'] });
    expect(r.answer).toMatchObject({ source: 'map', added: [], fix: null });
    expect(agent.calls).toHaveLength(1);
    const quick = agent.calls[0]!;
    expect(quick).toMatchObject({ schema: QUICK_ANSWER_SCHEMA, tools: [], resume: null });
    expect(quick.prompt).toContain('- s4: box "Announces “converted”"');
    expect(quick.prompt).toContain('(cited by s4)'); // the code around what the map cites, read by plain code
    expect(quick.prompt).toContain('- "What starts this?": Staff press Convert.');
    expect(r.sessionId).toBe('session-0'); // what Claude read in the code earlier carries on
    expect(r.map).toEqual(careMap());
  });

  it('gives both steps the conversation so far, so a follow-up knows what "that" was', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([needsCode('The listener code.'), () => ({ concept: 'It announces it.', refs: ['s4'] })]);
    const earlier = [{ question: 'Why is the email late?', concept: 'Nothing listens for the announcement.' }];
    await answer({ root, map: careMap(), selection: {}, question: 'Show me that in the code', agent, session: null, earlier });
    for (const call of agent.calls) {
      expect(call.prompt).toContain('## The conversation so far on this map (oldest first)');
      expect(call.prompt).toContain('- "Why is the email late?": Nothing listens for the announcement.');
    }
    expect(agent.calls).toHaveLength(2);
  });

  it('puts a picture of the screen on an existing box when asked what it looks like, and says when one can\'t be shown', async () => {
    const root = copyCareApp();
    const sketch = (text: string) => ({ kind: 'sketch', file: 'src/ui/PatientHeader.tsx', elements: [{ kind: 'button', text }], highlight: text });
    const agent = scriptedAgent([
      needsCode('What the button looks like.'),
      () => ({ concept: 'It is this button.', refs: ['s1'], screens: [{ node: 's1', screen: sketch('Mark as converted') }, { node: 's2', screen: sketch('Archive patient') }, { node: 'nope', screen: sketch('Mark as converted') }] }),
    ]);
    const r = await answer({ root, map: careMap(), selection: { nodes: ['s1'] }, question: 'What does this look like?', agent, session: null });
    expect(agent.calls[1]!.prompt).toContain('put `{ "node": "<box id>", "screen": { … } }` in `screens`');
    expect(r.answer).toMatchObject({ screens: ['s1'], added: [] });
    expect(r.map.nodes.find((n) => n.id === 's1')!.screen).toMatchObject({ kind: 'sketch', highlight: 'Mark as converted' });
    expect(r.map.nodes.find((n) => n.id === 's2')!.screen).toBeUndefined();
    expect(r.report.screens.s1).toMatchObject({ status: 'confirmed' });
    expect(r.answer.problems).toEqual([
      'No screen shown: there is no box "nope"',
      expect.stringMatching(/^No screen shown for ".+": "Archive patient" isn't in src\/ui\/PatientHeader.tsx$/),
    ]);
  });

  it('asks Claude for the plain answer only, and the plain explanation only for boxes (the map shows the code)', () => {
    const props = (schema: Record<string, unknown>) => Object.keys((schema as { properties: Record<string, unknown> }).properties);
    expect(props(ANSWER_SCHEMA)).not.toContain('how');
    expect(props(ANSWER_SCHEMA)).not.toContain('code');
    expect(props(QUICK_ANSWER_SCHEMA)).not.toContain('how');
    const node = (MAP_SCHEMA as { properties: { nodes: { items: { properties: { explain: Record<string, unknown> } } } } }).properties.nodes.items.properties.explain;
    expect(props(node)).toEqual(['concept']);
    const patchNode = (MAP_PATCH_SCHEMA as { properties: { nodes: { items: { properties: { explain: Record<string, unknown> } } } } }).properties.nodes.items.properties.explain;
    expect(props(patchNode)).toEqual(['concept']);
  });

  it('says when a question is about a different part of the app, and points at a saved map that covers it', async () => {
    const root = copyCareApp();
    const otherMaps = [{ id: 'billing', question: 'How does billing work?' }];
    const agent = scriptedAgent([
      () => ({ route: 'elsewhere', newQuestion: 'How do invoices get sent?', existingMap: 'billing' }),
      () => ({ route: 'elsewhere', newQuestion: '', existingMap: 'made-up' }),
    ]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'and invoices?', agent, session: 'session-0', otherMaps });
    expect(r.answer).toMatchObject({ concept: '', added: [], fix: null, offer: { question: 'How do invoices get sent?', existing: otherMaps[0], status: 'pending', mapId: null } });
    expect(agent.calls).toHaveLength(1); // no search: they choose first
    expect(agent.calls[0]!.prompt).toContain('- billing: "How does billing work?"');
    expect(r.sessionId).toBe('session-0');
    expect(r.map).toEqual(careMap());

    const r2 = await answer({ root, map: careMap(), selection: {}, question: 'and invoices?', agent, session: null, otherMaps });
    expect(r2.answer.offer).toMatchObject({ question: 'and invoices?', existing: null }); // only maps that exist
  });

  it('treats a question about something selected as about this map', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({ route: 'elsewhere', newQuestion: 'x' }), () => ({ concept: 'It announces it.', refs: ['s4'] })]);
    const r = await answer({ root, map: careMap(), selection: { nodes: ['s4'] }, question: 'and this?', agent, session: null });
    expect(r.answer).toMatchObject({ source: 'code', offer: null, concept: 'It announces it.' });
  });

  it('answers in words from the code, drawing nothing and proposing nothing', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({
      concept: 'Invoices aren\'t in this app.',
      add: { nodes: [{ id: 'n-filter', area: 'jobs', name: 'Only yesterday\'s patients', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter: yesterday' }] }] },
      fix: LISTENER_FIX,
    })]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'How do invoices get sent?', agent, session: null, wordsOnly: true });
    expect(agent.calls).toHaveLength(1); // straight to the code
    expect(agent.calls[0]!.schema).toBe(ANSWER_SCHEMA);
    expect(agent.calls[0]!.prompt).toContain('different part of the app');
    expect(r.answer).toMatchObject({ source: 'code', concept: 'Invoices aren\'t in this app.', added: [], fix: null });
    expect(r.map).toEqual(careMap());
  });

  it('reads the selection\'s code first, and never secret files', () => {
    const root = copyCareApp();
    const map = careMap();
    map.nodes[0]!.evidence = [{ file: '.env', line: 1, text: 'KEY' }, ...map.nodes[0]!.evidence];
    const text = citedExcerpts(root, map, { nodes: ['s4'] });
    expect(text.split('\n')[0]).toMatch(/\(cited by s4\)$/);
    expect(text).not.toContain('.env');
  });

  it('goes to the code when the map isn\'t enough, if the quick try fails, or when asked not to try', async () => {
    const root = copyCareApp();
    const reply = () => ({ concept: 'The rules only run in a nightly job.', refs: ['j1'] });
    const agent = scriptedAgent([needsCode('How the nightly job picks patients.'), reply, () => ({ nonsense: true }), reply, reply]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'Where do the rules run?', agent, session: 'session-0' });
    expect(r.answer).toMatchObject({ source: 'code', concept: 'The rules only run in a nightly job.', cost: 0.02 });
    expect(agent.calls[1]).toMatchObject({ schema: ANSWER_SCHEMA, resume: 'session-0' });
    expect(agent.calls[1]!.tools).toBeUndefined(); // Read, Grep and Glob
    expect(agent.calls[1]!.prompt).toContain("## Why the map alone wasn't enough\nHow the nightly job picks patients.");

    expect((await answer({ root, map: careMap(), selection: {}, question: 'Where?', agent, session: null })).answer.source).toBe('code');
    expect(agent.calls[3]!.schema).toBe(ANSWER_SCHEMA);
    await answer({ root, map: careMap(), selection: {}, question: 'Where?', agent, session: null, quick: false });
    expect(agent.calls.map((c) => c.schema === QUICK_ANSWER_SCHEMA)).toEqual([true, false, true, false, false]);
  });

  it('draws what it found when the checker confirms it, and drops what it can\'t confirm', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([needsCode(), () => ({
      concept: 'The rules only run in a nightly job.',
      refs: ['j1', 'n-filter'],
      add: {
        nodes: [
          { id: 'n-filter', area: 'jobs', name: 'Only yesterday\'s patients', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter: yesterday' }] },
          { id: 'n-wrong', area: 'jobs', name: 'Retries failed emails', evidence: [{ file: 'src/jobs/nightly.ts', line: 3, text: 'retryFailed(' }] },
        ],
        edges: [{ id: 'e-filter', from: 'j1', to: 'n-filter', kind: 'then', label: 'filters', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: "db.where('patients'" }] }],
      },
    })]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'Where do the rules run?', agent, session: 'session-0' });
    expect(r.answer.added.sort()).toEqual(['e-filter', 'n-filter']);
    expect(r.map.nodes.map((n) => n.id)).toContain('n-filter');
    expect(r.map.nodes.map((n) => n.id)).not.toContain('n-wrong');
    expect(r.answer.problems).toEqual(['Not drawn, couldn\'t confirm n-wrong: src/jobs/nightly.ts:3: "retryFailed(" isn\'t on line 3 or near it']);
    expect(r.report.summary.unconfirmed).toBe(0);
    expect(agent.calls[1]!.resume).toBe('session-0');
  });

  it('turns a change request into a validated fix proposal and never edits', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([needsCode('The change itself.'), () => ({ concept: 'Listen for the announcement.', refs: ['miss'], fix: LISTENER_FIX })]);
    const r = await answer({ root, map: careMap(), selection: { absences: ['miss'] }, question: 'Make the email go out right away', agent, session: null });
    expect(r.answer.fix).toMatchObject({ summary: LISTENER_FIX.summary, files: [{ file: 'src/automations/listeners.ts', change: 'create', hash: null }] });
    expect(r.answer.fix!.diff).toContain("+ bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));");
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(false);
    expect(agent.calls[1]!.prompt).toContain('- miss: missing connection: Nothing listens for patient.converted');
  });
});

describe('fixes', () => {
  it('applies an approved fix, draws the new connection, closes the gap, and undoes cleanly', () => {
    const root = copyCareApp();
    const map = careMap();
    const p = proposeFix(root, map, RawFix.parse(LISTENER_FIX));
    if (!p.ok) throw new Error(p.problems.join('\n'));
    const a = applyFix(root, p.proposal);
    if (!a.ok) throw new Error(a.problems.join('\n'));
    const c = connectAfterFix(root, map, p.proposal);
    expect(c.edgeId).toBe('fx1');
    expect(c.closed).toEqual(['miss']);
    expect(c.map.edges.find((e) => e.id === 'fx1')).toMatchObject({ from: 's4', to: 'u1', evidence: [{ file: 'src/automations/listeners.ts', line: 4 }] });
    expect(undoFix(root, a.applied)).toEqual({ ok: true });
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(false);
  });

  it('edits by exact replacement, and refuses if the file changed after the proposal', () => {
    const root = copyCareApp();
    const fix = RawFix.parse({
      summary: 'Evaluate rules right after announcing.',
      edits: [{ file: 'src/patients/service.ts', find: "  bus.emit('patient.converted', { patientId });", replace: "  bus.emit('patient.converted', { patientId });\n  await evaluateRules({ patientId });" }],
    });
    const p = proposeFix(root, careMap(), fix);
    if (!p.ok) throw new Error(p.problems.join('\n'));
    expect(p.proposal.diff).toContain('src/patients/service.ts · line 6');
    writeFileSync(join(root, 'src/patients/service.ts'), `${readFileSync(join(root, 'src/patients/service.ts'), 'utf8')}// touched\n`);
    expect(applyFix(root, p.proposal)).toEqual({ ok: false, problems: ['src/patients/service.ts changed since this fix was proposed; ask for the fix again'] });
  });

  it('rejects fixes that touch secrets, leave the repo, replace ambiguous text, or overwrite files', () => {
    const root = copyCareApp();
    const fix = RawFix.parse({
      summary: 'bad',
      edits: [
        { file: '.env', find: 'EMAIL_API_KEY', replace: 'X' },
        { file: '../outside.ts', find: 'a', replace: 'b' },
        { file: 'src/db.ts', find: 'async', replace: 'sync' },
      ],
      creates: [{ file: 'src/db.ts', content: '' }, { file: '.illuminate/maps/x.json', content: '{}' }],
    });
    const p = proposeFix(root, careMap(), fix);
    expect(p).toEqual({
      ok: false,
      problems: [
        '.env: illuminate never changes this file',
        '../outside.ts: must be a path inside the repo',
        'src/db.ts: the text to replace appears 2 times (it must appear exactly once)',
        'src/db.ts: already exists',
        '.illuminate/maps/x.json: illuminate never changes this file',
      ],
    });
  });

  it('refuses a connection whose evidence isn\'t in the new code', () => {
    const fix = RawFix.parse({ ...LISTENER_FIX, connects: { ...LISTENER_FIX.connects, evidenceText: 'bus.on("something.else"' } });
    const p = proposeFix(copyCareApp(), careMap(), fix);
    expect(p.ok).toBe(false);
  });
});

describe('the agent wrapper', () => {
  it('words tool calls as progress, relative to the repo', () => {
    expect(progressOf('Read', { file_path: '/repo/src/a.ts' }, '/repo')).toEqual({ kind: 'read', text: 'Reading src/a.ts' });
    expect(progressOf('Grep', { pattern: 'patient\\.converted' }, '/repo')).toEqual({ kind: 'search', text: 'Searching for "patient\\.converted"' });
    expect(progressOf('Bash', {}, '/repo')).toBeNull();
  });

  it('refuses secrets and paths outside the repo, and keeps unscoped searches away from secrets', async () => {
    const guard = secretGuard('/repo');
    const run = (tool_name: string, tool_input: Record<string, unknown>) => guard({ hook_event_name: 'PreToolUse', tool_name, tool_input } as never, undefined, { signal: new AbortController().signal });
    expect(await run('Read', { file_path: '/repo/.env' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await run('Read', { file_path: '/etc/passwd' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await run('Grep', { pattern: 'KEY' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { pattern: 'KEY', glob: expect.stringContaining('.env') } } });
    expect(await run('Grep', { pattern: 'x', glob: '*.ts' })).toEqual({});
    expect(await run('Read', { file_path: '/repo/src/a.ts' })).toEqual({});
  });
});
