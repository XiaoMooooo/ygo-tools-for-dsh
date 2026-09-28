// Internal facade for the engine backend.
//
// The DSH plugin entry (lib/index.js) imports `createModelToolHost` from here, so
// this module exists to give the plugin one stable import target. It used to also
// re-export most of the backend and define ten helpers (createYgoSession,
// listTools, getToolSchema, getAllToolSchemas, executeTool, runToolSequence,
// summarizeSession, loadPromptReference, listPromptReferences, buildAgentPrompt).
// None of them were reachable: the package `exports` map exposes only
// lib/index.js, and no file in this repository imported those symbols. They are
// preserved in git history if a future feature needs them.
//
// Import the owning module directly instead of growing this file back into a
// re-export barrel, so the dependency graph stays readable.

export { createModelToolHost } from './model-tool-host.mjs';
