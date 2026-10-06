// Measured roof tops from cities' 3D building parts: WFS polygon layers with the height above sea level of
// each part's highest roof point, fetched only for maps reaching their area. They give the buildings under
// them their heights, and old ones a hipped roof up to the top.
import { createHash } from "node:crypto";
import { storeyHeight } from "./ages.ts";
import type { CacheOptions } from "./cache.ts";
import { orientedBox, pointInPolygon, ringArea, type Point, type Polygon } from "./geometry.ts";
import { field, items, optionalNumber, optionalString } from "./json.ts";
import { FINNISH_DEFAULTS_MEASURED_IN_TAMPERE } from "./measuredDefaults.ts";
import { bounds, GUESS_MIN_FILL, roofDegrees, type Building, type GeoBox } from "./osm.ts";
import type { GeoPoint } from "./projection.ts";

export interface RoofTopSource {
  /** Starts the cache keys */
  name: string;
  /** For logs and error messages */
  title: string;
  /** The WFS endpoint */
  url: string;
  layer: string;
  /** The layer's geometry property */
  geometry: string;
  /** What a map with its heights must credit */
  attribution: string;
  /** Around the area the layer covers, so that it is not asked for maps elsewhere */
  covers: GeoBox;
  /** Asks for up to this many features; without it the server decides */
  count?: number;
}

/** The City of Tampere's 3D building parts */
export const TAMPERE_ROOF_TOPS: RoofTopSource = {
  name: "tampere-roof-tops",
  title: "Tampere 3D building parts",
  url: "https://geodata.tampere.fi/geoserver/wfs",
  layer: "julkinen:mml_rakennusten_osat_3d_polygon_kaytossa",
  geometry: "geom",
  attribution: "3D building parts © City of Tampere (CC BY 4.0)",
  covers: { south: 61.35, west: 23.45, north: 61.9, east: 24.25 },
  count: 200000,
};

/** The open layers of 3D building parts known; a map uses those whose area it reaches into */
export const ROOF_TOP_SOURCES: RoofTopSource[] = [TAMPERE_ROOF_TOPS];

/** A building part with its measured roof top, as the layer has it */
export interface RoofTopPart {
  outer: GeoPoint[];
  holes: GeoPoint[][];
  /** Meters above sea level to the highest point of its roof */
  top: number;
}

/** A building part in map meters */
export interface MeasuredPart {
  polygon: Polygon;
  top: number;
}

/**
 * Reads the parts of a WFS GeoJSON response: kattokorkeus is the roof's top, suhdemaanpintaan whether the
 * part is on, over or under the ground (those under it are left out).
 */
export function parseRoofTops(response: unknown): RoofTopPart[] {
  const result: RoofTopPart[] = [];
  const ring = (value: unknown): GeoPoint[] =>
    items(value).flatMap((point) => {
      const [longitude, latitude] = items(point).map(optionalNumber);
      return longitude === undefined || latitude === undefined ? [] : [{ latitude, longitude }];
    });
  for (const feature of items(field(response, "features"))) {
    const top = optionalNumber(field(feature, "properties", "kattokorkeus"));
    if (top === undefined || optionalString(field(feature, "properties", "suhdemaanpintaan")) === "Pinnan alla") {
      continue;
    }
    const type = field(feature, "geometry", "type");
    const coordinates = items(field(feature, "geometry", "coordinates"));
    const polygons = type === "Polygon" ? [coordinates] : type === "MultiPolygon" ? coordinates.map(items) : [];
    for (const rings of polygons) {
      const [outer, ...holes] = rings.map(ring);
      if (outer && outer.length >= 3) {
        result.push({ outer, holes: holes.filter((hole) => hole.length >= 3), top });
      }
    }
  }
  return result;
}

