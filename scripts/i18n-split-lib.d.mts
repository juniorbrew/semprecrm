export const FULL_DICT_FILES: string[];
export function rel(root: string, p: string): string;
export function makeGraph(root: string): {
  read(file: string): string;
  closure(entries: string[], withApi: boolean): Set<string>;
};
export function defineGroups(root: string): Record<string, string[]>;
export function planChunks(
  root: string,
  enToPt: Record<string, string>
): {
  groups: Record<string, string[]>;
  chunks: Record<string, Set<string>>;
  unmatched: string[];
  keys: string[];
  graph: ReturnType<typeof makeGraph>;
};
export function chunkFileName(name: string): string;
export function renderChunk(
  name: string,
  keys: Set<string>,
  enToPt: Record<string, string>
): string;
