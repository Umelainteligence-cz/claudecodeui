import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  pickInitialProject,
  PREFERRED_PROJECT_PATH,
  RECENT_PROJECT_IDS_STORAGE_KEY,
} from '@/modules/project-workspace/utils/initialProject';
import type { Project } from '@/shared/types';

/**
 * KRYTON OVERLAY: the workspace root (`/home/coder/workspace`) opens when
 * nothing this browser remembers is an active project, before the sidebar's
 * first project.
 */

const buildProject = (id: string, fullPath: string, overrides: Partial<Project> = {}): Project => ({
  projectId: id,
  path: fullPath,
  fullPath,
  displayName: fullPath.split('/').filter(Boolean).pop() ?? fullPath,
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
  ...overrides,
});

const tmp = buildProject('id-tmp', '/tmp');
const workspace = buildProject('id-workspace', PREFERRED_PROJECT_PATH);
const aaa = buildProject('id-aaa', '/home/coder/workspace/aaa');
const repo = buildProject('id-repo', '/home/coder/repo');
const probe = buildProject('id-probe', '/tmp/probe298/proj');
const other = buildProject('id-other', '/srv/other');

type Case = { name: string; projects: Project[]; recent: string[]; expected: string };

const cases: Case[] = [
  { name: 'the constant is the workspace root', projects: [workspace], recent: [], expected: 'id-workspace' },
  { name: 'two projects, clean profile -> workspace', projects: [tmp, workspace], recent: [], expected: 'id-workspace' },
  { name: 'created in the order /tmp, workspace -> workspace', projects: [tmp, workspace], recent: [], expected: 'id-workspace' },
  { name: 'workspace is not the first by name -> still workspace', projects: [aaa, workspace, tmp], recent: [], expected: 'id-workspace' },
  { name: 'remembered /tmp -> /tmp', projects: [tmp, workspace], recent: ['id-tmp'], expected: 'id-tmp' },
  { name: 'only ids from another workspace -> workspace', projects: [tmp, workspace], recent: ['foreign-1', 'foreign-2'], expected: 'id-workspace' },
  { name: 'remembered project archived -> workspace', projects: [tmp, workspace, aaa, repo, other], recent: ['id-probe'], expected: 'id-workspace' },
  { name: 'workspace stored with a trailing slash', projects: [tmp, buildProject('id-ws-slash', `${PREFERRED_PROJECT_PATH}/`)], recent: [], expected: 'id-ws-slash' },
  { name: 'a starred project does not beat workspace', projects: [{ ...tmp, isStarred: true }, workspace], recent: [], expected: 'id-workspace' },
  { name: 'a subdirectory of workspace is not workspace', projects: [aaa, tmp], recent: [], expected: 'id-aaa' },
  { name: 'five projects without workspace -> first in sidebar order', projects: [tmp, probe, other, repo, aaa], recent: [], expected: 'id-aaa' },
  { name: 'five without workspace, a starred one -> the starred one', projects: [tmp, probe, other, { ...repo, isStarred: true }, aaa], recent: [], expected: 'id-repo' },
];

for (const c of cases) {
  test(`workspace root: ${c.name}`, () => {
    assert.equal(pickInitialProject(c.projects, c.recent, 'name')?.projectId, c.expected);
  });
}

test('workspace root: date order does not beat workspace either', () => {
  const busy = buildProject('id-busy', '/tmp', {
    sessions: [{ id: 's', summary: 's', lastActivity: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' }],
  });
  assert.equal(pickInitialProject([busy, workspace], [], 'date')?.projectId, 'id-workspace');
});

// ---------------------------------------------------------------------------
// The hook.
// ---------------------------------------------------------------------------

type ServerEventListener = (event: { kind: string }) => void;
let projectsPayload: Project[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/projects') && !url.includes('/taskmaster')) {
      return new Response(JSON.stringify(projectsPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const renderProjectsState = async (sessionId?: string) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() =>
    useProjectsState({
      sessionId,
      navigate: vi.fn(),
      subscribe: (_listener: ServerEventListener) => () => undefined,
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

test('workspace root: a throwing localStorage still opens workspace', async () => {
  projectsPayload = [tmp, workspace];
  const realGetItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key === RECENT_PROJECT_IDS_STORAGE_KEY) {
      throw new Error('denied');
    }
    return realGetItem.call(this, key);
  });
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'id-workspace'));
});

test('workspace root: the hook opens workspace with two projects and a clean profile', async () => {
  projectsPayload = [tmp, workspace];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'id-workspace'));
});

