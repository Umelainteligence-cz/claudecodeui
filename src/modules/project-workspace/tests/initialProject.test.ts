import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  pickInitialProject,
  readRecentProjectIds,
  rememberProjectId,
  RECENT_PROJECT_IDS_LIMIT,
  RECENT_PROJECT_IDS_STORAGE_KEY,
} from '@/modules/project-workspace/utils/initialProject';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * Which project opens by itself when nothing is selected.
 *
 * Upstream used to auto-select only when exactly one project existed, so anyone
 * with two or more projects landed on "choose a project" - no header, no tabs,
 * no composer - after every load.
 */

const buildProject = (id: string, overrides: Partial<Project> = {}): Project => ({
  projectId: id,
  path: `/repos/${id}`,
  fullPath: `/repos/${id}`,
  displayName: id,
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
  ...overrides,
});

const session = (id: string, lastActivity: string): ProjectSession => ({
  id,
  summary: id,
  lastActivity,
  updated_at: lastActivity,
  createdAt: lastActivity,
});

const alpha = buildProject('alpha', { displayName: 'alpha', sessions: [session('a1', '2026-01-01T00:00:00Z')] });
const bravo = buildProject('bravo', { displayName: 'bravo', sessions: [session('b1', '2026-03-01T00:00:00Z')] });
const charlie = buildProject('charlie', { displayName: 'charlie', sessions: [session('c1', '2026-02-01T00:00:00Z')] });
const delta = buildProject('delta', { displayName: 'delta' });
const echo = buildProject('echo', { displayName: 'echo' });

// ---------------------------------------------------------------------------
// The pure rule.
// ---------------------------------------------------------------------------

type Case = {
  name: string;
  projects: Project[];
  recent: string[];
  order: 'name' | 'date';
  expected: string | null;
};

const cases: Case[] = [
  { name: 'no projects', projects: [], recent: [], order: 'name', expected: null },
  { name: 'one project, nothing remembered', projects: [alpha], recent: [], order: 'name', expected: 'alpha' },
  { name: 'two projects, nothing remembered -> first by name', projects: [bravo, alpha], recent: [], order: 'name', expected: 'alpha' },
  { name: 'two projects, remembered hit', projects: [alpha, bravo], recent: ['bravo'], order: 'name', expected: 'bravo' },
  { name: 'five projects, remembered hit', projects: [alpha, bravo, charlie, delta, echo], recent: ['delta'], order: 'name', expected: 'delta' },
  { name: 'remembered miss falls through to the next remembered id', projects: [alpha, bravo, charlie], recent: ['gone', 'charlie', 'bravo'], order: 'name', expected: 'charlie' },
  { name: 'only ids from another installation -> first in sidebar order', projects: [charlie, bravo], recent: ['other-1', 'other-2'], order: 'name', expected: 'bravo' },
  { name: 'five projects, date order -> most recent activity', projects: [alpha, bravo, charlie, delta, echo], recent: [], order: 'date', expected: 'bravo' },
  { name: 'starred first (name order)', projects: [alpha, bravo, { ...echo, isStarred: true }], recent: [], order: 'name', expected: 'echo' },
  { name: 'starred first (date order)', projects: [alpha, bravo, { ...delta, isStarred: true }], recent: [], order: 'date', expected: 'delta' },
  { name: 'remembered beats starred', projects: [alpha, { ...echo, isStarred: true }], recent: ['alpha'], order: 'name', expected: 'alpha' },
];

for (const c of cases) {
  test(`pickInitialProject: ${c.name}`, () => {
    const picked = pickInitialProject(c.projects, c.recent, c.order);
    assert.equal(picked?.projectId ?? null, c.expected);
  });
}

test('pickInitialProject does not reorder the caller\'s array', () => {
  const projects = [charlie, bravo, alpha];
  pickInitialProject(projects, [], 'name');
  assert.deepEqual(projects.map((p) => p.projectId), ['charlie', 'bravo', 'alpha']);
});

// ---------------------------------------------------------------------------
// The remembered list.
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

test('rememberProjectId keeps ids only, newest first, deduplicated and capped', () => {
  for (let i = 0; i < RECENT_PROJECT_IDS_LIMIT + 3; i += 1) {
    rememberProjectId(`p${i}`);
  }
  rememberProjectId('p5');
  const ids = readRecentProjectIds();
  assert.equal(ids.length, RECENT_PROJECT_IDS_LIMIT);
  assert.equal(ids[0], 'p5');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('p0'), 'the oldest ids fall off the end');
});

