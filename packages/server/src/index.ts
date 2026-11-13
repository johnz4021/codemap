// @illuminate/server: map making, answering and fixing with Claude, plus the local server the viewer talks to.
export { DEFAULT_MODEL, progressOf, sdkAgent, secretGuard, type Agent, type AgentRequest, type AgentResponse, type Progress } from './agent';
export { answer, type Answer, type AnswerOptions, type RefStatus, type Selection } from './explainer';
export { applyFix, connectAfterFix, proposeFix, undoFix, type AppliedFix, type FixFile, type FixProposal } from './fixes';
export { headStart } from './hints';
export { makeMap, type MakeOptions, type MakeResult } from './maker';
export { ANSWER_SCHEMA, MAP_SCHEMA, RawAnswer, RawFix } from './schemas';
export { startServer, type IlluminateServer, type JobKind, type JobState, type ServerEvent, type ServerOptions } from './server';
export { createStore, type MapMeta, type Store, type StoredMap } from './store';
export { createBridge, type Bridge, type BridgeRequest } from './bridge';
export { CHANNEL_INSTRUCTIONS, createChannel, requestText, runChannel, type ChannelOptions } from './channel';
