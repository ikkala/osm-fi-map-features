// Plane geometry for the map builder. Points are [east, north] in meters.
import earcut from "earcut";

export type Point = [number, number];
/** A closed ring without the repeated closing point. */
export type Ring = Point[];

export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Clips a polyline to a rectangle; a line that leaves and re-enters becomes several lines. */
export function clipPolyline(line: Point[], rect: Rect): Point[][] {
  const result: Point[][] = [];
  let current: Point[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const segment = clipSegment(line[i], line[i + 1], rect);
    if (!segment) {
      continue;
    }
    const [a, b] = segment;
    const last = current[current.length - 1];
    if (!last || last[0] !== a[0] || last[1] !== a[1]) {
      if (current.length >= 2) {
        result.push(current);
      }
      current = [a];
    }
    current.push(b);
  }
  if (current.length >= 2) {
    result.push(current);
  }
  return result;
}

/** Liang–Barsky: the part of segment a–b inside the rectangle, or undefined. */
function clipSegment(a: Point, b: Point, rect: Rect): [Point, Point] | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - rect.minX],
    [dx, rect.maxX - a[0]],
    [-dy, a[1] - rect.minY],
    [dy, rect.maxY - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return undefined;
      }
    } else {
      const t = q / p;
      if (p < 0) {
        t0 = Math.max(t0, t);
      } else {
        t1 = Math.min(t1, t);
      }
    }
  }
  // t0 === t1 only touches the rectangle at one point
  if (t0 >= t1) {
    return undefined;
  }
  // keep the original endpoints exactly, so consecutive segments still join
  const start: Point = t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dy];
  const end: Point = t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dy];
  return [start, end];
}

/**
 * Sutherland–Hodgman: clips a ring to a rectangle. A concave ring that crosses the rectangle more than
 * twice comes out as one ring with zero-width connecting edges, which still fills correctly.
 */
export function clipRing(ring: Ring, rect: Rect): Ring | undefined {
  const inside = [
    (p: Point) => p[0] >= rect.minX,
    (p: Point) => p[0] <= rect.maxX,
    (p: Point) => p[1] >= rect.minY,
    (p: Point) => p[1] <= rect.maxY,
  ];
  const intersect = [
    (a: Point, b: Point) => atX(a, b, rect.minX),
    (a: Point, b: Point) => atX(a, b, rect.maxX),
    (a: Point, b: Point) => atY(a, b, rect.minY),
    (a: Point, b: Point) => atY(a, b, rect.maxY),
  ];
  let output = ring;
  for (let edge = 0; edge < 4 && output.length > 0; edge++) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentIn = inside[edge](current);
      if (currentIn !== inside[edge](previous)) {
        output.push(intersect[edge](previous, current));
      }
      if (currentIn) {
        output.push(current);
      }
    }
  }
  const cleaned = dedupe(output);
  return cleaned.length >= 3 && Math.abs(ringArea(cleaned)) > 1e-6 ? cleaned : undefined;
}

