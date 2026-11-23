// Keeps the raw responses of each source between runs, keyed by source and request.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { field, items } from "./json.ts";
import type { GeoBox } from "./osm.ts";

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

/** The cache key of a request: the source's name and a hash of its URL */
export function requestKey(name: string, url: string, extension: string): string {
  return `${name}-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.${extension}`;
}

/** A WFS layer's GeoJSON in a box, cached by request (`name` starts the keys, `title` names it in errors) */
export async function fetchWfs(
  source: { name: string; title: string; url: string; layer: string; count?: number },
  box: GeoBox,
  options: CacheOptions,
  propertyName?: string,
): Promise<{ json: unknown; cached: boolean }> {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: source.layer,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    ...(propertyName !== undefined && { propertyName }),
    // EPSG:4326 in WFS 2.0 is latitude first
    bbox: `${box.south},${box.west},${box.north},${box.east},urn:ogc:def:crs:EPSG::4326`,
    ...(source.count !== undefined && { count: String(source.count) }),
  });
  const url = `${source.url}?${query}`;
  const cacheKey = requestKey(source.name, url, "json");
  const cachedText = options.refresh ? undefined : await options.cache.get(cacheKey);
  if (cachedText !== undefined) {
    return { json: JSON.parse(cachedText), cached: true };
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || !text.startsWith("{")) {
    throw new Error(`${source.title} request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json: unknown = JSON.parse(text);
  // count the features returned, not numberMatched, which includes ones without a geometry
  if (source.count !== undefined && items(field(json, "features")).length >= source.count) {
    throw new Error(`${source.title}: the server returned the ${source.count} features asked for, there may be more`);
  }
  await options.cache.put(cacheKey, text);
  return { json, cached: false };
}
