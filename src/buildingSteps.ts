// Buildings' walls step the ground. The elevation model has no ground under a building, only a slope across it from
// the ground around, so where a building is cut into a slope the slope goes on out of its wall, a heap of ground
// against it. Outside such a wall the ground is taken down to the slope's foot, as far out as the slope reaches, as
// on a retaining wall's low side (retainingWalls.ts); the ground inside is left as it is.
import { distanceToSegment, pointInPolygon, polygonTest, type Point, type Polygon, type Rect } from "./geometry.ts";
import { bounds, type Building } from "./osm.ts";
import { FLAT_M, MIN_STEP_M, REACH_M, slopeEnd, STRETCH_M, type GroundStep } from "./retainingWalls.ts";
import { tileName, type Tile } from "./tiles.ts";

/** A wall is not stepped this far (m) beyond the half width of a way going through it */
const THROUGH_MARGIN_M = 1;
/** The width of a way without one, a railway's track (m) */
const WAY_WIDTH_M = 3;
/** How far out of a wall (m) another building is looked for: a wall on another's has no outside */
const BESIDE_M = 1;
/** How far in from a wall (m) the ground is looked at, to tell a heap against the wall from a bank falling away */
const INSIDE_M = 1;
/** How far past a slope's foot (m) the water may be for the slope to be its bank */
const SHORE_M = 2;
/** Buildings and ways are looked up in squares this big (m) */
const CELL_M = 16;

interface Way {
  line: Point[];
  width?: number;
  /** highway=*: steps climb a slope that is the ground's */
  kind?: string;
}

/**
 * The stretches of the buildings' walls where the ground steps down outside them, from a to b with the building on
 * the left (its low side the right, so that the ground on the wall's line is the outside's). Left out: buildings
 * that do not stand on walls (shelters, lattices, those raised off the ground and building parts, whose outline's
 * walls count), stretches with another building outside, stretches where a way goes through the wall, and those
 * whose slope's foot is in the water (one of the water areas) or by it, a bank, or that have a dam (its line or
 * outline) or steps (highway=steps) within the slope's reach: the dam stands on that ground, and the steps climb it.
 */
export function buildingSteps(
  buildings: readonly Building[],
  ways: readonly Way[],
  heightAt: (e: number, n: number) => number | undefined,
  water: readonly Polygon[] = [],
  dams: readonly Point[][] = [],
): GroundStep[] {
  const waters = index(water.map((polygon) => ({ item: polygonTest(polygon), box: bounds(polygon.outer) })));
  const wet = (p: Point) => waters.near({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, 0).some((inside) => inside(p));
  const damPoints = index(
    dams.flatMap((line) =>
      line.flatMap((p, i) => {
        const q = line[(i + 1) % line.length];
        const count = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / STRETCH_M));
        return Array.from({ length: count }, (_, k): Point => [p[0] + ((q[0] - p[0]) * k) / count, p[1] + ((q[1] - p[1]) * k) / count]);
      }),
    ).map((p) => ({ item: p, box: { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] } })),
  );
  const stairs = index(
    ways
      .filter((way) => way.kind === "steps")
      .flatMap((way) => way.line.slice(1).map((q, i) => ({ item: [way.line[i], q] satisfies [Point, Point], box: bounds([way.line[i], q]) }))),
  );
  // steps within a slope's reach climb it: the slope is the ground's
  const climbed = (p: Point, reach: number) =>
    stairs.near({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, reach).some(([a, b]) => distanceToSegment(p, a, b) <= reach);
  // a dam within a slope's reach stands on its ground
  const damNear = (p: Point, reach: number) =>
    damPoints.near({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, reach).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= reach);
  const outlines = buildings.filter((b) => !b.part);
  const standing = outlines.filter((b) => b.shelter === undefined && !b.lattice && !(b.minHeight > 0));
  const others = index(outlines.map((b) => ({ item: b, box: bounds(b.polygon.outer) })));
  const segments = index(
    ways.flatMap((way) =>
      way.line.slice(1).map((q, i) => {
        const p = way.line[i];
        return { item: { p, q, half: (way.width ?? WAY_WIDTH_M) / 2 }, box: { minX: Math.min(p[0], q[0]), minY: Math.min(p[1], q[1]), maxX: Math.max(p[0], q[0]), maxY: Math.max(p[1], q[1]) } };
      }),
    ),
  );
  const steps: GroundStep[] = [];
  for (const building of standing) {
    const polygon = building.polygon;
    const box = bounds(polygon.outer);
    const through = throughPoints(polygon, segments.near(box, 0));
    const beside = others.near(box, BESIDE_M).filter((o) => o !== building);
    for (const ring of [polygon.outer, ...polygon.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length === 0) {
          continue;
        }
        const [ue, un] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
        // the building on the left: the outside is the right, (un, -ue)
        const left: Point = [(a[0] + b[0]) / 2 - un * 0.01, (a[1] + b[1]) / 2 + ue * 0.01];
        const out = pointInPolygon(left, polygon) ? 1 : -1;
        const [oe, on] = [un * out, -ue * out];
        const count = Math.ceil(length / STRETCH_M);
        for (let k = 0; k < count; k++) {
          const p0: Point = [a[0] + (b[0] - a[0]) * (k / count), a[1] + (b[1] - a[1]) * (k / count)];
          const p1: Point = [a[0] + (b[0] - a[0]) * ((k + 1) / count), a[1] + (b[1] - a[1]) * ((k + 1) / count)];
          const mid: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
          if (through.some(({ at, reach }) => Math.hypot(at[0] - mid[0], at[1] - mid[1]) < reach)) {
            continue;
          }
          const outside: Point = [mid[0] + oe * BESIDE_M, mid[1] + on * BESIDE_M];
          if (beside.some((o) => pointInPolygon(outside, o.polygon))) {
            continue;
          }
          const foot = footOf((d) => heightAt(mid[0] + oe * d, mid[1] + on * d), heightAt(mid[0] - oe * INSIDE_M, mid[1] - on * INSIDE_M));
          // a bank falling into the water, at its foot or by it, is no heap
          const banked = (d: number) => wet([mid[0] + oe * d, mid[1] + on * d]);
          const reach = foot ? foot.footOut + STRETCH_M : 0;
          if (foot && !banked(foot.footOut) && !banked(foot.footOut + SHORE_M) && !damNear(mid, reach) && !climbed(mid, reach)) {
            const [from, to] = out === 1 ? [p0, p1] : [p1, p0];
            steps.push({ wall: building.osm, a: from, b: to, low: -1, ...foot, top: 0, topIn: 0, shareA: 1, shareB: 1 });
          }
        }
      }
    }
  }
  return steps;
}

