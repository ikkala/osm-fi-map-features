// Roofs drawn from their ridge lines (Simple 3D Buildings' roof lines: roof:ridge=yes ways on a roof:shape=many
// building or part): a ridge running across the outline from side to side splits it into the roof's slopes, which
// rise from the eaves at the outline to the ridge. A ridge may bend, as one along a curving wing does, which the
// shapes from roof:shape and roof:orientation cannot draw.
import { distanceToSegment, nearestOnSegment, pointInRing, type Point } from "./geometry.ts";
import type { Building } from "./osm.ts";

/** A ridge's end within this (m) of the outline is on it */
const SNAP_M = 0.5;

/**
 * A roof as triangles over the outline: each point east, north and its share of the roof's height (0 at the eaves,
 * 1 at the ridge), and three point indices per triangle. A point with a share over 0 on the outline is where a
 * ridge meets the wall: the gable under it rises to it.
 */
export interface RoofFaces {
  points: number[];
  triangles: number[];
}

/** A ring of points, each with its share of the roof's height */
type Ring = { point: Point; share: number }[];
/** A part of the roof between a ridge and the rest of its ring: both chains from the ridge's start to its end */
interface Slope {
  ring: Ring;
  side: Ring;
  ridge: Ring;
}

/** Where p is on the ring within SNAP_M: the edge it is on (from vertex i to i + 1) and the point there */
function onRing(ring: Ring, p: Point): { edge: number; point: Point } | undefined {
  let best: { edge: number; point: Point; distance: number } | undefined;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i].point;
    const b = ring[(i + 1) % ring.length].point;
    const distance = distanceToSegment(p, a, b);
    if (distance <= SNAP_M && (!best || distance < best.distance)) {
      best = { edge: i, point: nearestOnSegment(p, a, b), distance };
    }
  }
  return best;
}

/** The ring's vertex at p, at the ridge's height: the one p is at, else a new one on the edge p is on */
function place(ring: Ring, p: Point): Ring[number] | undefined {
  const at = onRing(ring, p);
  if (!at) {
    return undefined;
  }
  for (const k of [at.edge, (at.edge + 1) % ring.length]) {
    const v = ring[k].point;
    if (Math.hypot(v[0] - at.point[0], v[1] - at.point[1]) < 1e-3) {
      ring[k] = { point: v, share: 1 };
      return ring[k];
    }
  }
  const vertex = { point: at.point, share: 1 };
  ring.splice(at.edge + 1, 0, vertex);
  return vertex;
}

/** The two slopes a ridge from side to side splits a ring into, or undefined when it does not reach both sides */
function split(ring: Ring, ridge: Point[]): [Slope, Slope] | undefined {
  const copy = [...ring];
  const start = place(copy, ridge[0]);
  const end = start && place(copy, ridge[ridge.length - 1]);
  if (!start || !end || start === end) {
    return undefined;
  }
  const i = copy.indexOf(start);
  const j = copy.indexOf(end);
  const along: Ring = [start, ...ridge.slice(1, -1).map((point) => ({ point, share: 1 })), end];
  const walk = (from: number, to: number) => {
    const out: Ring = [];
    for (let k = from; ; k = (k + 1) % copy.length) {
      out.push(copy[k]);
      if (k === to) {
        return out;
      }
    }
  };
  // one slope round the ring from the ridge's start to its end, the other from its end to its start
  const one = walk(i, j);
  const other = walk(j, i).reverse();
  const inside = along.slice(1, -1);
  return [
    { ring: [...one, ...[...inside].reverse()], side: one, ridge: along },
    { ring: [...other.slice().reverse(), ...inside], side: other, ridge: along },
  ];
}