test('an unreadable remembered value is ignored and then overwritten', () => {
  for (const raw of ['not json', '{"a":1}', '"a string"', '[1, null, ""]']) {
    localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, raw);
    assert.deepEqual(readRecentProjectIds(), [], raw);
    rememberProjectId('fresh');
    assert.deepEqual(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? 'null'), ['fresh'], raw);
    localStorage.clear();
  }
});

test('a throwing localStorage reads as nothing remembered and never throws on write', () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  assert.deepEqual(readRecentProjectIds(), []);
  assert.doesNotThrow(() => rememberProjectId('x'));
  getItem.mockRestore();
  setItem.mockRestore();
});

// ---------------------------------------------------------------------------
// The hook, against a stubbed `fetch` (no `api` mock), so every request it
// makes is visible.
// ---------------------------------------------------------------------------

type ServerEventListener = (event: { kind: string }) => void;
const listeners = new Set<ServerEventListener>();
let projectsPayload: Project[] = [];
let sessionDetailsPayload: unknown = null;
/** When set, the project list answers only after this promise settles. */
let projectsGate: Promise<void> | null = null;
/** When set, the session lookup answers only after this promise settles. */
let sessionGate: Promise<void> | null = null;
const requests: Array<{ method: string; url: string }> = [];

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event as { kind: string });
  }
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  listeners.clear();
  requests.length = 0;
  sessionDetailsPayload = null;
  projectsGate = null;
  sessionGate = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    if (url.startsWith('/api/projects') && !url.includes('/taskmaster')) {
      if (projectsGate) {
        await projectsGate;
      }
      return jsonResponse(projectsPayload);
    }
    if (url.startsWith('/api/providers/sessions/') && sessionDetailsPayload) {
      if (sessionGate) {
        await sessionGate;
      }
      return jsonResponse(sessionDetailsPayload);
    }
    return jsonResponse({}, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let renderCount = 0;

const renderProjectsState = async (sessionId?: string, { strict = false } = {}) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(
    (props: { sessionId?: string }) => {
      renderCount += 1;
      return useProjectsState({
        sessionId: props.sessionId,
        navigate: vi.fn(),
        subscribe: (listener: ServerEventListener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        isMobile: false,
        isSessionProcessing: () => false,
      });
    },
    {
      initialProps: { sessionId },
      ...(strict ? { wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) } : {}),
    },
  );
};

test('with two projects and nothing remembered the hook opens the first in sidebar order', async () => {
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
});

test('with five projects the remembered one opens', async () => {
  projectsPayload = [alpha, bravo, charlie, delta, echo];
  localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(['charlie']));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'charlie'));
});

test('a session id in the URL suppresses the auto-selection', async () => {
  projectsPayload = [alpha, bravo];
  const { result } = await renderProjectsState('unknown-session');
  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(result.current.selectedProject, null);
});

test('a throwing localStorage still lands in a project', async () => {
  projectsPayload = [bravo, alpha];
  const realGetItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key === RECENT_PROJECT_IDS_STORAGE_KEY) {
      throw new Error('denied');
    }
    return realGetItem.call(this, key);
  });
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
});

test('opening a project remembers its id - and only its id', async () => {
  const secret = buildProject('5f0c2a3e-0000-4000-8000-000000000001', {
    path: '/home/someone/clients/novak-dedictvi',
    fullPath: '/home/someone/clients/novak-dedictvi',
    displayName: 'novak-dedictvi',
  });
  projectsPayload = [alpha, secret];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.ok(result.current.selectedProject));

  act(() => {
    result.current.handleProjectSelect(secret);
  });
  await waitFor(() => assert.equal(readRecentProjectIds()[0], secret.projectId));

  const raw = localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) ?? '';
  for (const segment of secret.fullPath.split('/').filter(Boolean)) {
    assert.ok(!raw.includes(segment), `the stored value must not contain the path segment "${segment}"`);
  }
  assert.ok(!raw.includes(secret.displayName));
});

test('archiving the open project opens the next one and keeps the remembered list', async () => {
  projectsPayload = [alpha, bravo, charlie];
  localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(['bravo']));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));

  act(() => {
    result.current.sidebarSharedProps.onProjectDelete('bravo');
  });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  assert.ok(readRecentProjectIds().includes('bravo'), 'the archived id stays; it is skipped while archived');
});

