// Making, answering and fixing, with a scripted Claude against a copy of the care app.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMap } from '@codemap/core';
import { progressOf, secretGuard } from '../src/agent';
import { answer } from '../src/explainer';
import { applyFix, connectAfterFix, proposeFix, undoFix } from '../src/fixes';
import { makeMap } from '../src/maker';
import { ANSWER_SCHEMA, MAP_SCHEMA, RawFix } from '../src/schemas';
import { CARE_MAP, LISTENER_FIX, cleanup, copyCareApp, scriptedAgent } from './helpers';

afterAll(cleanup);

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
    expect(prompt).toContain('src/ui/PatientHeader.tsx#PatientHeader sends POST /api/patients/{}/convert');
    expect(prompt).toContain('patients ← src/patients/service.ts#markConverted');
    expect(agent.calls[0]!.schema).toBe(MAP_SCHEMA);
    expect(progress).toEqual(expect.arrayContaining(['Reading src/patients/service.ts', '15 of 15 claims confirmed']));
  });

  it('sends what failed back to Claude in the same session, and keeps the better map', async () => {
    const root = copyCareApp();
    const broken = structuredClone(CARE_MAP);
    broken.nodes.find((n: any) => n.id === 'u2').evidence[0].text = 'function enqueue(';
    const agent = scriptedAgent([() => broken, () => CARE_MAP]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(r.rounds).toBe(2);
    expect(r.report.summary.unconfirmed).toBe(0);
    expect(agent.calls[1]!.resume).toBe('session-1');
    expect(agent.calls[1]!.prompt).toContain('box u2: src/jobs/queue.ts:3: "function enqueue(" isn\'t on line 3 or near it');
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
  it('answers from the map, keeps refs with their status, and moves the map', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({
      concept: 'This is where the app tells the rest of the system a patient enrolled. Nothing is listening.',
      how: 'markConverted emits patient.converted on the event bus; no code subscribes to it.',
      code: 'src/patients/service.ts:6 bus.emit',
      refs: ['s4', 'miss', 'invented'],
      moves: { focus: 's4', highlight: ['s4', 'miss', 'u1', 'nope'] },
      followUps: ['Where are the rules run today?'],
    })]);
    const r = await answer({ root, map: careMap(), selection: { nodes: ['s4'] }, question: 'What does this do?', agent, session: null });
    expect(r.answer.refs).toEqual([{ id: 's4', status: 'confirmed' }, { id: 'miss', status: 'confirmed' }, { id: 'invented', status: 'unknown' }]);
    expect(r.answer.moves).toEqual({ focus: 's4', highlight: ['s4', 'miss', 'u1'] });
    expect(agent.calls[0]!.prompt).toContain('- s4: box "Announces “converted”"');
    expect(agent.calls[0]!.schema).toBe(ANSWER_SCHEMA);
    expect(r.answer.added).toEqual([]);
  });

  it('draws what it found when the checker confirms it, and drops what it can\'t confirm', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({
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
    expect(agent.calls[0]!.resume).toBe('session-0');
  });

  it('turns a change request into a validated fix proposal and never edits', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([() => ({ concept: 'Listen for the announcement.', refs: ['miss'], fix: LISTENER_FIX })]);
    const r = await answer({ root, map: careMap(), selection: { absences: ['miss'] }, question: 'Make the email go out right away', agent, session: null });
    expect(r.answer.fix).toMatchObject({ summary: LISTENER_FIX.summary, files: [{ file: 'src/automations/listeners.ts', change: 'create', hash: null }] });
    expect(r.answer.fix!.diff).toContain("+ bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));");
    expect(existsSync(join(root, 'src/automations/listeners.ts'))).toBe(false);
    expect(agent.calls[0]!.prompt).toContain('- miss: missing connection: Nothing listens for patient.converted');
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
      creates: [{ file: 'src/db.ts', content: '' }, { file: '.codemap/maps/x.json', content: '{}' }],
    });
    const p = proposeFix(root, careMap(), fix);
    expect(p).toEqual({
      ok: false,
      problems: [
        '.env: codemap never changes this file',
        '../outside.ts: must be a path inside the repo',
        'src/db.ts: the text to replace appears 2 times (it must appear exactly once)',
        'src/db.ts: already exists',
        '.codemap/maps/x.json: codemap never changes this file',
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