/** The length along a chain to each of its points, as a share of its whole length */
function shares(chain: Ring): number[] {
  const out = [0];
  for (let k = 1; k < chain.length; k++) {
    const [a, b] = [chain[k - 1].point, chain[k].point];
    out.push(out[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = out[out.length - 1] || 1;
  return out.map((d) => d / total);
}

/**
 * A slope's triangles, its points added to faces: strips from its side to the ridge, going on along whichever is
 * behind, so each runs from the eaves up to the ridge; and not out of the slope where its side turns in.
 */
function addSlope(faces: RoofFaces, slope: Slope): void {
  const { side, ridge } = slope;
  const base = faces.points.length / 3;
  for (const { point, share } of [...side, ...ridge]) {
    faces.points.push(point[0], point[1], share);
  }
  const s = shares(side);
  const r = shares(ridge);
  const ring = slope.ring.map(({ point }) => point);
  const inside = (a: Point, b: Point, c: Point) => pointInRing([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3], ring);
  const add = (a: number, b: number, c: number) => {
    const [p, q, t] = [a, b, c].map((k) => [faces.points[3 * (base + k)], faces.points[3 * (base + k) + 1]]);
    if (Math.abs((q[0] - p[0]) * (t[1] - p[1]) - (q[1] - p[1]) * (t[0] - p[0])) > 1e-9) {
      faces.triangles.push(base + a, base + b, base + c);
    }
  };
  let i = 0;
  let k = 0;
  while (i < side.length - 1 || k < ridge.length - 1) {
    const ridgeAt = side.length + k;
    let onSide = k === ridge.length - 1 || (i < side.length - 1 && s[i + 1] <= r[k + 1]);
    if (i < side.length - 1 && k < ridge.length - 1) {
      const bySide = inside(side[i].point, side[i + 1].point, ridge[k].point);
      const byRidge = inside(side[i].point, ridge[k + 1].point, ridge[k].point);
      if (onSide && !bySide && byRidge) {
        onSide = false;
      } else if (!onSide && !byRidge && bySide) {
        onSide = true;
      }
    }
    if (onSide) {
      add(i, i + 1, ridgeAt);
      i++;
    } else {
      add(i, ridgeAt + 1, ridgeAt);
      k++;
    }
  }
}

/**
 * Gives the buildings and parts a roof from the ridges inside them (roofFaces): those that draw no pitched shape of
 * their own and have a roof's height, and no holes; an outline with parts leaves its roof to them. A ridge goes in
 * the slope its middle is in, and splits it when its ends are on that slope's sides; one that does not is left out.
 * Returns how many buildings got one.
 */
export function ridgeRoofs(buildings: Building[], ridges: Point[][]): number {
  let count = 0;
  for (const building of buildings) {
    const outer = building.polygon.outer;
    if (building.hasParts || building.polygon.holes.length > 0 || !building.roofHeight || (building.roofShape && !building.roofShapeEstimated)) {
      continue;
    }
    const mine = ridges.filter((ridge) => ridge.length >= 2 && pointInRing(middle(ridge), outer));
    if (mine.length === 0) {
      continue;
    }
    let slopes: Slope[] = [];
    let rings: Ring[] = [outer.map((point) => ({ point, share: 0 }))];
    for (const ridge of mine) {
      const at = middle(ridge);
      const index = rings.findIndex((ring) => pointInRing(at, ring.map(({ point }) => point)));
      const halves = index >= 0 ? split(rings[index], ridge) : undefined;
      if (halves) {
        // a slope split again is two new ones
        slopes = [...slopes.filter((slope) => slope.ring !== rings[index]), ...halves];
        rings = [...rings.slice(0, index), ...halves.map((slope) => slope.ring), ...rings.slice(index + 1)];
      }
    }
    if (slopes.length < 2) {
      continue;
    }
    const faces: RoofFaces = { points: [], triangles: [] };
    for (const slope of slopes) {
      addSlope(faces, slope);
    }
    building.roofFaces = faces;
    delete building.roofShape;
    delete building.roofAngle;
    delete building.roofShapeEstimated;
    count++;
  }
  return count;
}

/** The point halfway along a line */
function middle(line: Point[]): Point {
  const lengths = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]));
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
    }
    left -= lengths[i];
  }
  return line[line.length - 1];
}
