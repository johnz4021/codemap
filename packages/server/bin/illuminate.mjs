#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step) through tsx's loader.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { register } from 'tsx/esm/api';

// Illuminate's own settings (ANTHROPIC_API_KEY, ILLUMINATE_MODEL) from a .env at the illuminate checkout's root. This is never
// the target repo's .env, which illuminate refuses to read. Variables already set in the shell win, and empty ones are
// skipped so a blank key doesn't hide a Claude Code login.
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}

register();
await import('../src/cli.ts');
