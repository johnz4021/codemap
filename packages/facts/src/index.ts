// @illuminate/facts: what the code says, read deterministically. Imports, symbols, calls, routes, table reads and writes,
// and fetch → route links for TS/JS (oxc) and Python/Go (tree-sitter). No model calls.
export type * from './contracts/facts';
export { diffSymbols } from './facts/diff';
export { extract, extractFacts, settleCalls, type ExtractContext, type PackageEntry, type Resolve } from './facts/extract';
export { hashText, squash } from './facts/hash';
export { normalizeRoutePath, routeId } from './facts/routes';
export { findReads, parseSqlTables } from './facts/tables';
export { diskLangContext, extractTreeSitter, initTreeSitter, treeSitterLang, treeSitterReady } from './facts/treesitter';
export { globMatcher, matchesAny } from './glob';
export { normalizePath, parseImports, resolveImport, resolveSpecifier } from './imports';
export { findFetchSites, matchRoute, urlPath, type FetchSite, type SourceFile } from './journeys/fetches';
export {
  CODE_EXTENSIONS,
  DEFAULT_IGNORE,
  createFactsIndex,
  fileExistsIn,
  isCodeFile,
  listRepoFiles,
  scanRepoFacts,
  symbolNames,
  withExtra,
  type Exists,
  type ImportEdge,
  type RepoScan,
  type RoutePattern,
  type ScanOptions,
  type WriteFact,
} from './scan';
