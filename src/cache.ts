// Keeps the raw responses of each source between runs, keyed by source and request.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SourceCache {
  /** The text stored under key, or undefined when there is none. */
  get(key: string): Promise<string | undefined>;
  put(key: string, text: string): Promise<void>;
}

/** A cache of one file per key in a directory. */
export function fileCache(dir: string): SourceCache {
  return {
    async get(key) {
      try {
        return await readFile(path.join(dir, key), "utf8");
      } catch {
        return undefined;
      }
    },
    async put(key, text) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, key), text);
    },
  };
}

/** A cache in memory, for tests and one-off builds. */
export function memoryCache(): SourceCache {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async put(key, text) {
      entries.set(key, text);
    },
  };
}

export interface CacheOptions {
  cache: SourceCache;
  /** Fetch again even when the cache has the data */
  refresh: boolean;
}
