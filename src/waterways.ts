// Waterways and the water's surface. OSM draws rivers, canals and streams as lines the way they flow,
// and their water as areas; the elevation model has the surface, unevenly where an area takes in its
// banks. A still water gets one level, the median of its surface; a flowing one falls along the
// waterways in it, never rising downstream, and each point of it is as high as the waterway nearest it.
import { deckAt } from "./bridges.ts";
import { clipPolyline, distanceToSegment, pointKey, polygonTest, RectGrid, ringArea, type Point, type Polygon, type Rect } from "./geometry.ts";
import { bounds, type Area, type GeoBox, type OverpassResponse } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";
import { tileName, tileRect, type Tile } from "./tiles.ts";

export type WaterwayKind = "river" | "canal" | "stream";

/** A waterway as OSM draws it, the way it flows */
export interface WaterwayLine {
  osm: string;
  kind: WaterwayKind;
  name?: string;
  /** In a culvert or tunnel */
  tunnel: boolean;
  line: Point[];
}

/** A stretch of a waterway in the water of the map's areas */
export interface Waterway {
  osm: string;
  kind: WaterwayKind;
  name?: string;
  /** The lowest id of the waterways joined to it, rivers and canals together and streams apart */
  network: string;
  /** The way it flows */
  line: Point[];
  /** The water's surface at each point (m above sea level) */
  levels: number[];
  /** How wide the water is across it at each point (m) */
  widths: number[];
}

export interface WaterLevels {
  waterways: Waterway[];
  /** The water's surface at a point (m east and north of the origin) in a water area that is set level, or undefined */
  levelAt(point: Point): number | undefined;
  /** Water areas set level, set to fall along their waterways, and left as the elevation model has them */
  still: number;
  flowing: number;
  uneven: number;
}

/** Waterways are followed in steps of this many meters */
const STEP_M = 2;
/** A still water whose surface spreads more than this over its middle half (m, 25th to 75th percentile) is left as it is: a slope, not banks */
const MAX_STILL_SPREAD_M = 0.5;
/** A still water's surface is taken from at most about this many points */
const LEVEL_SAMPLES = 20_000;
/** A flowing water falls along its waterways when it has at least this many of their points */
const MIN_FLOW_SAMPLES = 3;
/** Widths are measured this far to each side at most (m), in steps of a meter */
const MAX_HALF_WIDTH_M = 150;
/** A stretch is simplified to this many meters across, of level and of width */
const TOLERANCE = { across: 0.5, level: 0.05, width: 2 };
const GRID_CELL_M = 250;
const MANY_HOLES = 16;
const HOLE_CELL_M = 100;

export function waterwayQuery(box: GeoBox): string {
  return `[out:json][timeout:60][bbox:${[box.south, box.west, box.north, box.east].join(",")}];\nway[waterway~"^(river|canal|stream)$"];\nout geom;`;
}

/** The waterway lines of an Overpass response in meters around origin; areas tagged as waterways too are left out */
export function parseWaterways(elements: OverpassResponse["elements"], origin: GeoPoint): WaterwayLine[] {
  const projection = new LocalProjection(origin);
  const result: WaterwayLine[] = [];
  for (const element of elements) {
    if (element.type !== "way" || !element.geometry || element.geometry.length < 2) {
      continue;
    }
    const tags = element.tags ?? {};
    const kind = tags.waterway === "river" || tags.waterway === "canal" || tags.waterway === "stream" ? tags.waterway : undefined;
    const first = element.geometry[0];
    const last = element.geometry[element.geometry.length - 1];
    if (!kind || tags.natural === "water" || tags.area === "yes" || (first.lat === last.lat && first.lon === last.lon)) {
      continue;
    }
    const tunnel = (tags.tunnel !== undefined && tags.tunnel !== "no") || tags.covered === "yes";
    const line = element.geometry.map((p) => projection.toMeters({ latitude: p.lat, longitude: p.lon }));
    result.push({ osm: `w${element.id}`, kind, ...(tags.name && { name: tags.name }), tunnel, line });
  }
  return result;
}

interface Water {
  area: Area;
  box: Rect;
  inside: (point: Point) => boolean;
  /** The still water's surface */
  level?: number;
  /** The waterways' points in a flowing water, by place */
  samples?: RectGrid<Sample>;
}

interface Sample {
  point: Point;
  /** The way the waterway flows there, a unit vector */
  along: Point;
  /** The flowing waters the point is in */
  waters: Water[];
  level: number;
  width: number;
}

/**
 * Sets the levels of the water areas from heightAt (m above sea level at a point) and follows the
 * waterways through them. Lines in tunnels join waterways but have no water of their own.
 */
