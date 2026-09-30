// Storeys and facade materials from the City of Tampere's building register (Tampereen rakennukset,
// CC BY 4.0), fetched from its WFS interface as points, one per building. OSM has the outlines; a
// register point inside an outline gives that building its storeys (when OSM has no height) and its
// wall material. Also the city's register of street and park trees (CC BY 4.0), one point per tree, and
// its counts of people walking and cycling (CC BY 4.0), one point per count.
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import { averageDay, PEAK_HOUR_SHARE } from "./footfall.ts";
import { bounds, LEVEL_HEIGHT_M, type Building, type GeoBox, type TreeKind } from "./osm.ts";
import { pointInPolygon, type Point } from "./geometry.ts";
import { field, items, optionalNumber, optionalString } from "./json.ts";

export const TAMPERE_ATTRIBUTION = "Building register © City of Tampere (CC BY 4.0)";
export const TAMPERE_TREES_ATTRIBUTION = "Tree register © City of Tampere (CC BY 4.0)";
export const TAMPERE_COUNTS_ATTRIBUTION = "Pedestrian counts © City of Tampere (CC BY 4.0)";

const BUILDINGS: WfsLayer = {
  url: "https://geodata.tampere.fi/geoserver/rakennukset/ows",
  layer: "rakennukset:RAKENNUKSET_JULKINEN_MVIEW",
  cacheName: "tampere-buildings",
  title: "Tampere building register",
};
// The street and park plants that the city looks after (Katu- ja puistopuut); the woods are not in it
const TREES: WfsLayer = {
  url: "https://geodata.tampere.fi/geoserver/locus/ows",
  layer: "locus:locus_t_RpaVegetation_gsview",
  cacheName: "tampere-trees",
  title: "Tampere tree register",
  count: 200000,
};

// Counts of people walking and cycling (Jalankulun ja pyöräilyn liikennemäärät) since 1926, some 10 000
const COUNTS: WfsLayer = {
  url: "https://geodata.tampere.fi/geoserver/liikenneverkot/ows",
  layer: "liikenneverkot:liikennemaarat_jalankulku_pyoraily_counter_point_TM35",
  cacheName: "tampere-counts",
  title: "Tampere pedestrian and cycling counts",
  count: 100000,
};

/**
 * C_JULKISIVU: the facade material codes of the Finnish building register. 6 (glass) is left out: in
 * Tampere it is on brick factories, a stone school and blocks of flats. Permits for later changes (a glass
 * entrance, glazed balconies) seem to have replaced the material; OSM building:material=glass is kept.
 */
const FACADES: Record<string, string> = {
  "1": "concrete",
  "2": "brick",
  "3": "metal",
  "4": "stone",
  "5": "wood",
};

export interface RegisterBuilding {
  latitude: number;
  longitude: number;
  floors?: number;
  /** brick | concrete | wood | metal | stone */
  facade?: string;
  /** C_RAKENNUSLUOKKA: the building class (use), e.g. "0121" for blocks of flats */
  use?: string;
}

/** Reads the buildings of a WFS GeoJSON response. */
export function parseRegister(response: unknown): RegisterBuilding[] {
  const result: RegisterBuilding[] = [];
  for (const feature of items(field(response, "features"))) {
    const [longitude, latitude] = items(field(feature, "geometry", "coordinates")).map(optionalNumber);
    // "Rakennelma" (fences, shelters, ...) are structures, not buildings
    const building = field(feature, "properties", "TYYPPI") === "Rakennus";
    if (field(feature, "geometry", "type") !== "Point" || !building || longitude === undefined || latitude === undefined) {
      continue;
    }
    const floors = optionalNumber(field(feature, "properties", "I_KERRLKM"));
    const facadeCode = optionalString(field(feature, "properties", "C_JULKISIVU"));
    const use = optionalString(field(feature, "properties", "C_RAKENNUSLUOKKA"));
    const facade = facadeCode === undefined ? undefined : FACADES[facadeCode];
    result.push({
      longitude,
      latitude,
      ...(floors !== undefined && floors > 0 && { floors }),
      ...(facade && { facade }),
      ...(use && { use }),
    });
  }
  return result;
}

/** Fetches the register's buildings in a box, caching the response by box. */
export async function fetchRegister(box: GeoBox, options: CacheOptions): Promise<{ buildings: RegisterBuilding[]; cached: boolean }> {
  const { json, cached } = await fetchWfs(BUILDINGS, box, options);
  return { buildings: parseRegister(json), cached };
}

