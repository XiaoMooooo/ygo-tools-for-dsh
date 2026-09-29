// Tool contract: the action table is the single source of truth, conditional
// requirements are enforced, and unknown actions are reported precisely.
import { reporter, ROOT } from './harness.mjs';

const {
  PUBLIC_TOOL_ACTIONS,
  PUBLIC_TOOL_DESCRIPTIONS,
  PUBLIC_TOOL_INPUT_SCHEMAS,
  PUBLIC_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
  validatePublicToolInput,
  validateSchemaValue,
} = await import(`file:///${ROOT}/skill/backend/tool-schemas.mjs`);

const t = reporter();

function ok(label, name, input) {
  const result = validatePublicToolInput(name, input);
  t.assert(label, result.ok, result.ok ? undefined : JSON.stringify(result.errors));
}
function bad(label, name, input, expectedCode) {
  const result = validatePublicToolInput(name, input);
  t.assert(label, !result.ok, 'expected the call to be refused');
  if (expectedCode && !result.ok) t.check(`  ^ ${label}`, result.errors[0]?.code ?? null, expectedCode);
}

t.section('the action table is the single source of truth');
const unknownTools = Object.keys(PUBLIC_TOOL_ACTIONS).filter((n) => !PUBLIC_TOOL_NAMES.includes(n));
t.check('every action-table key is a public tool', unknownTools.length, 0);
const referenced = [...new Set(Object.values(PUBLIC_TOOL_ACTIONS).flatMap((a) => Object.values(a).map((e) => e.tool)))];
const missing = referenced.filter((tool) => !TOOL_INPUT_SCHEMAS[tool]);
t.check('every referenced internal tool exists', missing.length, 0);
for (const [tool, actions] of Object.entries(PUBLIC_TOOL_ACTIONS)) {
  const declared = PUBLIC_TOOL_INPUT_SCHEMAS[tool]?.properties?.action?.enum ?? [];
  const table = Object.keys(actions);
  t.assert(`action enum matches the table: ${tool}`,
    declared.length === table.length && declared.every((a, i) => a === table[i]),
    `declared=${JSON.stringify(declared)} table=${JSON.stringify(table)}`);
}
const actionless = PUBLIC_TOOL_NAMES.filter((n) => !PUBLIC_TOOL_INPUT_SCHEMAS[n]?.properties?.action);
t.check('actionless tools are absent from the table',
  actionless.filter((n) => PUBLIC_TOOL_ACTIONS[n]).length, 0);
t.note(`actionless public tools: ${JSON.stringify(actionless)}`);
t.check('the public surface exposes 16 tools', PUBLIC_TOOL_NAMES.length, 16);

t.section('unknown actions are refused with the available list');
for (const [tool, input] of [['queryCards', { action: 'lookup' }], ['manageEngineSession', { action: 'statu' }], ['observeDuel', {}]]) {
  const result = validatePublicToolInput(tool, input);
  const available = result.errors?.[0]?.data?.availableActions;
  t.check(`${tool}: INVALID_ACTION code`, result.errors?.[0]?.code, 'INVALID_ACTION');
  t.assert(`${tool}: available actions are reported`,
    Array.isArray(available) && available.length > 0, JSON.stringify(result.errors));
  t.assert(`${tool}: the message lists them`,
    /Expected one of:/.test(result.errors?.[0]?.message ?? ''), result.errors?.[0]?.message);
}

