// Building entrances: OSM entrance nodes where mapped, else guessed. A slab block of flats gets
// staircases along its side facing the nearest street, other buildings with windows one main door on
// that side. Wider blocks of flats get none: their doors are as often in the yard.
import { distanceToRing, nearestOnSegment, orientedBox, RectGrid, ringArea, ringCentroid, type Point, type Rect, type Ring } from "./geometry.ts";
import { bounds, type Building, type Entrance, type GeoBox, type OverpassResponse, type Road } from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";

/** Staircases of a guessed block of flats are this far apart (m), as measured from mapped ones */
export const STAIR_SPACING_M = 18;
/** A block of flats this narrow (m) and this rectangular (area / oriented box) is a slab */
const MAX_SLAB_WIDTH_M = 20;
const MIN_SLAB_FILL = 0.8;
/** No door is guessed for buildings smaller than this (m²) */
const MIN_GUESS_AREA_M2 = 20;
/** An entrance node this close to an outline (m) is on it */
const ON_OUTLINE_M = 0.5;
/** The street a door faces is looked for this far from the building (m) */
const MAX_STREET_M = 150;
/** Streets that doors face: not motorways, service roads or paths */
const STREETS = new Set(["primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "pedestrian"]);

export function entranceQuery(box: GeoBox): string {
  return `[out:json][timeout:60][bbox:${[box.south, box.west, box.north, box.east].join(",")}];\nnode[entrance];\nout;`;
}

/** The entrance nodes of an Overpass response in meters around origin (entrance=no left out) */
export function parseEntrances(elements: OverpassResponse["elements"], origin: GeoPoint): Entrance[] {
  const projection = new LocalProjection(origin);
  const result: Entrance[] = [];
  for (const element of elements) {
    const kind = element.tags?.entrance;
    if (element.type === "node" && kind && kind !== "no" && element.lat !== undefined && element.lon !== undefined) {
      result.push({ at: projection.toMeters({ latitude: element.lat, longitude: element.lon }), kind });
    }
  }
  return result;
}

/**
 * Gives buildings (outlines and parts) the entrances on their outline, moved onto it. Returns how many
 * entrances are on some building.
 */
export function assignEntrances(buildings: Building[], entrances: Entrance[]): number {
  const boxes = buildings.map((b) => ({ b, box: bounds(b.polygon.outer) }));
  let placed = 0;
  for (const entrance of entrances) {
    const [x, y] = entrance.at;
    let found = false;
    for (const { b, box } of boxes) {
      if (x < box.minX - ON_OUTLINE_M || x > box.maxX + ON_OUTLINE_M || y < box.minY - ON_OUTLINE_M || y > box.maxY + ON_OUTLINE_M) {
        continue;
      }
      const at = nearestOnRings([b.polygon.outer, ...b.polygon.holes], entrance.at);
      if (at && Math.hypot(at[0] - x, at[1] - y) < ON_OUTLINE_M) {
        (b.entrances ??= []).push({ ...entrance, at });
        found = true;
      }
    }
    if (found) {
      placed++;
    }
  }
  return placed;
}

/**
 * Guesses the doors of ordinary buildings (with windows, see windows.ts) that have no entrance in OSM.
 * Returns how many buildings got some.
 */
export function guessEntrances(buildings: Building[], roads: Road[]): number {
  const streets = streetGrid(roads.filter((r) => STREETS.has(r.kind) && !r.tunnel && !r.bridge));
  let count = 0;
  for (const b of buildings) {
    const ring = b.polygon.outer;
    const area = Math.abs(ringArea(ring));
    if (b.entrances || b.part || b.hasParts || b.shelter !== undefined || !b.windows || area < MIN_GUESS_AREA_M2) {
      continue;
    }
    const box = orientedBox(ring);
    const along: Point = [Math.cos(box.angle), Math.sin(box.angle)];
    const across: Point = [-along[1], along[0]];
    const centre = boxCentre(ring, along, across);
    // beyond this from the centroid a street is beyond MAX_STREET_M from the whole outline (+1 m rounding)
    const centroid = ringCentroid(ring);
    const radius = Math.max(...ring.map(([x, y]) => Math.hypot(x - centroid[0], y - centroid[1])));
    const street = nearestStreetPoint(streets, centroid, MAX_STREET_M + radius + 1);
    if (!street || distanceToRing(street, ring) > MAX_STREET_M) {
      continue;
    }
    const toStreet: Point = [street[0] - centre[0], street[1] - centre[1]];
    const dot = (a: Point, c: Point) => a[0] * c[0] + a[1] * c[1];
    const doors: Entrance[] = [];
    if (b.windows === "apartments") {
      const slab = b.polygon.holes.length === 0 && box.width <= MAX_SLAB_WIDTH_M && area >= MIN_SLAB_FILL * box.length * box.width;
      if (!slab) {
        continue;
      }
      const side = dot(toStreet, across) < 0 ? -1 : 1;
      const stairs = Math.max(1, Math.round(box.length / STAIR_SPACING_M));
      for (let i = 0; i < stairs; i++) {
        const k = ((i + 0.5) / stairs - 0.5) * box.length;
        const from: Point = [centre[0] + along[0] * k, centre[1] + along[1] * k];
        const at = farthestOnRing(ring, from, [across[0] * side, across[1] * side]);
        if (at) {
          doors.push({ at, kind: "staircase", guessed: true });
        }
      }
    } else {
      // the side of the box facing the street best
      const sides: Point[] = [along, across, [-along[0], -along[1]], [-across[0], -across[1]]];
      const facing = sides.reduce((best, s) => (dot(s, toStreet) > dot(best, toStreet) ? s : best));
      const at = farthestOnRing(ring, centre, facing);
      if (at) {
        doors.push({ at, kind: "main", guessed: true });
      }
    }
    if (doors.length > 0) {
      b.entrances = doors;
      count++;
    }
  }
  return count;
}

/** The centre of a ring's box along the axes along and across */
function boxCentre(ring: Ring, along: Point, across: Point): Point {
  const range = (axis: Point) => {
    const values = ring.map(([x, y]) => x * axis[0] + y * axis[1]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  const a = range(along);
  const c = range(across);
  return [along[0] * a + across[0] * c, along[1] * a + across[1] * c];
}

/** Where the line through from in direction dir last crosses the ring, going that way; undefined if it misses */
function farthestOnRing(ring: Ring, from: Point, dir: Point): Point | undefined {
  let best: number | undefined;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const c = ring[(i + 1) % ring.length];
    const ex = c[0] - a[0];
    const ey = c[1] - a[1];
    const denominator = dir[0] * ey - dir[1] * ex;
    if (Math.abs(denominator) < 1e-9) {
      continue;
    }
    // from + t * dir = a + s * (c - a)
    const t = ((a[0] - from[0]) * ey - (a[1] - from[1]) * ex) / denominator;
    const s = ((a[0] - from[0]) * dir[1] - (a[1] - from[1]) * dir[0]) / denominator;
    if (s >= 0 && s <= 1 && (best === undefined || t > best)) {
      best = t;
    }
  }
  return best === undefined ? undefined : [from[0] + dir[0] * best, from[1] + dir[1] * best];
}

/** The point on the rings' edges nearest to p */
function nearestOnRings(rings: Ring[], p: Point): Point | undefined {
  let best: Point | undefined;
  let bestDistance = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const q = nearestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestDistance) {
        best = q;
        bestDistance = d;
      }
    }
  }
  return best;
}