test('the hook only ever reads: every request it makes is a GET', async () => {
  projectsPayload = [alpha, bravo, charlie];
  localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(['charlie']));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'charlie'));
  act(() => {
    result.current.handleProjectSelect(alpha);
  });
  await waitFor(() => assert.equal(readRecentProjectIds()[0], 'alpha'));

  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.method, 'GET', `${request.method} ${request.url}`);
  }
});

test('the auto-selection itself is not remembered', async () => {
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('a refresh of the project list does not move the open project back to the front', async () => {
  // A tab left open in the background receives every session upsert. Before the
  // fix each one re-wrote its own project to the front of the remembered list.
  projectsPayload = [alpha, bravo];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.ok(result.current.selectedProject));
  act(() => {
    result.current.handleProjectSelect(bravo);
  });
  await waitFor(() => assert.equal(readRecentProjectIds()[0], 'bravo'));

  // Another tab opened alpha meanwhile.
  localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(['alpha', 'bravo']));
  act(() => {
    emit({
      kind: 'session_upserted',
      sessionId: 'b2',
      provider: 'claude',
      session: { id: 'b2', summary: 'b2', lastActivity: '2026-04-01T00:00:00Z' },
      project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo', isStarred: false },
      timestamp: '2026-04-01T00:00:00Z',
    });
  });
  await waitFor(() => assert.ok(
    result.current.projects.find((p) => p.projectId === 'bravo')?.sessions?.some((x) => x.id === 'b2'),
  ));
  assert.deepEqual(readRecentProjectIds(), ['alpha', 'bravo']);
});

test('an archived project opened through /session/:id is never remembered', async () => {
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: {
      sessionId: 'old-session',
      provider: 'claude',
      summary: 'old',
      project: { projectId: 'archived-1', path: '/repos/archived', fullPath: '/repos/archived', displayName: 'archived' },
    },
  };
  const { result } = await renderProjectsState('old-session');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'archived-1'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('selecting the project the auto-selection already opened is remembered', async () => {
  // The selection does not change, so only the handler can see it (on mobile a
  // conversation in the sidebar goes through it, and so does a new worktree).
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.handleProjectSelect(alpha);
  });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha']));
});

test('"new session" on the auto-selected project\'s row in the sidebar is remembered', async () => {
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.sidebarSharedProps.onNewSession(alpha);
  });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha']));
});

test('"new session" from the command palette does not remember the auto-selected project', async () => {
  // The palette acts on whatever project is open; the auto-selection opened
  // this one, nobody picked it. A project the user did pick is remembered by
  // that pick already.
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.handleNewSession(alpha);
  });
  await waitFor(() => assert.equal(result.current.newSessionTrigger, 1));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('coming back to the auto-selected project through a clicked conversation is remembered', async () => {
  // Auto-selection opens alpha, a conversation of bravo opens bravo, a
  // conversation of alpha opens alpha again: both clicks are the user's,
  // even though alpha was once the auto-selection.
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ ...bravo.sessions![0], __projectId: 'bravo' });
  });
  rerender({ sessionId: 'b1' });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['bravo']));
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ ...alpha.sessions![0], __projectId: 'alpha' });
  });
  rerender({ sessionId: 'a1' });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha', 'bravo']));
});

test('a /session/:id link opens its project and remembers nothing, even when its lookup answers before the project list', async () => {
  // Review D (5. 10. 2026) P2-1: a reload of /session/:id is how the first
  // message in an auto-selected project became a remembered one. A link opens
  // the conversation's project; only a click makes it the user's choice.
  let releaseProjects: () => void = () => {};
  projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: {
      sessionId: 'b-old',
      provider: 'claude',
      summary: 'b-old',
      project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo' },
    },
  };
  const { result } = await renderProjectsState('b-old');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));
  assert.equal(result.current.projects.length, 0, 'the lookup answered first');

  releaseProjects();
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  await sleep(50);
  assert.equal(result.current.selectedProject?.projectId, 'bravo');
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('a conversation clicked in the auto-selected project is remembered', async () => {
  // On desktop the sidebar selects only the session: the URL changes, the
  // project selection does not. The click is what makes it the user's choice.
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ ...alpha.sessions![0], __projectId: 'alpha' });
  });
  rerender({ sessionId: 'a1' });
  await waitFor(() => assert.equal(result.current.selectedSession?.id, 'a1'));
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha']));
});

// ---------------------------------------------------------------------------
// Verification review C (5. 10. 2026): cases C1-C10 and the mutation gaps.
// ---------------------------------------------------------------------------