interface WfsLayer {
  url: string;
  layer: string;
  /** Starts the cache keys */
  cacheName: string;
  /** For error messages */
  title: string;
  /** Asks for up to this many features; without it the server decides */
  count?: number;
}

/** A WFS layer's features in a box as GeoJSON, cached by the request. */
async function fetchWfs(source: WfsLayer, box: GeoBox, options: CacheOptions): Promise<{ json: unknown; cached: boolean }> {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: source.layer,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    // EPSG:4326 in WFS 2.0 is latitude first
    bbox: `${box.south},${box.west},${box.north},${box.east},urn:ogc:def:crs:EPSG::4326`,
    ...(source.count !== undefined && { count: String(source.count) }),
  });
  const url = `${source.url}?${query}`;
  const cacheKey = `${source.cacheName}-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`;
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
  // (numberMatched may be a little more than the features returned: those without a geometry are left out)
  const returned = items(field(json, "features")).length;
  if (source.count !== undefined && returned >= source.count) {
    throw new Error(`${source.title}: the server returned the ${source.count} features asked for, there may be more`);
  }
  await options.cache.put(cacheKey, text);
  return { json, cached: false };
}

export interface RegisterCount {
  latitude: number;
  longitude: number;
  /** People walking on the year's average day (see averageDay) */
  daily: number;
  /** Counted across the whole street; else on one path or sidewalk */
  whole: boolean;
}

/**
 * Reads the current pedestrian counts along ways of a WFS GeoJSON response of the city's counts. Counts of
 * people crossing a street (Suojatie) or walking on the carriageway (Ajorata) are left out, and so are the
 * outdated ones (tulos_vanhentunut) and those of cycling only. A count of the afternoon peak hour only is
 * made a day's by PEAK_HOUR_SHARE.
 */
export function parseCounts(response: unknown): RegisterCount[] {
  const result: RegisterCount[] = [];
  for (const feature of items(field(response, "features"))) {
    const [longitude, latitude] = items(field(feature, "geometry", "coordinates")).map(optionalNumber);
    const property = (name: string) => field(feature, "properties", name);
    const type = property("kohteen_tyyppi");
    // "2025-06-26Z"
    const date = new Date((optionalString(property("paiva")) ?? "").replace(/Z$/, ""));
    if (
      field(feature, "geometry", "type") !== "Point" ||
      longitude === undefined ||
      latitude === undefined ||
      (type !== "JKPP" && type !== "Koko poikkileikkaus") ||
      property("tulos_vanhentunut") !== "ei" ||
      Number.isNaN(date.getTime())
    ) {
      continue;
    }
    const day = optionalNumber(property("vuorokausi_jk"));
    const peak = optionalNumber(property("iltahuipputunti_jk"));
    const daily = day ?? (peak === undefined ? undefined : peak / PEAK_HOUR_SHARE);
    if (daily === undefined || daily < 0) {
      continue;
    }
    result.push({ latitude, longitude, daily: Math.round(averageDay(daily, date)), whole: type === "Koko poikkileikkaus" });
  }
  return result;
}

/** Fetches the city's pedestrian counts in a box, caching the response by box. */
export async function fetchCounts(box: GeoBox, options: CacheOptions): Promise<{ counts: RegisterCount[]; cached: boolean }> {
  const { json, cached } = await fetchWfs(COUNTS, box, options);
  return { counts: parseCounts(json), cached };
}

/** Kasviryhma: the register's plant groups */
const TREE_GROUPS: Record<string, TreeKind> = {
  Lehtipuu: "broadleaved",
  Havupuu: "conifer",
  Lehtipensas: "shrub",
  Havupensas: "shrub",
};

/** Heights of register trees without a height class or a trunk measurement */
const DEFAULT_REGISTER_HEIGHTS: Record<TreeKind, number> = { broadleaved: 8, conifer: 10, shrub: 2 };

export interface RegisterTree {
  latitude: number;
  longitude: number;
  kind: TreeKind;
  height: number;
  genus?: string;
  /** Meters around the trunk at chest height, when measured */
  trunk?: number;
}

/**
 * The height of a register tree: the middle of its height class ("11 - 15m", "30m ->"), or a guess
 * from its trunk's circumference (cm), or the default for its kind.
 */
