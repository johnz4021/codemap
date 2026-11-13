// @illuminate/core: the map format and the checker that decides which of a map's claims the code backs.
export {
  Absence,
  Area,
  CodeMap,
  Edge,
  EdgeKind,
  Evidence,
  Node,
  NodeKind,
  Screen,
  ScreenElement,
  TourStop,
  isSafeRelativePath,
  parseMap,
  type MapAbsence,
  type MapEdge,
  type MapNode,
  type ParseResult,
} from './format';
export { addToMap, freshId, mapIds, patchMap, removeAbsences, removeFromMap, slugify, type MapAdditions, type MapPatch } from './edit';
export { check, type AbsenceCheck, type CheckOptions, type CheckReport, type ClaimCheck, type EvidenceCheck, type Proof, type Status, type TourCheck } from './check';
export { MAX_FILE_BYTES, SECRET_GLOBS, createRepoReader, isSecretPath, type ReadResult, type RepoReader } from './repo';
export {
  Capture,
  IMAGE_TYPES,
  SCREENS_DIR,
  capturePaths,
  checkScreen,
  findOnCapture,
  readCapture,
  repoImage,
  type CapturedElement,
  type ScreenBox,
  type ScreenCheck,
  type ScreenShow,
} from './screens';