test('C2: the first message in the auto-selected project does not remember it', async () => {
  // The "new session" page selects a session as soon as the first message is
  // sent (registerOptimisticSession -> selected session, then /session/:id).
  // Nobody chose the project: it is the one the auto-selection opened.
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.registerOptimisticSession({ sessionId: 'new-1', provider: 'claude', project: alpha });
  });
  await waitFor(() => assert.equal(result.current.selectedSession?.id, 'new-1'));
  rerender({ sessionId: 'new-1' });
  await sleep(50);
  assert.equal(result.current.selectedProject?.projectId, 'alpha');
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('C1: a conversation of ANOTHER project remembers only that project', async () => {
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ ...bravo.sessions![0], __projectId: 'bravo' });
  });
  rerender({ sessionId: 'b1' });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));
  await sleep(50);
  assert.deepEqual(readRecentProjectIds(), ['bravo']);
});

test('C10: a conversation whose project no longer exists remembers nothing', async () => {
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ id: 'zz', summary: 'zz', __projectId: 'gone-project' });
  });
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('C3: a pick while a /session lookup is pending is the only thing remembered', async () => {
  projectsPayload = [alpha, bravo];
  let releaseSession: () => void = () => {};
  sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  sessionDetailsPayload = {
    data: { sessionId: 'old', provider: 'claude', summary: 'old', project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo' } },
  };
  const { result, rerender } = await renderProjectsState('old');
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  act(() => {
    result.current.handleProjectSelect(alpha);
  });
  rerender({ sessionId: undefined });
  releaseSession();
  await sleep(80);
  assert.equal(result.current.selectedProject?.projectId, 'alpha');
  assert.deepEqual(readRecentProjectIds(), ['alpha']);
});

test('C4: two tabs - a background tab never writes, a pick in one tab does not move the other', async () => {
  projectsPayload = [bravo, alpha];
  const a = await renderProjectsState();
  const b = await renderProjectsState();
  await waitFor(() => assert.equal(a.result.current.selectedProject?.projectId, 'alpha'));
  await waitFor(() => assert.equal(b.result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    b.result.current.handleProjectSelect(bravo);
  });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['bravo']));
  act(() => {
    emit({
      kind: 'session_upserted',
      sessionId: 'a2',
      provider: 'claude',
      session: { id: 'a2', summary: 'a2', lastActivity: '2026-05-01T00:00:00Z' },
      project: { projectId: 'alpha', path: alpha.path, fullPath: alpha.fullPath, displayName: 'alpha', isStarred: false },
      timestamp: '2026-05-01T00:00:00Z',
    });
  });
  await sleep(50);
  assert.deepEqual(readRecentProjectIds(), ['bravo']);
  assert.equal(a.result.current.selectedProject?.projectId, 'alpha', 'tab A keeps its own selection');
});

test('C5: a remembered project that no longer exists is skipped and left as it is', async () => {
  projectsPayload = [bravo, alpha];
  localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(['gone']));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await sleep(50);
  assert.deepEqual(readRecentProjectIds(), ['gone']);
});

test('C6: under StrictMode the auto-selection is still not remembered', async () => {
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState(undefined, { strict: true });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await sleep(80);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('C7: renders settle after the auto-selection (no render loop)', async () => {
  projectsPayload = [bravo, alpha];
  renderCount = 0;
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await sleep(100);
  const settled = renderCount;
  await sleep(300);
  assert.equal(renderCount, settled, `renders kept growing: ${settled} -> ${renderCount}`);
});

test('C8: a /session link is written neither when the list arrives nor by a later refresh', async () => {
  let releaseProjects: () => void = () => {};
  projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: { sessionId: 'b-old', provider: 'claude', summary: 'b-old', project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo' } },
  };
  const { result } = await renderProjectsState('b-old');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));
  releaseProjects();
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  act(() => {
    emit({
      kind: 'session_upserted',
      sessionId: 'b9',
      provider: 'claude',
      session: { id: 'b9', summary: 'b9', lastActivity: '2026-05-01T00:00:00Z' },
      project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo', isStarred: false },
      timestamp: '2026-05-01T00:00:00Z',
    });
  });
  await waitFor(() => assert.ok(
    result.current.projects.find((p) => p.projectId === 'bravo')?.sessions?.some((x) => x.id === 'b9'),
  ));
  await act(async () => {
    await result.current.refreshProjectsSilently();
  });
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('C9: an archived project opened through /session before the list is never remembered and stays selected', async () => {
  let releaseProjects: () => void = () => {};
  projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: { sessionId: 'old', provider: 'claude', summary: 'old', project: { projectId: 'arch', path: '/repos/arch', fullPath: '/repos/arch', displayName: 'arch' } },
  };
  const { result } = await renderProjectsState('old');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'arch'));
  releaseProjects();
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  assert.equal(result.current.selectedProject?.projectId, 'arch', 'the selection is not overridden');
});

