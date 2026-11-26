import assert from 'node:assert/strict';
import path from 'node:path';

import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { CodeEditorFile, Project } from '@/shared/types';

/**
 * Kryton download overlay (plan ccl-r262, K3): from the real chat markdown through
 * the file-open resolver to the download, end to end. A link to an output the agent
 * made must download THAT file's bytes under its name - never a visible file of the
 * same name (the tree is gitignore-filtered) and never anything when the target is
 * missing. Names with diacritics and spaces arrive URL-encoded from react-markdown.
 */

const ROOT = '/home/coder/workspace';
const bytes = (...b: number[]) => new Blob([new Uint8Array(b)]);
// Server side: what the raw content route serves per absolute path. Paths outside the
// root are refused like `resolvePathInsideProject` does (403); unknown ones are 404.
let disk: Map<string, Blob>;
type BlobAnswer = { ok: boolean; status: number; redirected?: boolean; blob: () => Promise<Blob> };
const readFileBlob = vi.fn(async (_projectId: string, filePath: string): Promise<BlobAnswer> => {
  const absolute = filePath.startsWith('/') ? filePath : `${ROOT}/${filePath}`;
  const normalised = path.posix.normalize(absolute);
  if (!normalised.startsWith(`${ROOT}/`)) return { ok: false, status: 403, blob: async () => new Blob() };
  const blob = disk.get(normalised);
  return blob ? { ok: true, status: 200, blob: async () => blob } : { ok: false, status: 404, blob: async () => new Blob() };
});
// The tree the resolver sees: gitignore-filtered, so `_workspace/` is not in it.
const getFiles = vi.fn(async (): Promise<{ ok: boolean; json: () => Promise<unknown[]> }> => ({
  ok: true,
  json: async () => [
    { type: 'directory', name: 'old', path: `${ROOT}/old`, children: [{ type: 'file', name: 'vystup.docx', path: `${ROOT}/old/vystup.docx` }] },
    { type: 'directory', name: 'qa', path: `${ROOT}/qa`, children: [{ type: 'file', name: 'vystup.docx', path: `${ROOT}/qa/vystup.docx` }] },
  ],
}));

