// Storeys, facade materials, uses and completion years from SYKE's Ryhti building register (OGC API
// Features, one point per building, CC BY 4.0), applied to the OSM outlines the points fall in.
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import { bounds, LEVEL_HEIGHT_M, partOutlines, type Building, type BuildingUse, type GeoBox } from "./osm.ts";
import { pointInPolygon, type Point } from "./geometry.ts";
import { field, items, optionalNumber, optionalString } from "./json.ts";
import { inGeoBox } from "./projection.ts";

export const BUILDING_REGISTER_ATTRIBUTION = "Building register © Finnish Environment Institute SYKE, Ryhti (CC BY 4.0)";

const ITEMS_URL = "https://paikkatiedot.ymparisto.fi/geoserver/ryhti_building/ogc/features/v1/collections/avoimet_rakennukset/items";
/** Features asked for a page; the server gives up to this many */
const PAGE_SIZE = 10000;
/** Pages to follow at most */
const MAX_PAGES = 10;

/**
 * julkisivumateriaali: facade materials. "Lasi" (glass) is left out as unreliable (later permits for glazed
 * parts seem to overwrite the material); "Muu" (other) says nothing.
 */
const FACADES: Record<string, string> = {
  Betoni: "concrete",
  Tiili: "brick",
  Metallilevy: "metal",
  Kivi: "stone",
  Puu: "wood",
};

/** paaasiallinen_kayttotarkoitus: the register's main use classes */
const USES: Record<string, BuildingUse> = {
  Pientalo: "house",
  "Vapaa-ajan asuinrakennus": "holiday",
  Kerrostalo: "apartments",
  // shops, restaurants, hotels, schools, churches, hospitals, ...
  "Julkinen rakennus": "public",
  // offices, factories, warehouses and whatever is not classified
  "Toimisto-, tuotanto-, yhdyskuntatekniikan tai muut rakennukset": "work",
  Talousrakennus: "ancillary",
  Saunarakennus: "sauna",
};

export interface RegisterBuilding {
  latitude: number;
  longitude: number;
  floors?: number;
  /** brick | concrete | wood | metal | stone */
  facade?: string;
  use?: BuildingUse;
  /** The year of the completion date */
  year?: number;
}

/** Placeholder completion dates that stand for an unknown one */
const UNKNOWN_DATES = new Set(["1904-02-29", "1900-01-01"]);
/** Completion years before this are errors */
const FIRST_YEAR = 1700;

/** Reads the standing buildings of a GeoJSON page of the register. */
export function parseBuildingRegister(response: unknown): RegisterBuilding[] {
  const result: RegisterBuilding[] = [];
  for (const feature of items(field(response, "features"))) {
    const [longitude, latitude] = items(field(feature, "geometry", "coordinates")).map(optionalNumber);
    if (field(feature, "geometry", "type") !== "Point" || longitude === undefined || latitude === undefined) {
      continue;
    }
    // "Purettu ..." (demolished); some demolished ones have only the date
    const inUse = optionalString(field(feature, "properties", "kaytossaolo"));
    if (optionalString(field(feature, "properties", "purkamispaivamaara")) !== undefined || inUse?.startsWith("Purettu")) {
      continue;
    }
    const floors = optionalNumber(field(feature, "properties", "kerrosluku"));
    const facade = FACADES[optionalString(field(feature, "properties", "julkisivumateriaali")) ?? ""];
    const use = USES[optionalString(field(feature, "properties", "paaasiallinen_kayttotarkoitus")) ?? ""];
    const year = completionYear(optionalString(field(feature, "properties", "valmistumispaivamaara")));
    result.push({
      longitude,
      latitude,
      ...(floors !== undefined && floors > 0 && { floors }),
      ...(facade && { facade }),
      ...(use && { use }),
      ...(year !== undefined && { year }),
    });
  }
  return result;
}

/** The year of a date such as "1965-05-01Z", unless the date stands for an unknown one */
function completionYear(date: string | undefined): number | undefined {
  const match = date?.match(/^(\d{4})-\d\d-\d\d/);
  if (!match || UNKNOWN_DATES.has(match[0])) {
    return undefined;
  }
  const year = Number(match[1]);
  return year >= FIRST_YEAR ? year : undefined;
}