t.section('conditional requirements are enforced per action');
bad('queryCards get without an identifier', 'queryCards', { action: 'get' }, 'MISSING_REQUIRED_ARGUMENT');
ok('queryCards get with cardName', 'queryCards', { action: 'get', cardName: 'Dark Magician' });
ok('queryCards get with passcode', 'queryCards', { action: 'get', passcode: 46986414 });
ok('queryCards get tolerates a sibling-action field', 'queryCards', { action: 'get', cardName: 'X', limit: 5 });
bad('queryCards search without query', 'queryCards', { action: 'search' }, 'MISSING_REQUIRED_ARGUMENT');
ok('queryCards search with query', 'queryCards', { action: 'search', query: 'magician' });
bad('refresh without allowNetworkUpdate', 'manageCardDataSources', { action: 'refresh' }, 'MISSING_REQUIRED_ARGUMENT');
ok('refresh with allowNetworkUpdate', 'manageCardDataSources', { action: 'refresh', allowNetworkUpdate: true });
ok('inspect needs no fields', 'manageCardDataSources', { action: 'inspect' });
ok('discover needs no fields', 'manageYgoPro2', { action: 'discover' });
ok('bridge status needs no fields', 'manageYgoPro2', { action: 'status' });
bad('manageSessionDeck set without a deck body', 'manageSessionDeck', { action: 'set' }, 'MISSING_REQUIRED_ARGUMENT');
ok('manageSessionDeck set with deckText', 'manageSessionDeck', { action: 'set', deckText: '#main' });
bad('manageSessionDeck edit without operation', 'manageSessionDeck', { action: 'edit' }, 'MISSING_REQUIRED_ARGUMENT');
ok('manageSessionDeck edit with operation', 'manageSessionDeck', { action: 'edit', operation: 'add', cardName: 'X' });
ok('manageSessionDeck export needs no fields', 'manageSessionDeck', { action: 'export' });
bad('manageSessionDeck check without a lookup field', 'manageSessionDeck', { action: 'check' }, 'MISSING_REQUIRED_ARGUMENT');
ok('observeDuel actions with limit', 'observeDuel', { action: 'actions', limit: 10 });
bad('checkpoint delete without a selector', 'manageCheckpoint', { action: 'delete' }, 'MISSING_REQUIRED_ARGUMENT');
ok('checkpoint save needs no fields', 'manageCheckpoint', { action: 'save' });
bad('analyzeReplay parse without a source', 'analyzeReplay', { action: 'parse' }, 'MISSING_REQUIRED_ARGUMENT');
ok('analyzeReplay parse with file', 'analyzeReplay', { action: 'parse', file: 'x.yrp' });
bad('analyzeReplay analyze without a source', 'analyzeReplay', { action: 'analyze' }, 'MISSING_REQUIRED_ARGUMENT');
ok('analyzeReplay context needs no fields', 'analyzeReplay', { action: 'context' });
bad('analyzeCombo parse without a source', 'analyzeCombo', { action: 'parse' }, 'MISSING_REQUIRED_ARGUMENT');
ok('analyzeCombo parse with content', 'analyzeCombo', { action: 'parse', content: '{}' });
bad('saveArtifact route without content', 'saveArtifact', { action: 'route' }, 'MISSING_REQUIRED_ARGUMENT');
ok('saveArtifact route with content', 'saveArtifact', { action: 'route', content: '# route' });
ok('saveArtifact replay needs no fields', 'saveArtifact', { action: 'replay' });
bad('engine shutdown without confirm', 'manageEngineSession', { action: 'shutdown' }, 'MISSING_REQUIRED_ARGUMENT');
ok('engine shutdown with confirm', 'manageEngineSession', { action: 'shutdown', confirm: true });
ok('engine status needs no fields', 'manageEngineSession', { action: 'status' });

t.section('pre-existing validation still holds');
bad('an unknown property is still rejected', 'queryCards', { action: 'get', cardName: 'X', bogus: 1 });
ok('an actionless tool still validates', 'getBanlistContext', { listName: 'OCG' });
bad('an actionless tool still checks types', 'getBanlistContext', { listName: 5 });
ok('executeAction with actionLabel', 'executeAction', { actionLabel: 'Normal Summon' });
bad('executeAction without any selector', 'executeAction', {});

t.section('public schemas stay convertible to the DSH parameter DSL');
// lib/index.js forwards only `properties` to DSH, because the parameter DSL takes
// a property map rather than a schema. Anything expressed outside `properties`
// is therefore invisible to the model, so the properties must be non-empty (a
// root combinator alone would register the tool with an empty parameter object).
for (const name of PUBLIC_TOOL_NAMES) {
  const schema = PUBLIC_TOOL_INPUT_SCHEMAS[name];
  t.assert(`${name}: root is an object schema`, schema?.type === 'object', JSON.stringify(Object.keys(schema ?? {})));
  t.assert(`${name}: declares properties`, !!schema?.properties && Object.keys(schema.properties).length > 0);
  t.check(`${name}: additionalProperties is explicit`, schema?.additionalProperties, false);
  t.assert(`${name}: declares a description`, typeof PUBLIC_TOOL_DESCRIPTIONS?.[name] === 'string');
}

