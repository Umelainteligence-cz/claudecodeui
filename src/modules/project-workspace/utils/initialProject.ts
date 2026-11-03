// The sidebar's own ordering (starred first, then by name or by last activity), imported directly
// rather than through the sidebar barrel, which would pull in the whole Sidebar component tree.
// oxlint-disable-next-line boundaries/dependencies
import { sortProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { Project, ProjectSortOrder } from '@/shared/types';

/**
 * Which project the workspace opens on its own when nothing is selected and the
 * URL names no session.
 *
 * Without a selected project the main region renders only the "choose a
 * project" view: no workspace header, no tabs, no composer. Auto-selecting only
 * when exactly one project exists left everyone with two or more projects on
 * that view after every load, and every Claude Code or Codex session started in
 * another directory adds a project by itself.
 */

/**
 * KRYTON OVERLAY (not part of the upstream change): the workspace directory every
 * Kryton workspace has. CloudCLI runs there with `WORKSPACES_ROOT` set to this
 * path (red-dwarf `scripts/cloudcli-start.sh`, `CLOUDCLI_WORKSPACES_ROOT`) and the
 * Kryton setup plugin creates a project for it at boot. When nothing remembered
 * matches, this project opens before the sidebar's first one.
 */
export const PREFERRED_PROJECT_PATH = '/home/coder/workspace';

/**
 * localStorage key holding the projects this browser opened most recently.
 *
 * The value is a JSON array of at most `RECENT_PROJECT_IDS_LIMIT` database
 * `projectId`s, newest first. Only the id is stored - a random UUID assigned by
 * the server - never a path or a display name, so the value reveals nothing
 * about the projects, and an id written by another installation that happens to
 * share this browser origin never matches a project here.
 */
export const RECENT_PROJECT_IDS_STORAGE_KEY = 'recentProjectIds';
export const RECENT_PROJECT_IDS_LIMIT = 8;

/** Reads the remembered ids; anything unreadable counts as "nothing remembered". */
export const readRecentProjectIds = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const ids: string[] = [];
    for (const value of parsed) {
      if (typeof value === 'string' && value.length > 0 && !ids.includes(value)) {
        ids.push(value);
      }
    }
    return ids.slice(0, RECENT_PROJECT_IDS_LIMIT);
  } catch {
    return [];
  }
};

/**
 * Moves `projectId` to the front of the remembered list. An unreadable value is
 * simply overwritten; storage errors are ignored like the `activeTab` mirror.
 */
export const rememberProjectId = (projectId: string): void => {
  if (!projectId) {
    return;
  }

  try {
    const next = [projectId, ...readRecentProjectIds().filter((id) => id !== projectId)]
      .slice(0, RECENT_PROJECT_IDS_LIMIT);
    localStorage.setItem(RECENT_PROJECT_IDS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable
  }
};

/**
 * The project to open, in this order:
 * 1. the most recently opened project this browser remembers, if it is still
 *    one of the active `projects`;
 * 2. (Kryton overlay) the project at `PREFERRED_PROJECT_PATH`;
 * 3. the first project in the sidebar's order (starred first, then by the
 *    configured name/date order) - the one the user sees at the top.
 *
 * Returns `null` only when there are no projects.
 */
export const pickInitialProject = (
  projects: Project[],
  recentProjectIds: string[],
  projectSortOrder: ProjectSortOrder,
): Project | null => {
  if (projects.length === 0) {
    return null;
  }

  for (const projectId of recentProjectIds) {
    const remembered = projects.find((project) => project.projectId === projectId);
    if (remembered) {
      return remembered;
    }
  }

  const preferred = projects.find(
    (project) => (project.fullPath || project.path || '').replace(/\/+$/, '') === PREFERRED_PROJECT_PATH,
  );
  if (preferred) {
    return preferred;
  }

  return sortProjects(projects, projectSortOrder)[0] ?? null;
};
