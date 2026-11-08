// Buildings whose outline holds parts of clearly different heights in a city's 3D building parts (roofTops.ts), such
// as a hall, a low link and a tower drawn as one outline, become outlines with parts: the measured parts within the
// outline, those of about one height that touch merged, each of their own height; what of the outline no part covers
// goes to the part nearest it. An outline a way crosses (into a garage, through a passage, in a tunnel under or
// beside it) is left as it is: its parts would stand in the way's room or block it.
import clipping from "polygon-clipping";
import { storeyHeight } from "./ages.ts";
import { distanceToRing, distanceToSegment, pointInPolygon, ringArea, ringCentroid, type Point, type Polygon, type Ring } from "./geometry.ts";
import { bounds, type Building, type Road } from "./osm.ts";
import { measurable, type MeasuredPart } from "./roofTops.ts";

/** A piece of a measured part within an outline smaller than this (m²) is left out, and a part made smaller too */
const MIN_PIECE_M2 = 10;
const MIN_PART_M2 = 1;
/** The measured parts must cover this share of the outline */
const MIN_COVER = 0.8;
/** Pieces whose tops are this far apart (m) make parts */
const SPLIT_M = 4;
/** Pieces whose tops are within this (m) of the next lower one's are of one height */
const SAME_M = 1.5;
/** A top lower than this (m) is no building's */
const MIN_TOP_M = 2;
/** A tunnel this near (m) beside its width is under the outline: its room reaches out so far */
const TUNNEL_ROOM_M = 1;
/** The parts are indexed in square cells this big (m) */
const CELL_M = 50;

type ClipPolygon = [number, number][][];

function clip(polygon: Polygon): ClipPolygon {
  return [polygon.outer, ...polygon.holes];
}

function polygons(multi: ClipPolygon[]): Polygon[] {
  return multi.map(([outer, ...holes]): Polygon => ({ outer: open(outer), holes: holes.map(open) }));
}

/** A ring without its closing point */
function open(ring: Ring): Ring {
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function area(polygon: Polygon): number {
  return Math.abs(ringArea(polygon.outer)) - polygon.holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0);
}

function overlaps(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** The value at the middle of the weights, the values sorted */
function weightedMedian(items: { value: number; weight: number }[]): number {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2;
  let sum = 0;
  for (const item of sorted) {
    sum += item.weight;
    if (sum >= half) {
      return item.value;
    }
  }
  return sorted[sorted.length - 1].value;
}

export interface MeasuredSplit {
  /** Outlines that became outlines with parts */
  split: number;
  /** Outlines left as they were as their shapes could not be cut (polygon-clipping failed on them) */
  failed: number;
  /** Their new parts, to be added to the buildings */
  parts: Building[];
}

/**
 * Splits the ordinary buildings standing on their base (roofTops.ts' measurable) whose outline the parts cover well
 * and whose pieces of them differ in height by more than SPLIT_M: each becomes an outline with parts, the parts
 * flat-roofed at their measured tops, with the outline's other attributes and storeys of its storeys' height.
 */
export function splitByMeasuredParts(buildings: Building[], parts: MeasuredPart[], roads: Road[] = []): MeasuredSplit {
  const near = partsNear(parts);
  const crossedBy = waysCrossing(roads);
  const result: MeasuredSplit = { split: 0, failed: 0, parts: [] };
  for (const b of buildings) {
    if (!measurable(b) || (b.passages?.length ?? 0) > 0 || b.roofFaces || crossedBy(b.polygon)) {
      continue;
    }
    let made: Building[] | undefined;
    try {
      made = split(b, b.base, near(bounds(b.polygon.outer)));
    } catch {
      result.failed++;
    }
    if (made) {
      b.hasParts = true;
      result.split++;
      for (const part of made) {
        result.parts.push(part);
      }
    }
  }
  return result;
}

/** Whether segments ab and cd cross */
function crossing(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** Whether segments ab and cd come within reach of each other (they do not cross) */
function segmentsWithin(a: Point, b: Point, c: Point, d: Point, reach: number): boolean {
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b)) <= reach;
}

