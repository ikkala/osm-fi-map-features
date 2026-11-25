// Buildings whose outline holds parts of clearly different heights in a city's 3D building parts (roofTops.ts), such
// as a hall, a low link and a tower drawn as one outline, become outlines with parts: the measured parts within the
// outline, those of about one height that touch merged, each of their own height; what of a part narrower than
// NARROW_M lies beside a lower one goes to that one, rather than stand over it as a thin wall; what of the outline no
// part covers goes, along a part within SLIVER_M of it, to that part, the lowest first, and the rest to the part
// nearest it, and so do its entrances. An outline a way crosses (into a garage, through a passage, in a tunnel under
// or beside it) is left as it is: its parts would stand in the way's room or block it.
import clipping from "polygon-clipping";
import { storeyHeight } from "./ages.ts";
import { distanceToRing, distanceToSegment, grownRect, lineLength, pointInPolygon, polygonArea, RectGrid, rectsMeet, ringCentroid, type Point, type Polygon, type Rect, type Ring } from "./geometry.ts";
import { bounds, type Building, type Road } from "./osm.ts";
import { measurable, partGrid, type MeasuredPart } from "./roofTops.ts";
import { inTunnel } from "./profile.ts";

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
/**
 * What no part covers this near a part (m), touching it, is that part's: measured parts a little inside the outline
 * leave a sliver along it, which as a whole would go to one part, and a taller one's would stand as a thin wall in
 * front of a lower
 */
const SLIVER_M = 1;
/** A part narrower than this (m), as a rectangle of its area and perimeter, would stand as a thin wall over a lower one */
const NARROW_M = 2.5;
/** Polygons this near (m) touch */
const TOUCH_M = 1e-6;

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

/** The polygon and what is within reach of it: a rectangle round each of its edges, reaching past its ends */
function around(polygon: ClipPolygon, reach: number): ClipPolygon[] {
  const shapes: ClipPolygon[] = [polygon];
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 1e-9) {
        continue;
      }
      const [ux, uy] = [((b[0] - a[0]) / length) * reach, ((b[1] - a[1]) / length) * reach];
      shapes.push([[
        [a[0] - ux - uy, a[1] - uy + ux],
        [b[0] + ux - uy, b[1] + uy + ux],
        [b[0] + ux + uy, b[1] + uy - ux],
        [a[0] - ux + uy, a[1] - uy - ux],
      ]]);
    }
  }
  return shapes;
}

/** The width of the rectangle of the polygon's area and perimeter: about a strip's width, bent or not */
function stripWidth(polygon: Polygon): number {
  const area = polygonArea(polygon);
  const half = [polygon.outer, ...polygon.holes].reduce((sum, ring) => sum + lineLength([...ring, ring[0]]), 0) / 2;
  const d = half * half - 4 * area;
  return d > 0 ? (half - Math.sqrt(d)) / 2 : Math.sqrt(area);
}