function atX(a: Point, b: Point, x: number): Point {
  return [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
}

function atY(a: Point, b: Point, y: number): Point {
  return [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
}

export function clipPolygon(polygon: Polygon, rect: Rect): Polygon | undefined {
  const outer = clipRing(polygon.outer, rect);
  if (!outer) {
    return undefined;
  }
  const holes = polygon.holes.map((hole) => clipRing(hole, rect)).filter((hole) => hole !== undefined);
  return { outer, holes };
}

/** A point as a key: ways that join share the point exactly */
export function pointKey(p: Point): string {
  return `${p[0]},${p[1]}`;
}

/** Drops consecutive duplicate points, including a closing point equal to the first. */
export function dedupe(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const last = result[result.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      result.push(p);
    }
  }
  while (result.length > 1 && samePoint(result[0], result[result.length - 1])) {
    result.pop();
  }
  return result;
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Signed area (shoelace); positive for counter-clockwise rings. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Area-weighted centroid of a ring, or its first point for a degenerate ring. */
export function ringCentroid(ring: Ring): Point {
  const area = ringArea(ring);
  if (Math.abs(area) < 1e-9) {
    return ring[0];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** How long a ring is along a direction (radians counter-clockwise from east). */
export function extent(ring: Ring, angle: number): number {
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of ring) {
    min = Math.min(min, x * dx + y * dy);
    max = Math.max(max, x * dx + y * dy);
  }
  return max - min;
}

/**
 * The smallest rectangle around a ring with a side along one of the ring's edges: the direction of its
 * long side (radians counter-clockwise from east, 0 .. pi), its length and its width.
 */
export function orientedBox(ring: Ring): { angle: number; length: number; width: number } {
  const box = (angle: number) => {
    const along = extent(ring, angle);
    const across = extent(ring, angle + Math.PI / 2);
    return along >= across ? { angle, length: along, width: across } : { angle: angle + Math.PI / 2, length: across, width: along };
  };
  let best = box(0);
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    if (x1 !== x2 || y1 !== y2) {
      const candidate = box(Math.atan2(y2 - y1, x2 - x1));
      if (candidate.length * candidate.width < best.length * best.width - 1e-9) {
        best = candidate;
      }
    }
  }
  const angle = ((best.angle % Math.PI) + Math.PI) % Math.PI;
  return { ...best, angle };
}

/** Distance from a point to the nearest edge of a ring. */
export function distanceToRing(point: Point, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, distanceToSegment(point, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

/** Even-odd point-in-ring test. */
export function pointInRing(point: Point, ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  return pointInRing(point, polygon.outer) && !polygon.holes.some((hole) => pointInRing(point, hole));
}

/** Rings with fewer points than this are tested edge by edge: banding them would not pay */
const BANDED_RING_POINTS = 32;
/** Edges per band, on average, of a banded ring */
const EDGES_PER_BAND = 8;
const MAX_BANDS = 4096;

/**
 * pointInPolygon for many points in one large polygon: edges are bucketed into horizontal bands and a
 * point is tested only against its band, with the same answer as pointInPolygon.
 */
export function polygonTest(polygon: Polygon): (point: Point) => boolean {
  const outer = ringTest(polygon.outer);
  const holes = polygon.holes.map(ringTest);
  return (point) => outer(point) && !holes.some((hole) => hole(point));
}

function ringTest(ring: Ring): (point: Point) => boolean {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of ring) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const count = Math.min(MAX_BANDS, Math.ceil(ring.length / EDGES_PER_BAND));
  const height = (maxY - minY) / count;
  if (ring.length < BANDED_RING_POINTS || !(height > 0)) {
    return (point) => pointInRing(point, ring);
  }
  // monotonic in y, so an edge from y1 to y2 is in the bands of every y between them
  const bandOf = (y: number) => Math.min(count - 1, Math.floor((y - minY) / height));
  // each edge as xi, yi, xj, yj, as pointInRing has them
  const bands: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi !== yj) {
      for (let band = bandOf(Math.min(yi, yj)); band <= bandOf(Math.max(yi, yj)); band++) {
        bands[band].push(xi, yi, xj, yj);
      }
    }
  }
  return ([x, y]) => {
    // no edge reaches a point outside the ring's heights
    if (!(y >= minY && y < maxY)) {
      return false;
    }
    const edges = bands[bandOf(y)];
    let inside = false;
    for (let k = 0; k < edges.length; k += 4) {
      const xi = edges[k];
      const yi = edges[k + 1];
      const xj = edges[k + 2];
      const yj = edges[k + 3];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
}

/** Spatial index of things by bounding box in square cells; only cells over `over` are kept. */
export class RectGrid<T> {
  readonly #cell: number;
  readonly #over: Rect;
  readonly #cells = new Map<string, T[]>();

  constructor(cell: number, over: Rect) {
    this.#cell = cell;
    this.#over = over;
  }

  add(rect: Rect, item: T): void {
    const over = this.#over;
    const minI = Math.floor(Math.max(rect.minX, over.minX) / this.#cell);
    const maxI = Math.floor(Math.min(rect.maxX, over.maxX) / this.#cell);
    const minJ = Math.floor(Math.max(rect.minY, over.minY) / this.#cell);
    const maxJ = Math.floor(Math.min(rect.maxY, over.maxY) / this.#cell);
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const key = `${i},${j}`;
        const list = this.#cells.get(key);
        if (list) {
          list.push(item);
        } else {
          this.#cells.set(key, [item]);
        }
      }
    }
  }

  /** The things whose box may hold the point */
  at(point: Point): T[] {
    return this.#cells.get(`${Math.floor(point[0] / this.#cell)},${Math.floor(point[1] / this.#cell)}`) ?? [];
  }

  /** The things whose box may meet the rectangle; one over several cells comes once for each */
  within(rect: Rect): T[] {
    const result: T[] = [];
    for (let i = Math.floor(rect.minX / this.#cell); i <= Math.floor(rect.maxX / this.#cell); i++) {
      for (let j = Math.floor(rect.minY / this.#cell); j <= Math.floor(rect.maxY / this.#cell); j++) {
        result.push(...(this.#cells.get(`${i},${j}`) ?? []));
      }
    }
    return result;
  }
}

/**
 * Joins open ways into closed rings by matching their endpoints (multipolygon members are split into
 * several ways). Returns the rings and the number of ways that could not be closed.
 */
export function stitchRings<T>(ways: T[][], same: (a: T, b: T) => boolean): { rings: T[][]; unclosed: number } {
  const rings: T[][] = [];
  const open = ways.filter((way) => way.length >= 2).map((way) => [...way]);
  let unclosed = 0;
  for (let ring = open.pop(); ring !== undefined; ring = open.pop()) {
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const index = open.findIndex((way) => same(way[0], end) || same(way[way.length - 1], end));
      if (index < 0) {
        break;
      }
      const [next] = open.splice(index, 1);
      if (!same(next[0], end)) {
        next.reverse();
      }
      ring.push(...next.slice(1));
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) {
      rings.push(ring.slice(0, -1));
    } else {
      unclosed++;
    }
  }
  return { rings, unclosed };
}

/**
 * Triangulates a polygon. Returns vertex indices, three per triangle, into the outer ring followed by
 * the holes in order.
 */
export function triangulate(polygon: Polygon): number[] {
  const rings = [polygon.outer, ...polygon.holes];
  const holeStarts: number[] = [];
  let count = polygon.outer.length;
  for (const hole of polygon.holes) {
    holeStarts.push(count);
    count += hole.length;
  }
  return earcut(rings.flat(2), holeStarts);
}

/**
 * Douglas–Peucker simplification of an open line; the endpoints are kept, and so are the points kept(p)
 * tells to (such as the ones other lines join at).
 */
export function simplifyLine(line: Point[], tolerance: number, kept: (p: Point) => boolean = () => false): Point[] {
  if (line.length <= 2 || tolerance <= 0) {
    return line;
  }
  const keep = line.map((p, i) => i === 0 || i === line.length - 1 || kept(p));
  const stack: [number, number][] = [];
  for (let first = 0, i = 1; i < line.length; i++) {
    if (keep[i]) {
      stack.push([first, i]);
      first = i;
    }
  }
  for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
    const [first, last] = range;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = distanceToSegment(line[i], line[first], line[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index >= 0 && maxDistance > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Simplifies a ring, keeping at least a triangle. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 3) {
    return ring;
  }
  // split at the point farthest from the first one so both halves are open lines
  let far = 1;
  for (let i = 2; i < ring.length; i++) {
    if (squaredDistance(ring[i], ring[0]) > squaredDistance(ring[far], ring[0])) {
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  const result = [...a, ...b.slice(1, -1)];
  return result.length >= 3 ? result : ring;
}

function squaredDistance(a: Point, b: Point): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/** The point on the segment from a to c nearest to p */
export function nearestOnSegment(p: Point, a: Point, c: Point): Point {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** The point on a line nearest to p, how far it is, and the segment (from point `segment` to the next) it is on */
export function nearestOnLine(line: Point[], p: Point): { point: Point; distance: number; segment: number } {
  let best = { point: line[0], distance: Math.hypot(line[0][0] - p[0], line[0][1] - p[1]), segment: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const q = nearestOnSegment(p, line[i], line[i + 1]);
    const distance = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (distance < best.distance) {
      best = { point: q, distance, segment: i };
    }
  }
  return best;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.sqrt(squaredDistance(p, a));
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.sqrt(squaredDistance(p, [a[0] + t * dx, a[1] + t * dy]));
}