/** Whether one of the ways runs into a polygon: a point of it inside, a stretch crossing its rings, or a tunnel within its room of them */
function waysCrossing(roads: Road[]): (polygon: Polygon) => boolean {
  const index = new Map<string, { segment: Point[]; reach: number }[]>();
  for (const road of roads) {
    const reach = road.tunnel ? road.width / 2 + TUNNEL_ROOM_M : 0;
    for (let i = 0; i + 1 < road.line.length; i++) {
      const segment = [road.line[i], road.line[i + 1]];
      const box = bounds(segment);
      box.minX -= reach;
      box.minY -= reach;
      box.maxX += reach;
      box.maxY += reach;
      for (let x = Math.floor(box.minX / CELL_M); x <= Math.floor(box.maxX / CELL_M); x++) {
        for (let y = Math.floor(box.minY / CELL_M); y <= Math.floor(box.maxY / CELL_M); y++) {
          const cell = index.get(`${x},${y}`) ?? [];
          cell.push({ segment, reach });
          index.set(`${x},${y}`, cell);
        }
      }
    }
  }
  return (polygon) => {
    const box = bounds(polygon.outer);
    const rings = [polygon.outer, ...polygon.holes];
    for (let x = Math.floor(box.minX / CELL_M); x <= Math.floor(box.maxX / CELL_M); x++) {
      for (let y = Math.floor(box.minY / CELL_M); y <= Math.floor(box.maxY / CELL_M); y++) {
        for (const { segment, reach } of index.get(`${x},${y}`) ?? []) {
          const [a, b] = segment;
          if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) {
            return true;
          }
          for (const ring of rings) {
            for (let i = 0; i < ring.length; i++) {
              const [c, d] = [ring[i], ring[(i + 1) % ring.length]];
              if (crossing(a, b, c, d) || (reach > 0 && segmentsWithin(a, b, c, d, reach))) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  };
}

/** The parts whose boxes overlap a box */
function partsNear(parts: MeasuredPart[]): (box: ReturnType<typeof bounds>) => MeasuredPart[] {
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
  return (box) => {
    const found = new Set<MeasuredPart>();
    for (let x = Math.floor(box.minX / CELL_M); x <= Math.floor(box.maxX / CELL_M); x++) {
      for (let y = Math.floor(box.minY / CELL_M); y <= Math.floor(box.maxY / CELL_M); y++) {
        for (const entry of cells.get(`${x},${y}`) ?? []) {
          if (overlaps(box, entry.box)) {
            found.add(entry.part);
          }
        }
      }
    }
    return [...found];
  };
}

/** The building's parts by the measured parts' heights, or undefined where it is not to be split */
function split(b: Building, base: number, parts: MeasuredPart[]): Building[] | undefined {
  const outline = clip(b.polygon);
  const outlineArea = area(b.polygon);
  const pieces: { polygon: Polygon; top: number; area: number }[] = [];
  for (const part of parts) {
    if (part.top - base < MIN_TOP_M) {
      continue;
    }
    for (const polygon of polygons(clipping.intersection(outline, clip(part.polygon)))) {
      const a = area(polygon);
      if (a >= MIN_PIECE_M2) {
        pieces.push({ polygon, top: part.top - base, area: a });
      }
    }
  }
  if (pieces.length < 2 || pieces.reduce((sum, p) => sum + p.area, 0) < MIN_COVER * outlineArea) {
    return undefined;
  }
  const tops = pieces.map((p) => p.top);
  if (Math.max(...tops) - Math.min(...tops) <= SPLIT_M) {
    return undefined;
  }
  // the pieces in groups of one height, from the lowest
  pieces.sort((p, q) => p.top - q.top);
  const groups: { polygons: ClipPolygon[]; tops: { value: number; weight: number }[] }[] = [];
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last && piece.top - last.tops[last.tops.length - 1].value <= SAME_M) {
      last.polygons.push(clip(piece.polygon));
      last.tops.push({ value: piece.top, weight: piece.area });
    } else {
      groups.push({ polygons: [clip(piece.polygon)], tops: [{ value: piece.top, weight: piece.area }] });
    }
  }
  // what no piece covers goes to the group nearest it
  const covered = clipping.union(clip(pieces[0].polygon), ...pieces.slice(1).map((p) => clip(p.polygon)));
  for (const rest of polygons(clipping.difference(outline, covered))) {
    const centre: Point = ringCentroid(rest.outer);
    let nearest = groups[0];
    let distance = Infinity;
    for (const group of groups) {
      for (const [outer] of group.polygons) {
        const d = distanceToRing(centre, open(outer));
        if (d < distance) {
          [nearest, distance] = [group, d];
        }
      }
    }
    nearest.polygons.push(clip(rest));
  }
  const made: Building[] = [];
  for (const group of groups) {
    const height = weightedMedian(group.tops);
    const [first, ...others] = group.polygons;
    for (const polygon of polygons(clipping.union(first, ...others))) {
      if (area(polygon) < MIN_PART_M2) {
        continue;
      }
      made.push(partOf(b, polygon, height, made.length + 1));
    }
  }
  return made.length < 2 ? undefined : made;
}

/** A part of the building, flat-roofed at its height, with its other attributes */
function partOf(b: Building, polygon: Polygon, height: number, k: number): Building {
  const part: Building = { ...b, osm: `${b.osm}:${k}`, part: true, hasParts: false, polygon, height };
  for (const key of ["roofShape", "roofHeight", "roofHeightEstimated", "roofAngle", "roofLevels", "heightEstimated", "heightByType", "heightFromLevels", "passages", "passageRooms", "entrances", "businesses", "name"] as const) {
    delete part[key];
  }
  part.roofShapeEstimated = true;
  part.levels = Math.max(1, Math.round(height / storeyHeight(b)));
  return part;
}
