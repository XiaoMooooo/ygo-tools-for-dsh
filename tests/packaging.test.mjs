// Packaging integrity: the published tarball must keep every runtime entry point
// while staying inside the slimmed size budget.
//
// Set YGO_PACK_JSON to a saved `npm pack --dry-run --json` output to check a list
// without invoking npm (useful where spawning npm is not permitted).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { reporter, ROOT } from './harness.mjs';

const t = reporter();

function loadPackList() {
  const saved = process.env.YGO_PACK_JSON;
  if (saved) return JSON.parse(readFileSync(saved, 'utf8').replace(/^\uFEFF/, ''));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    return JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      shell: process.platform === 'win32',
    }));
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    const status = error && typeof error === 'object' ? error.status : undefined;
    // Could not start npm at all (restricted sandbox, npm absent). That is a
    // missing capability of the environment, not a defect in the package, so
    // skip loudly instead of reporting a false failure. A real npm error (npm
    // ran and exited non-zero) still fails the suite below.
    if (code === 'EPERM' || code === 'ENOENT' || code === 'EACCES') {
      console.log(`SKIP  npm pack --dry-run could not be started (${code}).`);
      console.log('      Re-run with YGO_PACK_JSON=<saved pack --dry-run --json> to check offline,');
      console.log('      or run this suite in CI where npm is available.');
      process.exit(0);
    }
    t.assert('npm pack --dry-run succeeded', false,
      `${error instanceof Error ? error.message : String(error)}${status === undefined ? '' : ` (exit ${status})`}`);
    t.finish();
    throw error;
  }
}

const parsed = loadPackList();
const entry = Array.isArray(parsed) ? parsed[0] : parsed;
const paths = new Set(entry.files.map((f) => f.path.replace(/\\/g, '/')));
const all = [...paths];
const unpacked = entry.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
const mb = (n) => (n / 1048576).toFixed(2);

t.section('size budget');
t.note(`files=${all.length} unpacked=${mb(unpacked)} MB tgz=${mb(entry.size ?? 0)} MB`);
t.assert('the tarball stays under 15.0 MB', (entry.size ?? 0) <= 15.0 * 1048576, `tgz=${mb(entry.size ?? 0)} MB`);
t.assert('the unpacked tree stays under 74 MB', unpacked <= 74 * 1048576, `unpacked=${mb(unpacked)} MB`);
t.assert('the file count stays under 14,800', all.length <= 14800, `files=${all.length}`);

t.section('runtime-critical files ship');
const required = [
  'package.json',
  'lib/index.js',
  'skill/backend/tool-schemas.mjs',
  'skill/backend/model-tool-host.mjs',
  'skill/backend/persistent-engine-server.mjs',
  'skill/backend/persistent-engine-client.mjs',
  'skill/backend/engine-token.mjs',
  'skill/runtime/src/tools/file-write-policy.js',
  'skill/runtime/combo-simulator.cjs',
  'skill/resources/lib/cards.cdb',
  'skill/resources/lib/lflist.conf',
  'skill/resources/lib/strings.conf',
  'skill/resources/ygopro2-bridge/windbot/WindBot.exe',
  'skill/vendor/node_modules/sql.js/dist/sql-wasm.wasm',
  'skill/vendor/node_modules/koishipro-core.js/dist/vendor/wasm_cjs/libocgcore.wasm',
];
for (const file of required) t.assert(`ships ${file}`, paths.has(file));

const dlls = all.filter((p) => /^skill\/resources\/ygopro2-bridge\/windbot\/[^/]+\.dll$/.test(p));
t.assert('the prebuilt WindBot DLLs ship beside the exe', dlls.length > 0, JSON.stringify(dlls));
t.note(`WindBot DLLs: ${JSON.stringify(dlls.map((p) => p.split('/').pop()))}`);
const lua = all.filter((p) => p.endsWith('.lua'));
t.assert('all Lua card scripts ship', lua.length >= 13000, `lua=${lua.length}`);

t.section('every vendored package entry point resolves');
const manifests = all.filter((p) => /^skill\/vendor\/node_modules\/(@[^/]+\/)?[^/]+\/package\.json$/.test(p));
const CODE = /\.(js|cjs|mjs|wasm|json|node)$/;
let checked = 0;
let missingEntries = 0;
for (const manifestPath of manifests) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(`${ROOT}/${manifestPath}`, 'utf8'));
  } catch {
    continue;
  }
  const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  const targets = [];
  const collect = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) collect(nested);
  };
  for (const key of ['main', 'module', 'browser', 'exports', 'bin']) collect(manifest[key]);
  for (const target of targets) {
    if (!CODE.test(target)) continue;
    checked += 1;
    const resolved = `${dir}/${target.replace(/^\.\//, '')}`;
    if (!paths.has(resolved)) {
      missingEntries += 1;
      t.assert(`entry point ships: ${resolved}`, false, `declared by ${manifestPath}`);
    }
  }
}
t.note(`packages examined: ${manifests.length}, entry points verified: ${checked}`);
t.check('no vendored entry point was excluded', missingEntries, 0);

t.section('intended exclusions');
// npm force-includes README*/CHANGELOG*/LICENSE*/package.json in every directory
// it walks, so those file names survive any denylist by design.
const npmForced = /(^|\/)(README|CHANGELOG|LICENCE|LICENSE|NOTICE)(\.[A-Za-z0-9]+)?$/i;
t.check('no .d.ts declarations are shipped', all.filter((p) => p.endsWith('.d.ts')).length, 0);
t.check('no source maps are shipped', all.filter((p) => p.endsWith('.map')).length, 0);
t.check('no C# sources are shipped', all.filter((p) => p.endsWith('.cs')).length, 0);
t.check('WindBot build sources are excluded', all.filter((p) => p.includes('windbot/source/')).length, 0);
t.check('vendored docs are excluded (except npm-forced names)',
  all.filter((p) => p.startsWith('skill/vendor/') && p.endsWith('.md') && !npmForced.test(p)).length, 0);
t.assert('skill/references/*.md still ship',
  all.filter((p) => p.startsWith('skill/references/') && p.endsWith('.md')).length > 0);
t.assert('the test suite itself is not published', !all.some((p) => p.startsWith('tests/')));

t.finish();