test('workspace root: a first list without workspace selects /tmp once - the next load opens workspace', async () => {
  // Measured 5. 10. 2026 (plan Krok 1a, V4): when the first `/api/projects`
  // answer has only /tmp and workspace is created after the client loaded,
  // /tmp opens. The selection is made once; a later refresh that brings
  // workspace does not take the project away from under the user. It is not
  // remembered either, so the NEXT load follows the rules again.
  projectsPayload = [tmp];
  const first = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'id-tmp'));

  projectsPayload = [tmp, workspace];
  await act(async () => {
    await first.result.current.refreshProjectsSilently();
  });
  assert.equal(first.result.current.projects.length, 2);
  assert.equal(first.result.current.selectedProject?.projectId, 'id-tmp');
  first.unmount();
  vi.resetModules();

  const next = await renderProjectsState();
  await waitFor(() => assert.equal(next.result.current.selectedProject?.projectId, 'id-workspace'));
});

test('workspace root: a project the user opened wins over workspace on the next load', async () => {
  projectsPayload = [tmp, workspace];
  const first = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'id-workspace'));
  act(() => {
    first.result.current.handleProjectSelect(tmp);
  });
  await waitFor(() => assert.equal(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? '[]')[0], 'id-tmp'));
  first.unmount();
  vi.resetModules();

  const next = await renderProjectsState();
  await waitFor(() => assert.equal(next.result.current.selectedProject?.projectId, 'id-tmp'));
});

test('workspace root: typing the first message in the /tmp the first list opened does not keep /tmp (V4, review C P2-1)', async () => {
  // The case the operator reported: the workspace has only /tmp when the
  // client loads, the person starts writing on the "new session" page, and
  // workspace is created afterwards. Writing is not a choice of the project:
  // the next load must open workspace.
  projectsPayload = [tmp];
  const first = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'id-tmp'));
  act(() => {
    first.result.current.registerOptimisticSession({ sessionId: 'first-message', provider: 'claude', project: tmp });
  });
  await waitFor(() => assert.equal(first.result.current.selectedSession?.id, 'first-message'));

  projectsPayload = [tmp, workspace];
  await act(async () => {
    await first.result.current.refreshProjectsSilently();
  });
  assert.equal(first.result.current.selectedProject?.projectId, 'id-tmp');
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  first.unmount();
  vi.resetModules();

  const next = await renderProjectsState();
  await waitFor(() => assert.equal(next.result.current.selectedProject?.projectId, 'id-workspace'));
});

test('workspace root: a person who clicks a conversation in that /tmp keeps /tmp on the next load', async () => {
  const tmpWithSession = { ...tmp, sessions: [{ id: 's-tmp', summary: 's-tmp', lastActivity: '2026-10-05T10:00:00Z' }] };
  projectsPayload = [tmpWithSession];
  const first = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'id-tmp'));
  act(() => {
    first.result.current.sidebarSharedProps.onSessionSelect({ ...tmpWithSession.sessions[0], __projectId: 'id-tmp' });
  });
  await waitFor(() => assert.deepEqual(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? '[]'), ['id-tmp']));

  projectsPayload = [tmpWithSession, workspace];
  first.unmount();
  vi.resetModules();
  const next = await renderProjectsState();
  await waitFor(() => assert.equal(next.result.current.selectedProject?.projectId, 'id-tmp'));
});

test('workspace root: first message in that /tmp, then a reload of /session/:id, still opens workspace at the root (V4, review D P2-1)', async () => {
  // After the first message the address is /session/<id>; a reload (F5, a
  // restored tab) loads that address. The link selects /tmp - and remembers
  // nothing, so the next load of the root follows the rules again.
  const tmpWithMessage = { ...tmp, sessions: [{ id: 's-first', summary: 's-first', lastActivity: '2026-10-05T10:00:00Z' }] };
  projectsPayload = [tmpWithMessage, workspace];
  const reloaded = await renderProjectsState('s-first');
  await waitFor(() => assert.equal(reloaded.result.current.selectedProject?.projectId, 'id-tmp'));
  await waitFor(() => assert.equal(reloaded.result.current.selectedSession?.id, 's-first'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  reloaded.unmount();
  vi.resetModules();

  const root = await renderProjectsState();
  await waitFor(() => assert.equal(root.result.current.selectedProject?.projectId, 'id-workspace'));
});

test('workspace root: a person who clicked /tmp keeps it through a reload of /session/:id and at the root', async () => {
  const tmpWithMessage = { ...tmp, sessions: [{ id: 's-tmp2', summary: 's-tmp2', lastActivity: '2026-10-05T10:00:00Z' }] };
  projectsPayload = [tmpWithMessage, workspace];
  const first = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'id-workspace'));
  act(() => {
    first.result.current.handleProjectSelect(tmpWithMessage);
  });
  await waitFor(() => assert.deepEqual(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? '[]'), ['id-tmp']));
  first.unmount();
  vi.resetModules();

  const reloaded = await renderProjectsState('s-tmp2');
  await waitFor(() => assert.equal(reloaded.result.current.selectedProject?.projectId, 'id-tmp'));
  reloaded.unmount();
  vi.resetModules();

  const root = await renderProjectsState();
  await waitFor(() => assert.equal(root.result.current.selectedProject?.projectId, 'id-tmp'));
  assert.deepEqual(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? '[]'), ['id-tmp']);
});
