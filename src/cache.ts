// Where the fetched source data is kept between runs: the raw responses of each source, by a key that
// names the source and the request, so the sources stay apart and are only combined when a map is built.
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