test('an archived project left for another one is not remembered when it comes back from the archive', async () => {
  // /session/:id of an archived project waits for the list; the user then
  // opens alpha. If the archived project is restored later, the old wait must
  // not write it to the front of the list.
  let releaseProjects: () => void = () => {};
  projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: { sessionId: 'old', provider: 'claude', summary: 'old', project: { projectId: 'arch', path: '/repos/arch', fullPath: '/repos/arch', displayName: 'arch' } },
  };
  const { result, rerender } = await renderProjectsState('old');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'arch'));
  releaseProjects();
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  act(() => {
    result.current.handleProjectSelect(alpha);
  });
  rerender({ sessionId: undefined });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha']));

  projectsPayload = [alpha, bravo, buildProject('arch')];
  await act(async () => {
    await result.current.refreshProjectsSilently();
  });
  assert.equal(result.current.projects.length, 3);
  await sleep(50);
  assert.deepEqual(readRecentProjectIds(), ['alpha']);
});

test('a project outside the active list is not remembered through a handler either', async () => {
  // The sidebar's archive opens an archived project through handleProjectSelect.
  projectsPayload = [bravo, alpha];
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.handleProjectSelect(buildProject('arch'));
  });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'arch'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('a conversation without a project tag clicked while no project is open neither throws nor remembers', async () => {
  // A /session/:id of an unknown session leaves nothing selected; a forked or
  // searched conversation may carry no project id.
  projectsPayload = [alpha, bravo];
  const { result } = await renderProjectsState('unknown-session');
  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));
  assert.equal(result.current.selectedProject, null);
  assert.doesNotThrow(() => {
    act(() => {
      result.current.sidebarSharedProps.onSessionSelect({ id: 'untagged', summary: 'untagged' });
    });
  });
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

// ---------------------------------------------------------------------------
// Verification review D (5. 10. 2026), P2-1: the invariant. Two reviews in a
// row found a different way the auto-selection reached the remembered list
// (an effect over the selected session, then a reload of /session/:id). So the
// rule is pinned as a rule: the list is written only from the handlers of an
// explicit act in the sidebar - never on load, in an effect, on a refresh of
// the list or from a `/session/:id` URL.
// ---------------------------------------------------------------------------

const HOOK_SOURCE = path.resolve(__dirname, '../hooks/useProjectsState.ts');
/** The only handlers allowed to write the remembered list (through rememberUserChoice). */
const REMEMBERING_HANDLERS = ['handleProjectSelect', 'handleSessionSelect', 'handleSidebarNewSession'];

/** Name of the `const <name> = ...` declaration (at hook level) that encloses `index`. */
const enclosingDeclaration = (source: string, index: number): string | null => {
  const declarations = [...source.slice(0, index).matchAll(/^ {2}const (\w+) = /gm)];
  return declarations.length > 0 ? declarations[declarations.length - 1][1] : null;
};