/** Fetches the register's buildings in a box a page at a time, caching each page by its request. */
export async function fetchBuildingRegister(box: GeoBox, options: CacheOptions): Promise<{ buildings: RegisterBuilding[]; cached: boolean }> {
  const query = new URLSearchParams({
    f: "application/geo+json",
    limit: String(PAGE_SIZE),
    bbox: `${box.west},${box.south},${box.east},${box.north}`,
  });
  let url: string | undefined = `${ITEMS_URL}?${query}`;
  const buildings: RegisterBuilding[] = [];
  let cached = true;
  for (let page = 0; url !== undefined; page++) {
    if (page === MAX_PAGES) {
      throw new Error(`building register: more than ${MAX_PAGES * PAGE_SIZE} buildings in the box`);
    }
    const cacheKey = `ryhti-buildings-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`;
    let text = options.refresh ? undefined : await options.cache.get(cacheKey);
    if (text === undefined) {
      cached = false;
      const res = await fetch(url);
      text = await res.text();
      if (!res.ok || !text.startsWith("{")) {
        throw new Error(`building register request failed (${res.status}): ${text.slice(0, 500)}`);
      }
      await options.cache.put(cacheKey, text);
    }
    const json: unknown = JSON.parse(text);
    buildings.push(...parseBuildingRegister(json));
    url = nextPage(json);
  }
  return { buildings: inGeoBox(buildings, box), cached };
}

/** The link to a page's next page, if there is one */
function nextPage(page: unknown): string | undefined {
  for (const link of items(field(page, "links"))) {
    if (field(link, "rel") === "next") {
      return optionalString(field(link, "href"));
    }
  }
  return undefined;
}

export interface RegisterMatch {
  /** OSM buildings with register buildings inside */
  matched: number;
  /** Buildings whose estimated height the register replaced */
  heights: number;
  /** Buildings that got a wall material from the register */
  materials: number;
  /** Register buildings inside no OSM outline */
  unmatched: number;
}

/**
 * Gives OSM buildings the storeys, facades, uses and years of the register buildings inside them (most
 * storeys, most common facade and use, earliest year); a part in an outline gets nothing, its outline does.
 * OSM values and heights guessed by type are kept;
 * toPoint maps a register building to map meters.
 */
export function applyRegister(buildings: Building[], register: RegisterBuilding[], toPoint: (r: RegisterBuilding) => Point): RegisterMatch {
  const inside = new Map<Building, RegisterBuilding[]>();
  let unmatched = 0;
  // a register building is the whole building: its parts take after the outline (inheritFromOutlines)
  const inOutline = partOutlines(buildings);
  const boxes = buildings.filter((b) => !inOutline.has(b)).map((b) => ({ b, box: bounds(b.polygon.outer) }));
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
  const result: RegisterMatch = { matched: inside.size, heights: 0, materials: 0, unmatched };
  for (const [b, rs] of inside) {
    const floors = Math.max(0, ...rs.map((r) => r.floors ?? 0));
    if (b.heightEstimated && !b.heightByType && !b.part && floors > 0) {
      b.height = Math.max(floors * LEVEL_HEIGHT_M + (b.roofHeight ?? 0), b.minHeight + LEVEL_HEIGHT_M);
      delete b.heightEstimated;
      b.heightFromLevels = true;
      result.heights++;
    }
    if (b.levels === undefined && !b.part && b.minHeight === 0 && floors > 0) {
      b.levels = floors;
    }
    const use = mostCommon(rs.map((r) => r.use).filter((u) => u !== undefined));
    if (use) {
      b.use = use;
    }
    const years = rs.map((r) => r.year).filter((y) => y !== undefined);
    if (b.year === undefined && years.length > 0) {
      b.year = Math.min(...years);
    }
    const facade = mostCommon(rs.map((r) => r.facade).filter((f) => f !== undefined));
    if (facade && (!b.material || b.materialEstimated)) {
      b.material = facade;
      delete b.materialEstimated;
      result.materials++;
    }
  }
  return result;
}

function mostCommon<T extends string>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, count] of counts) {
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}