/**
 * The slope's foot out of a wall, from the ground d meters out: where it falls to one at least MIN_STEP_M lower; none
 * where the ground inside, INSIDE_M in, is not higher by FLAT_M a meter, the slope going on up through the wall (a
 * bank falling away from a building on its edge, not a heap)
 */
function footOf(at: (d: number) => number | undefined, inside: number | undefined): { foot: number; footOut: number } | undefined {
  const wall = at(0);
  if (wall === undefined || inside === undefined || inside - wall < FLAT_M * INSIDE_M) {
    return undefined;
  }
  const heights: number[] = [];
  for (let d = 0; d <= REACH_M; d++) {
    const h = at(d);
    if (h === undefined) {
      break;
    }
    heights.push(h);
    // the slope's end is known once two meters past it are
    const end = heights.length >= 3 ? slopeEnd(heights.slice(-3), -1) : undefined;
    if (end === 0) {
      const footOut = heights.length - 3;
      return footOut > 0 && heights[0] - heights[footOut] >= MIN_STEP_M ? { foot: heights[footOut], footOut } : undefined;
    }
  }
  return undefined;
}

/** Where ways going into the polygon meet its rings, and how far along a wall from there they keep it from stepping */
function throughPoints(polygon: Polygon, segments: { p: Point; q: Point; half: number }[]): { at: Point; reach: number }[] {
  const points: { at: Point; reach: number }[] = [];
  for (const { p, q, half } of segments) {
    const inside = pointInPolygon([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], polygon);
    for (const ring of [polygon.outer, ...polygon.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const hit = meet(p, q, ring[i], ring[(i + 1) % ring.length]);
        if (hit && (inside || hit.proper)) {
          points.push({ at: hit.at, reach: half + THROUGH_MARGIN_M });
        }
      }
    }
  }
  return points;
}

/** Where segments p-q and a-b meet, ends included, and whether they cross there (each strictly between its ends) */
function meet(p: Point, q: Point, a: Point, b: Point): { at: Point; proper: boolean } | undefined {
  const [rx, ry, sx, sy] = [q[0] - p[0], q[1] - p[1], b[0] - a[0], b[1] - a[1]];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) {
    return undefined;
  }
  const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denominator;
  const u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / denominator;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) {
    return undefined;
  }
  return { at: [p[0] + rx * t, p[1] + ry * t], proper: t > eps && t < 1 - eps && u > eps && u < 1 - eps };
}

/** Items by the CELL_M squares their boxes touch: near(box, reach) has those whose boxes come within reach of box */
function index<T>(entries: { item: T; box: Rect }[]): { near: (box: Rect, reach: number) => T[] } {
  const cells = new Map<string, { item: T; box: Rect }[]>();
  const range = (box: Rect, reach: number) => ({
    x0: Math.floor((box.minX - reach) / CELL_M),
    x1: Math.floor((box.maxX + reach) / CELL_M),
    y0: Math.floor((box.minY - reach) / CELL_M),
    y1: Math.floor((box.maxY + reach) / CELL_M),
  });
  for (const entry of entries) {
    const { x0, x1, y0, y1 } = range(entry.box, 0);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const list = cells.get(`${x},${y}`);
        if (list) {
          list.push(entry);
        } else {
          cells.set(`${x},${y}`, [entry]);
        }
      }
    }
  }
  return {
    near(box, reach) {
      const found = new Set<{ item: T; box: Rect }>();
      const { x0, x1, y0, y1 } = range(box, reach);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (const entry of cells.get(`${x},${y}`) ?? []) {
            const b = entry.box;
            if (b.minX <= box.maxX + reach && b.maxX >= box.minX - reach && b.minY <= box.maxY + reach && b.maxY >= box.minY - reach) {
              found.add(entry);
            }
          }
        }
      }
      return [...found].map((entry) => entry.item);
    },
  };
}

/**
 * Gives each tile the stretches (buildingSteps' a and b) within REACH_M of it, also those of the buildings of the
 * tiles around: the ground beside the tile's edge steps where they do
 */
export function cutBuildingSteps(tiles: Map<string, Tile>, steps: readonly GroundStep[], size: number): void {
  for (const step of steps) {
    const box = bounds([step.a, step.b]);
    for (let y = Math.floor((box.minY - REACH_M) / size); y <= Math.floor((box.maxY + REACH_M) / size); y++) {
      for (let x = Math.floor((box.minX - REACH_M) / size); x <= Math.floor((box.maxX + REACH_M) / size); x++) {
        const tile = tiles.get(tileName({ x, y }));
        if (tile) {
          (tile.buildingSteps ??= []).push({ a: step.a, b: step.b });
        }
      }
    }
  }
}
