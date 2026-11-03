#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step) through tsx's loader.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