export function registerTreeHeight(heightClass: string | undefined, circumference: number | undefined, kind: TreeKind): number {
  const range = heightClass?.match(/^(\d+)\s*-\s*(\d+)\s*m/);
  if (range) {
    return (Number(range[1]) + Number(range[2])) / 2;
  }
  const over = heightClass?.match(/^(\d+)\s*m\s*->/);
  if (over) {
    return Number(over[1]) + 2;
  }
  if (kind !== "shrub" && circumference !== undefined && circumference > 0) {
    // a rough rule for city trees: a 30 cm trunk (about 10 cm across) is some 6 m tall, 150 cm some 20 m
    return Math.min(25, 3 + (circumference / Math.PI) * 0.35);
  }
  return DEFAULT_REGISTER_HEIGHTS[kind];
}

/** Reads the trees and shrubs of a WFS GeoJSON response of the city's plant register. */
export function parseTreeRegister(response: unknown): RegisterTree[] {
  const result: RegisterTree[] = [];
  for (const feature of items(field(response, "features"))) {
    const [longitude, latitude] = items(field(feature, "geometry", "coordinates")).map(optionalNumber);
    if (field(feature, "geometry", "type") !== "Point" || longitude === undefined || latitude === undefined) {
      continue;
    }
    const group = optionalString(field(feature, "properties", "Kasviryhma")) ?? "";
    // other groups are trees converted from an older register, of no known kind
    const kind = TREE_GROUPS[group] ?? "broadleaved";
    // "BETULA PENDULA (RAUDUSKOIVU)", or only the Finnish name ("LEHTIPUU") when the species is not known
    const species = optionalString(field(feature, "properties", "Kasvilaji"));
    const genus = species?.includes("(") ? species.split(/\s+/)[0].toLowerCase() : undefined;
    const heightClass = optionalString(field(feature, "properties", "Pituusluokka"));
    const circumference = optionalNumber(field(feature, "properties", "Rungon_ymparys"));
    result.push({
      longitude,
      latitude,
      kind,
      height: registerTreeHeight(heightClass, circumference, kind),
      ...(genus && { genus }),
      // centimeters in the register
      ...(kind !== "shrub" && circumference !== undefined && circumference > 0 && { trunk: circumference / 100 }),
    });
  }
  return result;
}

/** Fetches the city's street and park trees in a box, caching the response by box. */
export async function fetchTreeRegister(box: GeoBox, options: CacheOptions): Promise<{ trees: RegisterTree[]; cached: boolean }> {
  const { json, cached } = await fetchWfs(TREES, box, options);
  return { trees: parseTreeRegister(json), cached };
}

export interface RegisterMatch {
  /** Buildings whose estimated height the register replaced */
  heights: number;
  /** Buildings that got a wall material from the register */
  materials: number;
  /** Register buildings inside no OSM outline */
  unmatched: number;
}

/**
 * Gives OSM buildings the storeys, facades and uses of the register buildings inside them. With several
 * register buildings in one outline, the most storeys and the most common facade and use win. Heights
 * from OSM are kept, and so are OSM materials and levels. toPoint maps a register building to map meters.
 */
export function applyRegister(buildings: Building[], register: RegisterBuilding[], toPoint: (r: RegisterBuilding) => Point): RegisterMatch {
  const inside = new Map<Building, RegisterBuilding[]>();
  let unmatched = 0;
  const boxes = buildings.map((b) => ({ b, box: bounds(b.polygon.outer) }));
  for (const r of register) {
    const p = toPoint(r);
    let found = false;
    for (const { b, box } of boxes) {
      if (p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && pointInPolygon(p, b.polygon)) {
        inside.set(b, [...(inside.get(b) ?? []), r]);
        found = true;
      }
    }
    if (!found) {
      unmatched++;
    }
  }
  const result: RegisterMatch = { heights: 0, materials: 0, unmatched };
  for (const [b, rs] of inside) {
    const floors = Math.max(0, ...rs.map((r) => r.floors ?? 0));
    if (b.heightEstimated && !b.part && floors > 0) {
      b.height = Math.max(floors * LEVEL_HEIGHT_M + (b.roofHeight ?? 0), b.minHeight + LEVEL_HEIGHT_M);
      delete b.heightEstimated;
      result.heights++;
    }
    if (b.levels === undefined && !b.part && b.minHeight === 0 && floors > 0) {
      b.levels = floors;
    }
    const use = mostCommon(rs.map((r) => r.use).filter((u) => u !== undefined));
    if (use) {
      b.use = use;
    }
    const facade = mostCommon(rs.map((r) => r.facade).filter((f) => f !== undefined));
    if (facade && !b.material) {
      b.material = facade;
      result.materials++;
    }
  }
  return result;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, count] of counts) {
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}
