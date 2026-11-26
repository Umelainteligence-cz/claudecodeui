import { useCallback, useRef } from 'react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

export type FlatFile = {
  name: string;
  path: string;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

const flatten = (nodes: FileNode[], out: FlatFile[]): void => {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

// References inside chat messages are either bare basenames (`foo.ts`) or paths
// (`_workspace/qa/report.docx`). Upstream matched a path by suffix and then fell
// back to the bare filename, both against the gitignore-filtered tree: a link to a
// gitignored output such as `_workspace/qa/report.docx` (never in that tree) then
// opened ANY visible `report.docx` - and with the download button on the binary
// card it would hand over the wrong file. Kryton download overlay (plan ccl-r262,
// S1 b): a reference that carries a `/` is opened at exactly that path from the
// project root (an absolute path inside the root as given, a leading slash
// otherwise read from the root; `..` leaving the root is refused by the server), and the filename is matched only for a bare name and only when exactly
// one file in the tree carries it. Everything else opens the literal path, so a
// missing target is an error, never someone else's file.
export const resolveFileReference = (
  files: FlatFile[],
  ref: string,
  projectRoot?: string,
): string | null => {
  const cleaned = normalize(ref).trim();
  if (!cleaned) {
    return null;
  }
  const root = projectRoot ? normalize(projectRoot).replace(/\/+$/, '') : '';
  // An absolute path inside the project root is opened as given. Any other leading
  // slash is how models often write a project path (`/qa/report.docx`), so it is
  // read from the project root - never outside it (upstream stripped it too).
  if (root && (cleaned === root || cleaned.startsWith(`${root}/`))) {
    return cleaned;
  }

  const target = cleaned.replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  if (!target) {
    return null;
  }
  const atRoot = root ? `${root}/${target}` : target;
  if (target.includes('/')) {
    return atRoot;
  }

  const sameName = files.filter((file) => file.name === target);
  return sameName.length === 1 ? sameName[0].path : atRoot;
};

/** How long a loaded project tree answers bare-name links before it is read again. */
export const FILE_TREE_TTL_MS = 30_000;

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;
  const projectRoot = selectedProject?.fullPath;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFile[]> | null; at: number }>({
    projectId: undefined,
    files: null,
    at: 0,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    // Kryton download overlay: the tree only answers "is this bare name unique?", and a tree
    // cached for the whole session would keep saying yes after the agent made a second file
    // of that name. It is re-read after FILE_TREE_TTL_MS (only bare-name links read it).
    if (cacheRef.current.projectId === projectId && cacheRef.current.files
        && Date.now() - cacheRef.current.at < FILE_TREE_TTL_MS) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFile[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId, files: filesPromise, at: Date.now() };
    return filesPromise;
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any) => {
      const ref = normalize(filePath).trim();
      // A path never needs the tree (see resolveFileReference), only a bare name does
      // (`/name.ts` and `./name.ts` are bare names too).
      if (ref.replace(/^\/+/, '').replace(/^(?:\.\/)+/, '').includes('/')) {
        onFileOpen(resolveFileReference([], ref, projectRoot) ?? filePath, diffInfo);
        return;
      }
      void loadFiles().then((files) => {
        const match = resolveFileReference(files, ref, projectRoot);
        onFileOpen(match ?? filePath, diffInfo);
      });
    },
    [loadFiles, onFileOpen, projectRoot],
  );
}