test('invariant: the remembered list is written from one function, called only from the named handlers', () => {
  const source = fs.readFileSync(HOOK_SOURCE, 'utf8');

  const writes = [...source.matchAll(/\brememberProjectId\(/g)];
  assert.equal(writes.length, 1, 'rememberProjectId is called exactly once in the hook');
  assert.equal(enclosingDeclaration(source, writes[0].index!), 'rememberUserChoice');

  const callers = [...source.matchAll(/\brememberUserChoice\(/g)]
    .map((match) => enclosingDeclaration(source, match.index!));
  assert.deepEqual(callers.sort(), [...REMEMBERING_HANDLERS].sort(),
    'a new caller of rememberUserChoice needs a decision, not just a test update: is it an explicit act of the user?');

  for (const name of REMEMBERING_HANDLERS) {
    assert.match(source, new RegExp(`^ {2}const ${name} = useCallback\\(`, 'm'), `${name} is a useCallback handler`);
  }
  // No effect may reach the write, not even through a helper.
  for (const effect of source.matchAll(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[/g)) {
    assert.ok(!/remember(UserChoice|ProjectId)/.test(effect[0]), `an effect touches the remembered list:\n${effect[0].slice(0, 200)}`);
  }
  // The handlers reach the sidebar; the command palette gets the non-remembering one.
  assert.match(source, /onProjectSelect: handleProjectSelect,/);
  assert.match(source, /onSessionSelect: handleSessionSelect,/);
  assert.match(source, /onNewSession: handleSidebarNewSession,/);
});

test('invariant: nothing else in src writes the remembered list', () => {
  const root = path.resolve(__dirname, '../../..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const rel = path.relative(root, full).split(path.sep).join('/');
        const allowed = rel === 'modules/project-workspace/utils/initialProject.ts' // defines the reader and the writer
          || rel === 'modules/project-workspace/hooks/useProjectsState.ts'; // the one call, pinned above
        if (!allowed && (/\brememberProjectId\b|RECENT_PROJECT_IDS_STORAGE_KEY/.test(text) || /['"]recentProjectIds['"]/.test(text))) {
          offenders.push(rel);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test('D1: reload of /session/:id after the first message in the auto-selected project remembers nothing', async () => {
  // The first message moved the URL to /session/new-1; F5 loads exactly that.
  const alphaWithNew = { ...alpha, sessions: [session('new-1', '2026-10-05T10:00:00Z'), ...alpha.sessions!] };
  projectsPayload = [bravo, alphaWithNew];
  const { result } = await renderProjectsState('new-1');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await waitFor(() => assert.equal(result.current.selectedSession?.id, 'new-1'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('D2: a URL change alone (no click) selects the conversation\'s project and remembers nothing', async () => {
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  rerender({ sessionId: 'b1' });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));
  rerender({ sessionId: 'a1' });
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('D3: the first message, then upserts and a refresh of the list, remember nothing', async () => {
  projectsPayload = [bravo, alpha];
  const { result, rerender } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  act(() => {
    result.current.registerOptimisticSession({ sessionId: 'new-2', provider: 'claude', project: alpha });
  });
  rerender({ sessionId: 'new-2' });
  act(() => {
    emit({
      kind: 'session_upserted',
      sessionId: 'new-2',
      provider: 'claude',
      session: { id: 'new-2', summary: 'new-2', lastActivity: '2026-10-05T10:00:00Z' },
      project: { projectId: 'alpha', path: alpha.path, fullPath: alpha.fullPath, displayName: 'alpha', isStarred: false },
      timestamp: '2026-10-05T10:00:00Z',
    });
  });
  projectsPayload = [bravo, { ...alpha, sessions: [session('new-2', '2026-10-05T10:00:00Z'), ...alpha.sessions!] }];
  await act(async () => {
    await result.current.refreshProjectsSilently();
  });
  await sleep(50);
  assert.equal(result.current.selectedProject?.projectId, 'alpha');
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('D4: a second tab on the root and the first tab on /session write nothing', async () => {
  const alphaWithNew = { ...alpha, sessions: [session('new-3', '2026-10-05T10:00:00Z'), ...alpha.sessions!] };
  projectsPayload = [bravo, alphaWithNew];
  const first = await renderProjectsState('new-3');
  const second = await renderProjectsState();
  await waitFor(() => assert.equal(first.result.current.selectedProject?.projectId, 'alpha'));
  await waitFor(() => assert.equal(second.result.current.selectedProject?.projectId, 'alpha'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});

test('D5: after a link opened the project, a click in it is what remembers it', async () => {
  const alphaWithNew = { ...alpha, sessions: [session('new-4', '2026-10-05T10:00:00Z'), ...alpha.sessions!] };
  projectsPayload = [bravo, alphaWithNew];
  const { result } = await renderProjectsState('new-4');
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'alpha'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
  act(() => {
    result.current.sidebarSharedProps.onSessionSelect({ ...alphaWithNew.sessions[1], __projectId: 'alpha' });
  });
  await waitFor(() => assert.deepEqual(readRecentProjectIds(), ['alpha']));
});

test('D6: a link to an older conversation (looked up after the list arrived) remembers nothing', async () => {
  // The sessions of each project are paginated, so an older conversation is
  // not in the list and the hook asks the backend; the answer names a project
  // that IS in the active list.
  let releaseSession: () => void = () => {};
  sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  projectsPayload = [alpha, bravo];
  sessionDetailsPayload = {
    data: { sessionId: 'b-older', provider: 'claude', summary: 'b-older', project: { projectId: 'bravo', path: bravo.path, fullPath: bravo.fullPath, displayName: 'bravo' } },
  };
  const { result } = await renderProjectsState('b-older');
  await waitFor(() => assert.equal(result.current.projects.length, 2));
  releaseSession();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'bravo'));
  await sleep(50);
  assert.equal(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY), null);
});