export function setWaterLevels(areas: Area[], lines: WaterwayLine[], heightAt: (e: number, n: number) => number | undefined): WaterLevels {
  const waters: Water[] = areas
    .filter((a) => a.kind === "water")
    .map((area) => ({ area, box: bounds(area.polygon.outer), inside: insideTest(area.polygon) }));
  const over = waters.reduce<Rect>(
    (r, w) => ({ minX: Math.min(r.minX, w.box.minX), minY: Math.min(r.minY, w.box.minY), maxX: Math.max(r.maxX, w.box.maxX), maxY: Math.max(r.maxY, w.box.maxY) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const grid = new RectGrid<Water>(GRID_CELL_M, over);
  for (const water of waters) {
    grid.add(water.box, water);
  }
  const watersAt = (p: Point) => grid.at(p).filter((w) => p[0] >= w.box.minX && p[0] <= w.box.maxX && p[1] >= w.box.minY && p[1] <= w.box.maxY && w.inside(p));

  for (const water of waters) {
    const surface = surfaceOf(water, heightAt);
    if (surface && surface.spread <= MAX_STILL_SPREAD_M) {
      water.level = surface.median;
    }
  }

  // each line's points in the water, levelled to fall downstream
  const runs = new Map<WaterwayLine, { point: Point; along: Point; waters: Water[]; height: number }[]>();
  for (const line of lines) {
    if (line.tunnel) {
      continue;
    }
    const points = [];
    for (const { point, along } of resample(line.line, STEP_M)) {
      const at = watersAt(point);
      // in a still water the surface is its level; elsewhere the elevation model's
      const still = at.flatMap((w) => (!w.area.flowing && w.level !== undefined ? [w.level] : []));
      const height = still.length > 0 ? Math.min(...still) : heightAt(point[0], point[1]);
      if (at.length > 0 && height !== undefined) {
        points.push({ point, along, waters: at.filter((w) => w.area.flowing), height });
      }
    }
    runs.set(line, points);
  }
  const levels = new Map<WaterwayLine, number[]>();
  for (const [line, points] of runs) {
    levels.set(line, nonIncreasing(points.map((p) => p.height)));
  }
  capAtJunctions(lines, levels);

  // the flowing waters with waterways in them fall along them
  const samplesOf = new Map<WaterwayLine, Sample[]>();
  for (const [line, points] of runs) {
    const lineLevels = levels.get(line) ?? [];
    samplesOf.set(line, points.map(({ point, along, waters: at }, i) => ({ point, along, waters: at, level: lineLevels[i], width: 0 })));
  }
  const samples = [...samplesOf.values()].flat();
  const counts = new Map<Water, number>();
  for (const sample of samples) {
    for (const water of sample.waters) {
      counts.set(water, (counts.get(water) ?? 0) + 1);
    }
  }
  for (const [water, count] of counts) {
    if (count >= MIN_FLOW_SAMPLES) {
      water.samples = new RectGrid<Sample>(SAMPLE_CELL_M, water.box);
      water.level = undefined;
    }
  }
  for (const sample of samples) {
    for (const water of sample.waters) {
      water.samples?.add({ minX: sample.point[0], minY: sample.point[1], maxX: sample.point[0], maxY: sample.point[1] }, sample);
    }
  }
  const inWater = (p: Point) => watersAt(p).length > 0;
  for (const sample of samples) {
    sample.width = widthAcross(sample.point, sample.along, inWater);
  }

  const networks = networksOf(lines);
  const waterways: Waterway[] = [];
  for (const line of lines) {
    const points = samplesOf.get(line) ?? [];
    // stretches of points one step apart
    let start = 0;
    for (let i = 1; i <= points.length; i++) {
      const gap = i === points.length || Math.hypot(points[i].point[0] - points[i - 1].point[0], points[i].point[1] - points[i - 1].point[1]) > STEP_M * 1.5;
      if (gap) {
        if (i - start >= 2) {
          const stretch = points.slice(start, i);
          const kept = simplifyStretch(stretch.map((s) => s.point), stretch.map((s) => s.level), stretch.map((s) => s.width));
          waterways.push({
            osm: line.osm,
            kind: line.kind,
            ...(line.name && { name: line.name }),
            network: networks.get(line) ?? line.osm,
            line: kept.map((k) => stretch[k].point),
            levels: kept.map((k) => round(stretch[k].level, 100)),
            widths: kept.map((k) => round(stretch[k].width, 10)),
          });
        }
        start = i;
      }
    }
  }

  const levelAt = (point: Point): number | undefined => {
    let best: number | undefined;
    for (const water of watersAt(point)) {
      const level = water.samples ? nearestSample(water.samples, point)?.level : water.level;
      if (level !== undefined && (best === undefined || level < best)) {
        best = level;
      }
    }
    return best;
  };
  const flowing = waters.filter((w) => w.samples).length;
  const still = waters.filter((w) => w.level !== undefined).length;
  return { waterways, levelAt, still, flowing, uneven: waters.length - flowing - still };
}

/** polygonTest for a lake of many islands: a point is tested only against the islands whose box holds it */
function insideTest(polygon: Polygon): (point: Point) => boolean {
  if (polygon.holes.length < MANY_HOLES) {
    return polygonTest(polygon);
  }
  const outer = polygonTest({ outer: polygon.outer, holes: [] });
  const holes = new RectGrid<{ box: Rect; inside: (point: Point) => boolean }>(HOLE_CELL_M, bounds(polygon.outer));
  for (const hole of polygon.holes) {
    const box = bounds(hole);
    holes.add(box, { box, inside: polygonTest({ outer: hole, holes: [] }) });
  }
  return (p) =>
    outer(p) && !holes.at(p).some(({ box, inside }) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && inside(p));
}

/** The median and spread (25th to 75th percentile) of heightAt inside a water area, or undefined off the elevation model */
function surfaceOf(water: Water, heightAt: (e: number, n: number) => number | undefined): { median: number; spread: number } | undefined {
  const { box } = water;
  const step = Math.max(STEP_M, Math.sqrt(Math.abs(ringArea(water.area.polygon.outer)) / LEVEL_SAMPLES));
  const heights: number[] = [];
  for (let x = box.minX + step / 2; x < box.maxX; x += step) {
    for (let y = box.minY + step / 2; y < box.maxY; y += step) {
      if (water.inside([x, y])) {
        const h = heightAt(x, y);
        if (h !== undefined) {
          heights.push(h);
        }
      }
    }
  }
  if (heights.length === 0) {
    return undefined;
  }
  heights.sort((a, b) => a - b);
  const at = (f: number) => heights[Math.floor(f * (heights.length - 1))];
  return { median: at(0.5), spread: at(0.75) - at(0.25) };
}

/** Points along a line about `step` apart, its own points among them, with the way it goes there */
function resample(line: Point[], step: number): { point: Point; along: Point }[] {
  const result: { point: Point; along: Point }[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const dx = line[i + 1][0] - ax;
    const dy = line[i + 1][1] - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      continue;
    }
    const along: Point = [dx / length, dy / length];
    const count = Math.ceil(length / step);
    for (let k = 0; k < count; k++) {
      result.push({ point: [ax + (dx * k) / count, ay + (dy * k) / count], along });
    }
    if (i + 2 === line.length) {
      result.push({ point: line[i + 1], along });
    }
  }
  return result;
}

/**
 * The non-increasing sequence nearest to `values` in absolute differences: runs that would rise are
 * pooled at their median, so a few high points (a dam's crest, a bank) do not lift the water.
 */
export function nonIncreasing(values: number[]): number[] {
  const pools: number[][] = [];
  const median = (pool: number[]) => {
    const sorted = [...pool].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  };
  for (const value of values) {
    pools.push([value]);
    while (pools.length > 1 && median(pools[pools.length - 2]) < median(pools[pools.length - 1])) {
      const last = pools.pop() ?? [];
      pools[pools.length - 1].push(...last);
    }
  }
  return pools.flatMap((pool) => pool.map(() => median(pool)));
}

/** Lowers each line's levels to where the lines flowing into its start end, through tunnels too */
function capAtJunctions(lines: WaterwayLine[], levels: Map<WaterwayLine, number[]>): void {
  const endingAt = new Map<string, WaterwayLine[]>();
  for (const line of lines) {
    const key = pointKey(line.line[line.line.length - 1]);
    endingAt.set(key, [...(endingAt.get(key) ?? []), line]);
  }
  // the level a line leaves its end at: its last one, or what it was capped at when it has none
  const caps = new Map<WaterwayLine, number>();
  const endLevel = (line: WaterwayLine) => {
    const own = levels.get(line) ?? [];
    return own.length > 0 ? own[own.length - 1] : caps.get(line);
  };
  for (let pass = 0; pass < lines.length; pass++) {
    let changed = false;
    for (const line of lines) {
      const upstream = (endingAt.get(pointKey(line.line[0])) ?? []).flatMap((u) => {
        const level = u === line ? undefined : endLevel(u);
        return level === undefined ? [] : [level];
      });
      if (upstream.length === 0) {
        continue;
      }
      const cap = Math.min(...upstream);
      if (caps.get(line) !== cap) {
        caps.set(line, cap);
        changed = true;
      }
      const own = levels.get(line) ?? [];
      if (own.some((l) => l > cap)) {
        levels.set(line, own.map((l) => Math.min(l, cap)));
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
}

/** Meters of water across a point, to each side of the way it flows */
function widthAcross(point: Point, along: Point, inWater: (p: Point) => boolean): number {
  const side = (sign: number) => {
    for (let t = 1; t <= MAX_HALF_WIDTH_M; t++) {
      if (!inWater([point[0] - sign * along[1] * t, point[1] + sign * along[0] * t])) {
        return t - 0.5;
      }
    }
    return MAX_HALF_WIDTH_M;
  };
  return side(1) + side(-1);
}

/** Each line's network: the lowest id of the lines that share a point with it, of its kind's group */
function networksOf(lines: WaterwayLine[]): Map<WaterwayLine, string> {
  const parent = new Map<WaterwayLine, WaterwayLine>();
  const root = (line: WaterwayLine): WaterwayLine => {
    let r = line;
    while (parent.get(r) !== r) {
      r = parent.get(r) ?? r;
    }
    parent.set(line, r);
    return r;
  };
  const byPoint = new Map<string, WaterwayLine>();
  for (const line of lines) {
    parent.set(line, line);
  }
  for (const line of lines) {
    const group = line.kind === "stream" ? "s" : "r";
    for (const p of line.line) {
      const key = `${group}:${pointKey(p)}`;
      const other = byPoint.get(key);
      if (other) {
        parent.set(root(line), root(other));
      } else {
        byPoint.set(key, line);
      }
    }
  }
  const lowest = new Map<WaterwayLine, string>();
  for (const line of lines) {
    const r = root(line);
    const current = lowest.get(r);
    if (current === undefined || Number(line.osm.slice(1)) < Number(current.slice(1))) {
      lowest.set(r, line.osm);
    }
  }
  return new Map(lines.map((line) => [line, lowest.get(root(line)) ?? line.osm]));
}

const SAMPLE_CELL_M = 25;

/** The sample nearest to a point, looked for in widening squares */
function nearestSample(samples: RectGrid<Sample>, point: Point): Sample | undefined {
  for (let reach = SAMPLE_CELL_M; reach <= 64 * SAMPLE_CELL_M; reach *= 2) {
    let best: Sample | undefined;
    let bestDistance = Infinity;
    for (const sample of samples.within({ minX: point[0] - reach, minY: point[1] - reach, maxX: point[0] + reach, maxY: point[1] + reach })) {
      const distance = Math.hypot(sample.point[0] - point[0], sample.point[1] - point[1]);
      if (distance < bestDistance) {
        best = sample;
        bestDistance = distance;
      }
    }
    // one within the square may still be nearer than one found at its corner
    if (best && bestDistance <= reach) {
      return best;
    }
  }
  return undefined;
}

/** The points of a stretch to keep: each left out is within TOLERANCE of the straight line, level and width between those kept */
function simplifyStretch(points: Point[], levels: number[], widths: number[]): number[] {
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const keep = new Set([0, points.length - 1]);
  const split = (a: number, b: number) => {
    let worst = -1;
    let worstError = 1;
    for (let i = a + 1; i < b; i++) {
      const t = along[b] > along[a] ? (along[i] - along[a]) / (along[b] - along[a]) : 0;
      const error = Math.max(
        distanceToSegment(points[i], points[a], points[b]) / TOLERANCE.across,
        Math.abs(levels[i] - (levels[a] + (levels[b] - levels[a]) * t)) / TOLERANCE.level,
        Math.abs(widths[i] - (widths[a] + (widths[b] - widths[a]) * t)) / TOLERANCE.width,
      );
      if (error > worstError) {
        worst = i;
        worstError = error;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      split(a, worst);
      split(worst, b);
    }
  };
  split(0, points.length - 1);
  return [...keep].sort((a, b) => a - b);
}

function round(value: number, per: number): number {
  return Math.round(value * per) / per;
}

/** Puts each waterway's pieces into the tiles they cross, levels and widths along them */
export function cutWaterways(tiles: Map<string, Tile>, waterways: Waterway[], size: number): void {
  for (const tile of tiles.values()) {
    tile.waterways = [];
  }
  for (const waterway of waterways) {
    const box = bounds(waterway.line);
    for (let y = Math.floor(box.minY / size); y <= Math.floor(box.maxY / size); y++) {
      for (let x = Math.floor(box.minX / size); x <= Math.floor(box.maxX / size); x++) {
        const tile = tiles.get(tileName({ x, y }));
        if (!tile) {
          continue;
        }
        for (const piece of clipPolyline(waterway.line, tileRect(tile, size))) {
          tile.waterways?.push({
            ...waterway,
            line: piece,
            levels: piece.map((p) => round(deckAt(waterway.line, waterway.levels, p), 100)),
            widths: piece.map((p) => round(deckAt(waterway.line, waterway.widths, p), 10)),
          });
        }
      }
    }
  }
}