/** Whether a point of the polygon's outer ring is on one of the others' rings */
function touches(polygon: ClipPolygon, others: ClipPolygon[]): boolean {
  return polygon[0].some((point) => others.some((other) => other.some((ring) => distanceToRing(point, ring) < TOUCH_M)));
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
  /** Outlines split whose uncovered slivers could not be cut, which went whole to the part nearest them */
  slivers: number;
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
  const result: MeasuredSplit = { split: 0, failed: 0, slivers: 0, parts: [] };
  for (const b of buildings) {
    if (!measurable(b) || (b.passages?.length ?? 0) > 0 || b.roofFaces || crossedBy(b.polygon)) {
      continue;
    }
    let made: Building[] | undefined;
    const pieces = near(bounds(b.polygon.outer));
    try {
      made = split(b, b.base, pieces, true);
    } catch {
      try {
        made = split(b, b.base, pieces, false);
        result.slivers += made ? 1 : 0;
      } catch {
        result.failed++;
      }
    }
    if (made) {
      b.hasParts = true;
      giveEntrances(b, made);
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
  const index = new RectGrid<{ segment: Point[]; reach: number }>(CELL_M);
  for (const road of roads) {
    const reach = inTunnel(road) ? road.width / 2 + TUNNEL_ROOM_M : 0;
    for (let i = 0; i + 1 < road.line.length; i++) {
      const segment = [road.line[i], road.line[i + 1]];
      index.add(grownRect(bounds(segment), reach), { segment, reach });
    }
  }
  return (polygon) => {
    const rings = [polygon.outer, ...polygon.holes];
    for (const { segment, reach } of index.within(bounds(polygon.outer))) {
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
    return false;
  };
}

/** The parts whose boxes overlap a box */
function partsNear(parts: MeasuredPart[]): (box: Rect) => MeasuredPart[] {
  const cells = partGrid(parts);
  return (box) => {
    const near = cells.within(box).filter((entry) => rectsMeet(box, entry.box));
    return [...new Set(near.map((entry) => entry.part))];
  };
}

/** Pieces of about one height: their polygons, and their tops by area */
interface Group {
  polygons: ClipPolygon[];
  tops: { value: number; weight: number }[];
}

/**
 * Gives the group what of the area lies within reach of it and touches it, or what of it touches: a sliver beyond
 * another group's piece is that one's. Returns the rest.
 */
function giveNear(group: Group, area: ClipPolygon[], reach: number): ClipPolygon[] {
  const [first, ...others] = group.polygons.flatMap((polygon) => around(polygon, reach));
  if (area.length === 0 || first === undefined) {
    return area;
  }
  let near = clipping.intersection(area, clipping.union(first, ...others));
  const taken: ClipPolygon[] = [];
  for (let found = true; found; ) {
    found = false;
    for (const polygon of near) {
      if (touches(polygon, group.polygons)) {
        group.polygons.push(polygon);
        taken.push(polygon);
        found = true;
      }
    }
    near = near.filter((polygon) => !taken.includes(polygon));
  }
  return taken.length > 0 ? clipping.difference(area, ...taken) : area;
}

/**
 * What of a group's polygons narrower than NARROW_M lies beside a lower group goes to it, the lowest first, and so
 * does what is left of one that touches lower groups only, out of reach in a wedge; beside a higher one, it stays: a
 * ledge, not a wall
 */
function lowerNarrow(groups: Group[]): void {
  for (const [i, group] of groups.entries()) {
    const [first, ...others] = group.polygons;
    const merged = i > 0 && first ? clipping.union(first, ...others) : [];
    const narrow = merged.filter((polygon) => polygons([polygon]).every((p) => stripWidth(p) < NARROW_M));
    if (narrow.length === 0) {
      continue;
    }
    const [lower, higher] = [groups.slice(0, i), groups.slice(i + 1)];
    let rest: ClipPolygon[] = narrow;
    for (const other of lower) {
      rest = giveNear(other, rest, NARROW_M);
    }
    const kept: ClipPolygon[] = [];
    for (const polygon of rest) {
      const under = lower.find((other) => touches(polygon, other.polygons));
      if (under && !higher.some((other) => touches(polygon, other.polygons))) {
        under.polygons.push(polygon);
      } else {
        kept.push(polygon);
      }
    }
    group.polygons = [...merged.filter((polygon) => !narrow.includes(polygon)), ...kept];
  }
}

/**
 * The building's parts by the measured parts' heights, or undefined where it is not to be split; without slivers,
 * what no piece covers goes whole to the group nearest it
 */
function split(b: Building, base: number, parts: MeasuredPart[], slivers: boolean): Building[] | undefined {
  const outline = clip(b.polygon);
  const outlineArea = polygonArea(b.polygon);
  const pieces: { polygon: Polygon; top: number; area: number }[] = [];
  for (const part of parts) {
    if (part.top - base < MIN_TOP_M) {
      continue;
    }
    for (const polygon of polygons(clipping.intersection(outline, clip(part.polygon)))) {
      const a = polygonArea(polygon);
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
  const all: Group[] = [];
  for (const piece of pieces) {
    const last = all[all.length - 1];
    if (last && piece.top - last.tops[last.tops.length - 1].value <= SAME_M) {
      last.polygons.push(clip(piece.polygon));
      last.tops.push({ value: piece.top, weight: piece.area });
    } else {
      all.push({ polygons: [clip(piece.polygon)], tops: [{ value: piece.top, weight: piece.area }] });
    }
  }
  lowerNarrow(all);
  const groups = all.filter((group) => group.polygons.length > 0);
  if (groups.length < 2) {
    return undefined;
  }
  // what no piece covers goes to a group within SLIVER_M of it, the lowest first, and the rest to the group nearest it
  const covered = clipping.union(clip(pieces[0].polygon), ...pieces.slice(1).map((p) => clip(p.polygon)));
  let uncovered = clipping.difference(outline, covered);
  for (const group of slivers ? groups : []) {
    uncovered = giveNear(group, uncovered, SLIVER_M);
  }
  for (const rest of polygons(uncovered)) {
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
      if (polygonArea(polygon) < MIN_PART_M2) {
        continue;
      }
      made.push(partOf(b, polygon, height, made.length + 1));
    }
  }
  return made.length < 2 ? undefined : made;
}

/**
 * The outline's entrances go to the parts, each to the one whose outline is nearest it: an outline with parts is drawn
 * by them, its doors with them, and an entrance is on one building only
 */
function giveEntrances(b: Building, parts: Building[]): void {
  for (const entrance of b.entrances ?? []) {
    let best: Building | undefined;
    let nearest = Infinity;
    for (const part of parts) {
      const d = Math.min(...[part.polygon.outer, ...part.polygon.holes].map((ring) => distanceToRing(entrance.at, ring)));
      if (d < nearest) {
        nearest = d;
        best = part;
      }
    }
    if (best) {
      (best.entrances ??= []).push(entrance);
    }
  }
  delete b.entrances;
}

/** A part of the building, flat-roofed at its height, with its other attributes */
function partOf(b: Building, polygon: Polygon, height: number, k: number): Building {
  const part: Building = { ...b, osm: `${b.osm}:${k}`, part: true, hasParts: false, polygon, height };
  for (const key of ["roofShape", "roofGambrel", "roofHeight", "roofHeightEstimated", "roofAngle", "roofLevels", "heightEstimated", "heightByType", "heightFromLevels", "passages", "passageRooms", "entrances", "businesses", "name"] as const) {
    delete part[key];
  }
  part.roofShapeEstimated = true;
  part.levels = Math.max(1, Math.round(height / storeyHeight(b)));
  return part;
}