/** A street's segment, and its place among all the streets' segments */
interface Segment {
  a: Point;
  b: Point;
  order: number;
}

/** The streets' segments in cells of this size (m) */
const STREET_CELL_M = 50;

function streetGrid(streets: Road[]): RectGrid<Segment> {
  const segments: { a: Point; b: Point; box: Rect }[] = [];
  for (const street of streets) {
    for (let i = 0; i + 1 < street.line.length; i++) {
      const a = street.line[i];
      const b = street.line[i + 1];
      segments.push({ a, b, box: bounds([a, b]) });
    }
  }
  const over = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { box } of segments) {
    over.minX = Math.min(over.minX, box.minX);
    over.minY = Math.min(over.minY, box.minY);
    over.maxX = Math.max(over.maxX, box.maxX);
    over.maxY = Math.max(over.maxY, box.maxY);
  }
  const grid = new RectGrid<Segment>(STREET_CELL_M, over);
  segments.forEach(({ a, b, box }, order) => grid.add(box, { a, b, order }));
  return grid;
}

/**
 * The point on a street nearest to p, or undefined when there is none within reach (m). Of equally near
 * ones, the first of the streets' segments, as if they were all gone through in order.
 */
function nearestStreetPoint(streets: RectGrid<Segment>, p: Point, reach: number): Point | undefined {
  let best: Point | undefined;
  let bestDistance = Infinity;
  let bestOrder = Infinity;
  for (const { a, b, order } of streets.within({ minX: p[0] - reach, minY: p[1] - reach, maxX: p[0] + reach, maxY: p[1] + reach })) {
    const q = nearestOnSegment(p, a, b);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= reach && (d < bestDistance || (d === bestDistance && order < bestOrder))) {
      best = q;
      bestDistance = d;
      bestOrder = order;
    }
  }
  return best;
}
