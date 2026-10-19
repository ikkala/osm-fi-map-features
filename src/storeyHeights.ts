// Storey heights by when buildings were built, measured from buildings whose storeys, year and height over the
// ground are known: height = rise + storeys × storey, fitted to the median height of each storey count, so that
// the roof's rise over the eaves and the plinth go to the rise. scripts/measureStoreys.ts measures them from a
// map's cached sources (see the README's measured defaults).
import { bounds, partOutlines, type Building } from "./osm.ts";
import { pointInPolygon, ringCentroid, type Point, type Polygon } from "./geometry.ts";

/** A building measured: its storeys, the year it was built, and its height over the ground to its roof's top */
export interface StoreySample {
  storeys: number;
  year: number;
  height: number;
}

export interface StoreyFit {
  /** The first year and the year after the last of the buildings fitted */
  from: number;
  until: number;
  /** Meters a storey */
  storey: number;
  /** The storey's 90 % interval, by resampling the buildings */
  low: number;
  high: number;
  /** Meters of the height that are no storey: the roof's rise and the plinth */
  rise: number;
  buildings: number;
}

/** Storey counts with fewer buildings than this are left out of a fit */
const MIN_BUILDINGS = 5;
/** One-storey buildings are mostly halls, sheds and pavilions of their own heights */
const MIN_STOREYS = 2;
const RESAMPLES = 400;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The rise and the storey of a line through each storey count's median height, weighted by its buildings */
function line(samples: StoreySample[]): { rise: number; storey: number } | undefined {
  const byStoreys = new Map<number, number[]>();
  for (const s of samples) {
    if (s.storeys >= MIN_STOREYS) {
      byStoreys.set(s.storeys, [...(byStoreys.get(s.storeys) ?? []), s.height]);
    }
  }
  const points = [...byStoreys].filter(([, heights]) => heights.length >= MIN_BUILDINGS).map(([n, heights]) => ({ n, h: median(heights), w: heights.length }));
  if (points.length < 2) {
    return undefined;
  }
  const sum = (f: (p: { n: number; h: number; w: number }) => number) => points.reduce((total, p) => total + f(p), 0);
  const w = sum((p) => p.w);
  const n = sum((p) => p.w * p.n) / w;
  const h = sum((p) => p.w * p.h) / w;
  const spread = sum((p) => p.w * (p.n - n) ** 2);
  if (spread === 0) {
    return undefined;
  }
  const storey = sum((p) => p.w * (p.n - n) * (p.h - h)) / spread;
  return { rise: h - storey * n, storey };
}

/** A repeatable sequence of numbers in [0, 1), so that a measurement gives the same interval every time */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The storey height of the buildings built from `from` until the year before `until`, or undefined for too few */
export function fitStoreys(samples: StoreySample[], from: number, until: number): StoreyFit | undefined {
  const built = samples.filter((s) => s.year >= from && s.year < until);
  const fit = line(built);
  if (!fit) {
    return undefined;
  }
  const next = random(1);
  const storeys: number[] = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const resampled = built.map(() => built[Math.floor(next() * built.length)]);
    const again = line(resampled);
    if (again) {
      storeys.push(again.storey);
    }
  }
  storeys.sort((a, b) => a - b);
  const at = (share: number) => storeys[Math.min(storeys.length - 1, Math.floor(share * storeys.length))];
  return { from, until, storey: fit.storey, low: at(0.05), high: at(0.95), rise: fit.rise, buildings: built.length };
}

/**
 * Kinds whose storeys say little of their height: houses (their storeys counted variously, under roofs of
 * every pitch), halls, sheds and churches
 */
const UNMEASURED_KINDS = new Set([
  "detached", "house", "semidetached_house", "terrace", "bungalow", "cabin", "allotment_house", "hut", "garage", "garages",
  "shed", "sauna", "carport", "roof", "barn", "farm_auxiliary", "greenhouse", "industrial", "warehouse", "hangar",
  "service", "sports_hall", "parking", "transformer_tower", "kiosk", "church", "chapel",
]);
/** Heights over storeys outside these (m) are another building's top, or storeys counted wrong */
const MIN_STOREY_M = 1.8;
const MAX_STOREY_M = 8;
const CELL_M = 100;

/** A register's building: where it is in map meters, and its storeys and completion year when known */
export interface RegisterPoint {
  point: Point;
  floors?: number;
  year?: number;
}

/** A measured roof top above sea level over a building part in map meters */
export interface MeasuredTop {
  polygon: Polygon;
  top: number;
}

/**
 * The buildings that can be measured: whole buildings (no parts, no outlines of parts) of a kind whose storeys
 * tell their height, with one register point in them, a year (OSM's, else the register's) and storeys (OSM's,
 * else the register's), and measured tops: the highest top of a part whose centre is in the outline, over the
 * median ground at the outline's corners.
 */
export function storeySamples(buildings: Building[], register: RegisterPoint[], tops: MeasuredTop[], groundAt: (p: Point) => number | undefined): StoreySample[] {
  const outlines = new Set(partOutlines(buildings).values());
  const whole = buildings
    .filter((b) => !b.part && !outlines.has(b) && !UNMEASURED_KINDS.has(b.kind))
    .map((b) => {
      const points: RegisterPoint[] = [];
      return { b, box: bounds(b.polygon.outer), points, top: -Infinity };
    });
  // the buildings by the cells of a grid their boxes reach into
  const cells = new Map<string, typeof whole>();
  const cell = (x: number, y: number) => `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
  for (const w of whole) {
    for (let x = Math.floor(w.box.minX / CELL_M); x <= Math.floor(w.box.maxX / CELL_M); x++) {
      for (let y = Math.floor(w.box.minY / CELL_M); y <= Math.floor(w.box.maxY / CELL_M); y++) {
        const key = `${x},${y}`;
        cells.set(key, [...(cells.get(key) ?? []), w]);
      }
    }
  }
  const containing = (p: Point) =>
    (cells.get(cell(p[0], p[1])) ?? []).filter(({ b, box }) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && pointInPolygon(p, b.polygon));
  for (const r of register) {
    for (const w of containing(r.point)) {
      w.points.push(r);
    }
  }
  for (const t of tops) {
    for (const w of containing(ringCentroid(t.polygon.outer))) {
      w.top = Math.max(w.top, t.top);
    }
  }
  const samples: StoreySample[] = [];
  for (const { b, points, top } of whole) {
    const [only] = points;
    const year = b.year ?? only?.year;
    const storeys = b.levels ?? only?.floors;
    if (points.length !== 1 || year === undefined || storeys === undefined || storeys < 1 || top === -Infinity) {
      continue;
    }
    const ground = b.polygon.outer.map(groundAt).filter((g) => g !== undefined);
    if (ground.length === 0) {
      continue;
    }
    const height = top - median(ground);
    if (height >= storeys * MIN_STOREY_M && height <= storeys * MAX_STOREY_M) {
      samples.push({ storeys, year, height });
    }
  }
  return samples;
}
