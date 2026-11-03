// What `codemap check` needs, kept apart from the server so the CLI can check without starting anything.
import { initTreeSitter } from '@codemap/facts';

export { check, parseMap } from '@codemap/core';

/** Python and Go facts need the tree-sitter runtime; TS/JS doesn't. Loading it is cheap and happens once. */
export const initTreeSitterForChecks = () => initTreeSitter();
