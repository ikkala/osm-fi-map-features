// Street and park trees from city tree registers: WFS point layers in the common Finnish parks register
// format (Kasviryhma, Kasvilaji, Pituusluokka, Rungon_ymparys), fetched only for maps reaching their area.
import { createHash } from "node:crypto";
import type { CacheOptions } from "./cache.ts";
import { field, items, optionalNumber, optionalString } from "./json.ts";
import type { GeoBox, TreeKind } from "./osm.ts";
import { inGeoBox } from "./projection.ts";

export interface TreeRegisterSource {
  /** Starts the cache keys */
  name: string;
  /** For logs and error messages */
  title: string;
  /** The WFS endpoint */
  url: string;
  layer: string;
  /** What a map with its trees must credit */
  attribution: string;
  /** Around the area the register covers, so that it is not asked for maps elsewhere */
  covers: GeoBox;
  /** Asks for up to this many features; without it the server decides */
  count?: number;
}

/** The City of Tampere's street and park plants (Katu- ja puistopuut); the woods are not in it */
export const TAMPERE_TREE_REGISTER: TreeRegisterSource = {
  name: "tampere-trees",
  title: "Tampere tree register",
  url: "https://geodata.tampere.fi/geoserver/locus/ows",
  layer: "locus:locus_t_RpaVegetation_gsview",
  attribution: "Tree register © City of Tampere (CC BY 4.0)",
  covers: { south: 61.35, west: 23.45, north: 61.9, east: 24.25 },
  count: 200000,
};

/** The open tree registers known; a map uses those whose area it reaches into */
export const TREE_REGISTERS: TreeRegisterSource[] = [TAMPERE_TREE_REGISTER];

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
    // a rough height-from-diameter rule for city trees
    return Math.min(25, 3 + (circumference / Math.PI) * 0.35);
  }
  return DEFAULT_REGISTER_HEIGHTS[kind];
}

/** Reads the trees and shrubs of a WFS GeoJSON response of a plant register. */
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

/** Whether two boxes overlap */
export function overlaps(a: GeoBox, b: GeoBox): boolean {
  return a.south <= b.north && b.south <= a.north && a.west <= b.east && b.west <= a.east;
}

/**
 * Fetches a register's trees in a box, cached by request. Only trees inside the box are kept: the bbox
 * filter lets through features with broken coordinates.
 */
export async function fetchTreeRegister(
  source: TreeRegisterSource,
  box: GeoBox,
  options: CacheOptions,
): Promise<{ trees: RegisterTree[]; cached: boolean }> {
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
  const cacheKey = `${source.name}-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`;
  const cachedText = options.refresh ? undefined : await options.cache.get(cacheKey);
  if (cachedText !== undefined) {
    return { trees: inGeoBox(parseTreeRegister(JSON.parse(cachedText)), box), cached: true };
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || !text.startsWith("{")) {
    throw new Error(`${source.title} request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json: unknown = JSON.parse(text);
  // count the features returned, not numberMatched, which includes ones without a geometry
  const returned = items(field(json, "features")).length;
  if (source.count !== undefined && returned >= source.count) {
    throw new Error(`${source.title}: the server returned the ${source.count} features asked for, there may be more`);
  }
  await options.cache.put(cacheKey, text);
  return { trees: inGeoBox(parseTreeRegister(json), box), cached: false };
}