t.section('requirements the DSL cannot express are still explained to the model');
// A root anyOf is enforced engine-side only; the model reads property
// descriptions, so every selector named by such a requirement must describe it.
let proseChecked = 0;
for (const name of PUBLIC_TOOL_NAMES) {
  const schema = PUBLIC_TOOL_INPUT_SCHEMAS[name] ?? {};
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (branches.length === 0) continue;
  const keys = [...new Set(branches.flatMap((branch) => Array.isArray(branch?.required) ? branch.required : []))];
  for (const key of keys) {
    proseChecked += 1;
    const node = schema.properties?.[key];
    t.assert(`${name}.${key} explains the one-of requirement in its description`,
      typeof node?.description === 'string' && node.description.length > 0, JSON.stringify(node));
  }
}
t.note(`root-anyOf selectors checked for prose: ${proseChecked}`);

t.section('validator keywords');
t.check('const matches', validateSchemaValue({ const: 'get' }, 'get').length, 0);
t.check('const mismatch is rejected', validateSchemaValue({ const: 'get' }, 'set').length > 0, true);
t.check('oneOf with exactly one match', validateSchemaValue({ oneOf: [{ const: 'a' }, { const: 'b' }] }, 'a').length, 0);
t.check('oneOf with no match is rejected', validateSchemaValue({ oneOf: [{ const: 'a' }, { const: 'b' }] }, 'c').length > 0, true);
t.check('oneOf with two matches is rejected', validateSchemaValue({ oneOf: [{ type: 'string' }, { minLength: 1 }] }, 'x').length > 0, true);
t.check('pattern matches', validateSchemaValue({ type: 'string', pattern: '^[a-z]+$' }, 'abc').length, 0);
t.check('pattern mismatch is rejected', validateSchemaValue({ type: 'string', pattern: '^[a-z]+$' }, 'A1').length > 0, true);
t.check('a broken pattern is ignored, not fatal', validateSchemaValue({ type: 'string', pattern: '([' }, 'x').length, 0);
t.check('anyOf still works', validateSchemaValue({ anyOf: [{ required: ['a'] }, { required: ['b'] }] }, { b: 1 }).length, 0);
t.check('enum still works', validateSchemaValue({ enum: ['a', 'b'] }, 'b').length, 0);
t.check('required still works', validateSchemaValue({ required: ['a'] }, {}).length > 0, true);

t.section('the engine facade still exposes what the plugin entry imports');
// lib/index.js does `import { createModelToolHost } from '../skill/backend/index.mjs'`.
// This is the one coupling that makes skill/backend/index.mjs load-bearing; the
// suite would otherwise not notice if it were dropped or renamed.
const facade = await import(`file:///${ROOT}/skill/backend/index.mjs`);
t.check('index.mjs exports createModelToolHost', typeof facade.createModelToolHost, 'function');
t.check('the facade returns a host with the public tool list',
  typeof facade.createModelToolHost?.({}, { onShutdown: () => {} })?.listTools, 'function');

t.section('every backend module links');
// ESM resolves named imports at link time, so a dead-code removal that drops a
// symbol someone still imports fails only when that module is imported. Walking
// the directory catches it even for modules nothing else imports yet.
const { readdirSync } = await import('node:fs');
const backendDir = `${ROOT}/skill/backend`;
const modules = readdirSync(backendDir).filter((f) => f.endsWith('.mjs'));
let broken = 0;
for (const file of modules) {
  try {
    await import(`file:///${backendDir}/${file}`);
  } catch (error) {
    broken += 1;
    t.assert(`imports cleanly: ${file}`, false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}
t.note(`backend modules imported: ${modules.length}`);
t.check('no backend module fails to link', broken, 0);

t.finish();
