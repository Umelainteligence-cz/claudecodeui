import assert from 'node:assert/strict';

import { test } from 'vitest';

import { isPathReference, resolveFileReference } from '@/modules/project-workspace/hooks/useFileOpenResolver';

/**
 * Kryton download overlay (plan ccl-r262, S1 b). A chat link opens exactly the file
 * it names: the tree the resolver sees is gitignore-filtered, so a link to an output
 * in `_workspace/` must never be "found" as another visible file of the same name.
 */

const ROOT = '/home/coder/workspace';
const tree = [
  { name: 'vystup.docx', path: `${ROOT}/old/vystup.docx` },
  { name: 'vystup.docx', path: `${ROOT}/qa/vystup.docx` },
  { name: 'only.ts', path: `${ROOT}/src/deep/only.ts` },
];

test('a path opens exactly that path from the project root, not a same-named copy', () => {
  assert.equal(resolveFileReference(tree, 'qa/vystup.docx', ROOT), `${ROOT}/qa/vystup.docx`);
  assert.equal(resolveFileReference(tree, 'old/vystup.docx', ROOT), `${ROOT}/old/vystup.docx`);
});

test('a missing (gitignored) target stays its own path even when a same-named file is visible', () => {
  assert.equal(resolveFileReference(tree, '_workspace/qa/vystup.docx', ROOT), `${ROOT}/_workspace/qa/vystup.docx`);
  assert.equal(resolveFileReference([], '_workspace/qa/vystup.docx', ROOT), `${ROOT}/_workspace/qa/vystup.docx`);
});

test('a bare name is matched only when exactly one file carries it', () => {
  assert.equal(resolveFileReference(tree, 'only.ts', ROOT), `${ROOT}/src/deep/only.ts`);
  assert.equal(resolveFileReference(tree, 'vystup.docx', ROOT), `${ROOT}/vystup.docx`);
  assert.equal(resolveFileReference(tree, 'none.pdf', ROOT), `${ROOT}/none.pdf`);
});

test('a leading ./ and backslashes are normalised; an absolute path inside the root is kept as given', () => {
  assert.equal(resolveFileReference(tree, './qa/vystup.docx', ROOT), `${ROOT}/qa/vystup.docx`);
  assert.equal(resolveFileReference(tree, 'qa\\vystup.docx', ROOT), `${ROOT}/qa/vystup.docx`);
  assert.equal(resolveFileReference(tree, `${ROOT}/qa/vystup.docx`, ROOT), `${ROOT}/qa/vystup.docx`);
});

test('a leading slash outside the root is read from the project root, never as a path outside it', () => {
  assert.equal(resolveFileReference(tree, '/qa/vystup.docx', ROOT), `${ROOT}/qa/vystup.docx`);
  assert.equal(resolveFileReference(tree, '/etc/passwd', ROOT), `${ROOT}/etc/passwd`);
  assert.equal(resolveFileReference(tree, '//only.ts', ROOT), `${ROOT}/only.ts`);
});

test('an explicit root link (./name, /name) opens the file at the root, never a visible same-named copy', () => {
  // Chandler P2 (q68-r262): the gitignored new output sits at the root, the tree only has the old copy.
  const visibleOld = [{ name: 'report.docx', path: `${ROOT}/old/report.docx` }];
  assert.equal(resolveFileReference(visibleOld, './report.docx', ROOT), `${ROOT}/report.docx`);
  assert.equal(resolveFileReference(visibleOld, '/report.docx', ROOT), `${ROOT}/report.docx`);
  assert.equal(resolveFileReference(visibleOld, '././report.docx', ROOT), `${ROOT}/report.docx`);
  assert.equal(resolveFileReference(visibleOld, './/report.docx', ROOT), `${ROOT}/report.docx`);
  assert.equal(resolveFileReference(visibleOld, '/./report.docx', ROOT), `${ROOT}/report.docx`);
  // A bare name is unchanged: one visible file of that name answers it (Kurt P2-3, known residual).
  assert.equal(resolveFileReference(visibleOld, 'report.docx', ROOT), `${ROOT}/old/report.docx`);
});

test('only a bare name needs the tree; ./name and /name are paths', () => {
  assert.equal(isPathReference('report.docx'), false);
  assert.equal(isPathReference('  report.docx '), false);
  assert.equal(isPathReference('./report.docx'), true);
  assert.equal(isPathReference('/report.docx'), true);
  assert.equal(isPathReference('qa/report.docx'), true);
  assert.equal(isPathReference('qa\\report.docx'), true);
});

test('a path leaving the root is passed on literally for the server to refuse (403), never re-matched', () => {
  assert.equal(resolveFileReference(tree, '../other/vystup.docx', ROOT), `${ROOT}/../other/vystup.docx`);
});

test('without a known root the path stays relative (the server resolves it against the project root)', () => {
  assert.equal(resolveFileReference(tree, 'qa/vystup.docx'), 'qa/vystup.docx');
  assert.equal(resolveFileReference(tree, '', ROOT), null);
});
