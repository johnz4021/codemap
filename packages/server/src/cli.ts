// The illuminate command.
//   illume "<question>"        map a question about the repo, then open the map
//   illume open [<map-id>]     open saved maps
//   illume check <map-id|file> re-check a saved map against the code (exit 1 if anything is unconfirmed)
//   illume list                list saved maps
//   illume channel             run as a Claude Code channel (an MCP server over stdio; Claude Code starts it)
// Options: --repo <dir> (default: current directory)  --port <n> (default 4317)  --no-open  --model <id>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openBrowser } from './browser';
import { check, initTreeSitterForChecks, parseMap } from './cli-support';
import { startServer } from './server';
import { createStore } from './store';

type Args = { command: 'map' | 'open' | 'check' | 'list' | 'channel' | 'help'; rest: string[]; repo: string; repoGiven: boolean; port: number; open: boolean; model?: string };

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-open') flags.open = false;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i] ?? '';
    else positional.push(a);
  }
  const first = positional[0];
  const command = flags.help || !first ? 'help' : (['open', 'check', 'list', 'channel', 'help'].includes(first) ? first : 'map') as Args['command'];
  return {
    command,
    rest: command === 'map' ? [positional.join(' ')] : positional.slice(1),
    repo: path.resolve(String(flags.repo ?? process.cwd())),
    repoGiven: typeof flags.repo === 'string',
    port: Number(flags.port ?? 4317),
    open: flags.open !== false,
    model: typeof flags.model === 'string' ? flags.model : undefined,
  };
}

const HELP = `illume: ask how your code works, get a map you can point at.

  illume "<question>"          map a question about this repo and open it
  illume open [<map-id>]       open saved maps
  illume check <map-id|file>   re-check a saved map against the code
  illume list                  list saved maps
  illume channel               run inside Claude Code as a channel (see the README)

Options: --repo <dir>  --port <n>  --no-open  --model <id>
Needs Claude: an Anthropic API key (ANTHROPIC_API_KEY). As a channel, it uses the Claude Code session it runs in.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    // Started by an MCP client without `channel` (stdin is a pipe): say so where its logs show it, not on stdout.
    if (!process.stdin.isTTY && !process.argv.slice(2).length) {
      console.error('illume was started with no command. To run it as a Claude Code channel, add `channel`:\n  claude mcp add --scope user illuminate -- npx -y @johnz4021/illuminate channel');
      process.exitCode = 1;
      return;
    }
    return console.log(HELP);
  }
  if (args.command === 'channel') {
    const { runChannel } = await import('./channel');
    return runChannel({ root: args.repoGiven ? args.repo : undefined, port: args.port });
  }
  if (!fs.existsSync(args.repo)) throw new Error(`No such folder: ${args.repo}`);

  if (args.command === 'list') {
    const maps = createStore(args.repo).list();
    if (!maps.length) return console.log('No maps yet. Try: illume "what happens when …?"');
    for (const m of maps) console.log(`${m.id}  ${m.question}`);
    return;
  }

  if (args.command === 'check') {
    const target = args.rest[0];
    if (!target) throw new Error('Which map? illume check <map-id|file>');
    await initTreeSitterForChecks();
    const raw = fs.existsSync(target) ? (JSON.parse(fs.readFileSync(target, 'utf8')) as { map?: unknown }) : createStore(args.repo).get(target);
    if (!raw) throw new Error(`No map "${target}" in ${args.repo}/.illuminate/maps`);
    const parsed = parseMap('map' in raw ? raw.map : raw);
    if (!parsed.ok) throw new Error(`The map isn't valid:\n${parsed.problems.join('\n')}`);
    const report = check(parsed.map, args.repo);
    console.log(`${report.summary.confirmed} of ${report.summary.claims} claims confirmed`);
    for (const [kind, group] of [['box', report.nodes], ['arrow', report.edges], ['missing connection', report.absences]] as const) {
      for (const [id, c] of Object.entries(group)) if (c.status !== 'confirmed') console.log(`  ✗ ${kind} ${id}: ${c.reasons.join('; ')}`);
    }
    process.exitCode = report.summary.unconfirmed ? 1 : 0;
    return;
  }

  const server = await startServer({
    root: args.repo,
    port: args.port,
    model: args.model,
    // Stop once the last illuminate tab has been closed for a while (never while Claude is working), or from the page.
    autoStop: {},
    onStop: (reason) => {
      console.log(reason === 'requested' ? 'Stopped from the page.' : 'No illuminate tab is open, so illuminate stopped. Your maps are saved.');
      process.exit(0);
    },
  });
  let url: string;
  if (args.command === 'map') {
    const id = server.startMap(args.rest[0] ?? '');
    url = server.pageUrl(id);
    console.log(`Mapping "${args.rest[0]}" in ${args.repo}`);
  } else {
    url = server.pageUrl(args.rest[0]);
  }
  console.log(`\n  ${url}\n`);
  console.log(`${args.open ? 'Opening it in your browser.' : 'Open that link to see the map.'} Stops when you close the tab, or Ctrl+C.`);
  if (args.open) openBrowser(url);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
