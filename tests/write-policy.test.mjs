// File-write authorization policy: the gate that keeps model-reachable exports
// inside the operator-configured output roots.
import { join } from 'node:path';
import { reporter, ROOT } from './harness.mjs';

const { checkFileWriteAuthorization, isInsideDirectory, WRITE_OPERATIONS } = await import(
  `file:///${ROOT}/skill/runtime/src/tools/file-write-policy.js`
);

const t = reporter();
const sandbox = join(ROOT, 'tests', '.sandbox');
const decks = join(sandbox, 'decks');
const replays = join(sandbox, 'replays');
const routes = join(sandbox, 'routes');
const config = { deckDir: decks, replayDir: replays, routeDir: routes };

t.section('authorized writes');
t.check('a plain file name inside the root is allowed',
  checkFileWriteAuthorization(config, { fileName: 'deck.ydk' }, 'exportSessionDeck').ok, true);
t.check('a legal subdirectory inside the root is allowed',
  checkFileWriteAuthorization(config, { fileName: 'sub/deck.ydk' }, 'exportSessionDeck').ok, true);
t.check('an absolute path inside the root is allowed',
  checkFileWriteAuthorization(config, { fileName: join(decks, 'deck.ydk') }, 'exportSessionDeck').ok, true);
t.check('a caller-supplied dir equal to the root is allowed',
  checkFileWriteAuthorization(config, { replayDir: replays }, 'saveReplayYrp').ok, true);
t.check('a caller-supplied subdirectory of the root is allowed',
  checkFileWriteAuthorization(config, { routeDir: join(routes, 'match-1') }, 'saveRouteFile').ok, true);
t.check('the context wrapper form is accepted',
  checkFileWriteAuthorization({ session: {}, config }, { fileName: 'deck.ydk' }, 'exportSessionDeck').ok, true);
t.check('the authorized directory is reported when a subdirectory is requested',
  checkFileWriteAuthorization(config, { routeDir: join(routes, 'x') }, 'saveRouteFile').directory,
  join(routes, 'x'));

t.section('rejected writes');
const traversal = checkFileWriteAuthorization(config, { fileName: '../../escaped.ydk' }, 'exportSessionDeck');
t.check('a traversing file name is refused', traversal.ok, false);
t.check('  with WRITE_PATH_ESCAPES_OUTPUT_ROOT', traversal.code, 'WRITE_PATH_ESCAPES_OUTPUT_ROOT');
const absolute = checkFileWriteAuthorization(config, { file: join(sandbox, 'escaped.ydk') }, 'exportSessionDeck');
t.check('an absolute path outside the root is refused', absolute.ok, false);
t.check('  with WRITE_PATH_ESCAPES_OUTPUT_ROOT', absolute.code, 'WRITE_PATH_ESCAPES_OUTPUT_ROOT');
const tampered = checkFileWriteAuthorization(config, { replayDir: join(sandbox, 'elsewhere') }, 'saveReplayYrp');
t.check('a caller-supplied directory outside the root is refused', tampered.ok, false);
t.check('  with WRITE_PATH_ESCAPES_OUTPUT_ROOT', tampered.code, 'WRITE_PATH_ESCAPES_OUTPUT_ROOT');
t.check('cross-root redirection is refused',
  checkFileWriteAuthorization(config, { routeDir: replays }, 'saveRouteFile').code, 'WRITE_PATH_ESCAPES_OUTPUT_ROOT');
t.check('a sibling directory sharing the root prefix is refused',
  checkFileWriteAuthorization(config, { fileName: join(`${decks}-evil`, 'x.ydk') }, 'exportSessionDeck').ok, false);

t.section('fails closed');
const unconfigured = checkFileWriteAuthorization({}, { fileName: 'deck.ydk' }, 'exportSessionDeck');
t.check('an unconfigured root refuses every write', unconfigured.ok, false);
t.check('  with WRITE_ROOT_UNCONFIGURED', unconfigured.code, 'WRITE_ROOT_UNCONFIGURED');
t.check('an unknown operation is refused',
  checkFileWriteAuthorization(config, {}, 'deleteEverything').code, 'UNKNOWN_WRITE_OPERATION');
t.check('a blank configured root counts as unconfigured',
  checkFileWriteAuthorization({ deckDir: '   ' }, {}, 'exportSessionDeck').code, 'WRITE_ROOT_UNCONFIGURED');

t.section('directory containment helper');
t.check('the directory is inside itself', isInsideDirectory(decks, decks), true);
t.check('a descendant is inside', isInsideDirectory(join(decks, 'a', 'b'), decks), true);
t.check('casing does not matter', isInsideDirectory(decks.toUpperCase(), decks), true);
t.check('a prefix sibling is not inside', isInsideDirectory(`${decks}-x`, decks), false);
t.check('a parent is not inside', isInsideDirectory(sandbox, decks), false);
t.check('every operation declares a root and a file-name key',
  Object.values(WRITE_OPERATIONS).every((op) => typeof op.rootKey === 'string' && op.fileNameKeys.length > 0), true);

t.finish();