/** Fetches a layer's parts in a box, cached by request. */
export async function fetchRoofTops(source: RoofTopSource, box: GeoBox, options: CacheOptions): Promise<{ parts: RoofTopPart[]; cached: boolean }> {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: source.layer,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    propertyName: `${source.geometry},kattokorkeus,suhdemaanpintaan`,
    // EPSG:4326 in WFS 2.0 is latitude first
    bbox: `${box.south},${box.west},${box.north},${box.east},urn:ogc:def:crs:EPSG::4326`,
    ...(source.count !== undefined && { count: String(source.count) }),
  });
  const url = `${source.url}?${query}`;
  const cacheKey = `${source.name}-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`;
  const cachedText = options.refresh ? undefined : await options.cache.get(cacheKey);
  if (cachedText !== undefined) {
    return { parts: parseRoofTops(JSON.parse(cachedText)), cached: true };
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || !text.startsWith("{")) {
    throw new Error(`${source.title} request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json: unknown = JSON.parse(text);
  if (source.count !== undefined && items(field(json, "features")).length >= source.count) {
    throw new Error(`${source.title}: the server returned the ${source.count} features asked for, there may be more`);
  }
  await options.cache.put(cacheKey, text);
  return { parts: parseRoofTops(json), cached: false };
}

/** An outline is sampled at most this far apart (m), and at least MIN_SAMPLES times */
const SAMPLE_M = 1;
const MIN_SAMPLES = 100;
/** Measured parts must cover this share of an outline */
const MIN_COVER = 0.5;
/** Storeys are at least this tall (m): a top lower than that is a lower wing's */
const MIN_STOREY_M = 2.7;
/** The tops fitting the storeys must cover this share of the outline */
const MIN_SHARE = 0.1;
/** A top lower than this (m) is no building's */
const MIN_TOP_M = 2;
/** Roofs are at most this steep */
const MAX_PITCH = (50 * Math.PI) / 180;
/** A top higher than the steepest roof and this (m) is another building's */
const SLACK_M = 3;
/** The parts are indexed in square cells this big (m) */
const CELL_M = 50;

export interface RoofTopMatch {
  /** Buildings whose height is now their measured top */
  heights: number;
  /** Of them, the ones that got a hipped roof up to it */
  roofs: number;
  /** Buildings too little covered by the parts */
  uncovered: number;
  /** Buildings whose top fits neither their storeys nor a roof */
  rejected: number;
}

/**
 * Sets the heights of ordinary buildings standing on their base (not parts, outlines with parts, special,
 * open or raised ones) to the measured tops over them, the median of the tops that fit their storeys, and with
 * storeys the roof between the eaves and the top: a guessed roof height up to it, else a hipped roof for an old,
 * nearly rectangular building whose top is clearly over its eaves. A top fitting neither is left out.
 */
export function applyRoofTops(buildings: Building[], parts: MeasuredPart[]): RoofTopMatch {
  const highestTop = partIndex(parts);
  const result: RoofTopMatch = { heights: 0, roofs: 0, uncovered: 0, rejected: 0 };
  for (const b of buildings) {
    if (b.part || b.hasParts || b.base === undefined || b.special || b.shelter !== undefined || b.lattice || b.minHeight > 0) {
      continue;
    }
    const base = b.base;
    const { tops, samples } = sampleTops(b.polygon, highestTop);
    if (samples === 0 || tops.length < MIN_COVER * samples) {
      result.uncovered++;
      continue;
    }
    const lowest = Math.max(MIN_TOP_M, (b.levels ?? 0) * MIN_STOREY_M);
    const fitting = tops.map((t) => t - base).filter((t) => t >= lowest);
    if (fitting.length < MIN_SHARE * samples) {
      result.rejected++;
      continue;
    }
    const top = median(fitting);
    const box = orientedBox(b.polygon.outer);
    const maxRise = (box.width / 2) * Math.tan(MAX_PITCH);
    const rise = b.levels === undefined ? undefined : top - b.levels * storeyHeight(b.year);
    if (b.roofShape && b.roofHeightEstimated) {
      if (rise !== undefined && rise > maxRise + SLACK_M) {
        result.rejected++;
        continue;
      }
      // the storeys tell the eaves too roughly to make a guessed roof lower: up to the rise, at most half of the height
      b.roofHeight = Math.min(Math.max(b.roofHeight ?? 0, Math.min(rise ?? 0, maxRise)), top / 2);
    } else if (rise !== undefined && rise > FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.flatRoofRiseM && !b.roofShape) {
      const old = b.year !== undefined && b.year < FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.pitchedRoofsBefore;
      const rectangular = b.polygon.holes.length === 0 && Math.abs(ringArea(b.polygon.outer)) >= GUESS_MIN_FILL * box.length * box.width;
      if (!b.roofShapeEstimated || !old || !rectangular || rise > maxRise + SLACK_M) {
        result.rejected++;
        continue;
      }
      b.roofShape = "hipped";
      b.roofAngle = roofDegrees(box.angle);
      b.roofHeight = Math.min(rise, maxRise);
      b.roofHeightEstimated = true;
      result.roofs++;
    }
    if (b.roofHeight !== undefined) {
      b.roofHeight = Math.min(b.roofHeight, top);
    }
    b.height = top;
    delete b.heightEstimated;
    delete b.heightFromLevels;
    delete b.heightByType;
    result.heights++;
  }
  return result;
}

/** The highest measured top over a point, if any part is over it */
function partIndex(parts: MeasuredPart[]): (p: Point) => number | undefined {
  const cells = new Map<string, { part: MeasuredPart; box: ReturnType<typeof bounds> }[]>();
  for (const part of parts) {
    const box = bounds(part.polygon.outer);
    for (let x = Math.floor(box.minX / CELL_M); x <= Math.floor(box.maxX / CELL_M); x++) {
      for (let y = Math.floor(box.minY / CELL_M); y <= Math.floor(box.maxY / CELL_M); y++) {
        const key = `${x},${y}`;
        const cell = cells.get(key) ?? [];
        cell.push({ part, box });
        cells.set(key, cell);
      }
    }
  }
  return (p) => {
    let highest: number | undefined;
    for (const { part, box } of cells.get(`${Math.floor(p[0] / CELL_M)},${Math.floor(p[1] / CELL_M)}`) ?? []) {
      const inBox = p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
      if (inBox && (highest === undefined || part.top > highest) && pointInPolygon(p, part.polygon)) {
        highest = part.top;
      }
    }
    return highest;
  };
}

/** The highest tops over points on a grid inside an outline, and how many points there are */
function sampleTops(polygon: Polygon, highestTop: (p: Point) => number | undefined): { tops: number[]; samples: number } {
  const step = Math.min(SAMPLE_M, Math.sqrt(Math.abs(ringArea(polygon.outer)) / MIN_SAMPLES));
  const box = bounds(polygon.outer);
  const tops: number[] = [];
  let samples = 0;
  if (!(step > 0)) {
    return { tops, samples };
  }
  for (let x = box.minX + step / 2; x < box.maxX; x += step) {
    for (let y = box.minY + step / 2; y < box.maxY; y += step) {
      if (pointInPolygon([x, y], polygon)) {
        samples++;
        const top = highestTop([x, y]);
        if (top !== undefined) {
          tops.push(top);
        }
      }
    }
  }
  return { tops, samples };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