vi.mock('@/shared/api', () => ({
  api: { readFile: vi.fn(), saveFile: vi.fn(), readFileBlob, getFiles },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// The chain under test crosses three modules on purpose (chat link -> palette ops -> resolver ->
// editor), so it reaches past their barrels, like useProjectsState.ts does upstream.
const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');
// oxlint-disable-next-line boundaries/dependencies
const { Markdown } = await import('@/modules/chat/transcript/Markdown');
const { PaletteOpsProvider, usePaletteOpsRegister } = await import('@/modules/command-palette');
// oxlint-disable-next-line boundaries/dependencies
const { useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const project = { projectId: 'p1', displayName: 'workspace', fullPath: ROOT } as Project;

function Workspace({ markdown }: { markdown: string }) {
  const [file, setFile] = useState<CodeEditorFile | null>(null);
  const open = useFileOpenResolver(project, (filePath: string) =>
    setFile({ name: filePath.split('/').pop() ?? filePath, path: filePath, projectId: 'p1' }));
  usePaletteOpsRegister({ openFileInEditor: open });
  return (
    <>
      <Markdown>{markdown}</Markdown>
      {file && <CodeEditor file={file} onClose={() => setFile(null)} />}
    </>
  );
}

let downloads: { name: string; blob: Blob }[];
const blobsByUrl = new Map<string, Blob>();

beforeEach(() => {
  disk = new Map([
    [`${ROOT}/old/vystup.docx`, bytes(0x50, 0x4b, 0x01)],
    [`${ROOT}/qa/vystup.docx`, bytes(0x50, 0x4b, 0x02)],
    [`${ROOT}/_workspace/qa/vystup.docx`, bytes(0x50, 0x4b, 0x03, 0xff)],
    [`${ROOT}/_workspace/qa/QA výstup.xlsx`, bytes(0x50, 0x4b, 0x04, 0x80)],
  ]);
  downloads = [];
  blobsByUrl.clear();
  let nextUrl = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test/${nextUrl++}`;
    blobsByUrl.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download, blob: blobsByUrl.get(this.href)! });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  readFileBlob.mockClear();
  getFiles.mockClear();
});

async function downloadVia(markdown: string, linkText: string) {
  render(<PaletteOpsProvider><Workspace markdown={markdown} /></PaletteOpsProvider>);
  fireEvent.click(screen.getByText(linkText));
  const buttons = await screen.findAllByRole('button', { name: 'Download original file' });
  await act(async () => {
    fireEvent.click(buttons.at(-1)!);
  });
}

// The download must hand over the very blob the route served for THAT path (jsdom's
// Blob cannot be read back, and identity is the stronger claim: nothing rebuilt it).
const sameBytes = async (a: Blob, b: Blob) => assert.equal(a, b);

test('a link to a gitignored output downloads that output, not a visible file of the same name', async () => {
  await downloadVia('Hotovo: [výstup](_workspace/qa/vystup.docx)', 'výstup');
  await waitFor(() => assert.equal(downloads.length, 1));
  assert.deepEqual(readFileBlob.mock.calls.map((c) => c[1]), [`${ROOT}/_workspace/qa/vystup.docx`]);
  assert.equal(downloads[0].name, 'vystup.docx');
  await sameBytes(downloads[0].blob, disk.get(`${ROOT}/_workspace/qa/vystup.docx`)!);
});

test('of two same-named copies the linked one is downloaded', async () => {
  await downloadVia('[stará](old/vystup.docx)', 'stará');
  await waitFor(() => assert.equal(downloads.length, 1));
  await sameBytes(downloads[0].blob, disk.get(`${ROOT}/old/vystup.docx`)!);
});

test('a missing target with a same-named visible file is an error, not that other file', async () => {
  disk.delete(`${ROOT}/_workspace/qa/vystup.docx`);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await downloadVia('[chybí](_workspace/qa/vystup.docx)', 'chybí');
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Could not download/);
  assert.equal(downloads.length, 0);
});

test('a name with diacritics and a space (URL-encoded by markdown) is found and keeps its name', async () => {
  await downloadVia('[tabulka](<_workspace/qa/QA výstup.xlsx>)', 'tabulka');
  await waitFor(() => assert.equal(downloads.length, 1));
  assert.equal(downloads[0].name, 'QA výstup.xlsx');
  await sameBytes(downloads[0].blob, disk.get(`${ROOT}/_workspace/qa/QA výstup.xlsx`)!);
});

test('a link leaving the project root downloads nothing', async () => {
  disk.set('/home/coder/secret.zip', bytes(1, 2, 3));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await downloadVia('[ven](../secret.zip)', 'ven');
  await screen.findByRole('alert');
  assert.equal(downloads.length, 0);
});

test('a literal percent sign in a name survives the decoding (markdown escapes it as %25)', async () => {
  disk.set(`${ROOT}/out/100%zz.zip`, bytes(9, 9));
  await downloadVia('[procenta](out/100%zz.zip)', 'procenta');
  await waitFor(() => assert.equal(downloads.length, 1));
  assert.deepEqual(readFileBlob.mock.calls.map((c) => c[1]), [`${ROOT}/out/100%zz.zip`]);
  assert.equal(downloads[0].name, '100%zz.zip');
});

test('the card shows the full path of the file the button saves', async () => {
  await downloadVia('[stará](old/vystup.docx)', 'stará');
  assert.equal(screen.getByTestId('binary-file-path').textContent, `${ROOT}/old/vystup.docx`);
});

test('a bare name is re-checked against a fresh tree: a second file of that name makes it ambiguous', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const one = { type: 'file', name: 'jediny.docx', path: `${ROOT}/a/jediny.docx` };
    const two = { type: 'file', name: 'jediny.docx', path: `${ROOT}/b/jediny.docx` };
    getFiles.mockImplementationOnce(async () => ({ ok: true, json: async () => [one] }));
    getFiles.mockImplementationOnce(async () => ({ ok: true, json: async () => [one, two] }));
    disk.set(`${ROOT}/a/jediny.docx`, bytes(7));
    render(<PaletteOpsProvider><Workspace markdown={'[jen jméno](jediny.docx)'} /></PaletteOpsProvider>);
    fireEvent.click(screen.getByText('jen jméno'));
    await waitFor(() => assert.equal(screen.getByTestId('binary-file-path').textContent, `${ROOT}/a/jediny.docx`));
    await vi.advanceTimersByTimeAsync(31_000);
    fireEvent.click(screen.getByText('jen jméno'));
    await waitFor(() => assert.equal(screen.getByTestId('binary-file-path').textContent, `${ROOT}/jediny.docx`));
    assert.equal(getFiles.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test('an expired session (redirect to the sign-in page, ending 200 HTML) downloads nothing and says so', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  readFileBlob.mockImplementationOnce(async () => ({
    ok: true, status: 200, redirected: true, blob: async () => new Blob(['<!DOCTYPE html><title>Přihlášení</title>'], { type: 'text/html' }),
  }));
  await downloadVia('[výstup](_workspace/qa/vystup.docx)', 'výstup');
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Could not download/);
  assert.equal(downloads.length, 0);
});

test('one stray percent sign does not keep the rest of the name encoded', async () => {
  disk.set(`${ROOT}/out/100%zz výstup.xlsx`, bytes(5, 5));
  await downloadVia('[mix](<out/100%zz výstup.xlsx>)', 'mix');
  await waitFor(() => assert.equal(downloads.length, 1));
  assert.deepEqual(readFileBlob.mock.calls.map((c) => c[1]), [`${ROOT}/out/100%zz výstup.xlsx`]);
  assert.equal(downloads[0].name, '100%zz výstup.xlsx');
});
