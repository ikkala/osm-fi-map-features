// Roofs of wings: an outline of square corners, an L, a T, a U, is cut at its inner corners into rectangles, its
// wings, in each way it can be, and each way of cutting gives ridges: the largest wing's along its length, gable to
// gable, and each other wing's from its outer end into the ridge of the wing it joins. With hipped ends the ridges
// stop short of the outline by half their wing's width. ridgeRoofs (roofRidges.ts) draws a roof from such ridges, and
// its share of the roof's height at a point is what laserRoofShapes.ts fits to the laser scanning's points.
import { boxCentre, orientedBox, pointInRing, simplifyRing, type Point, type Ring } from "./geometry.ts";
import type { Building } from "./osm.ts";
import { ridgeRoofs } from "./roofRidges.ts";

/** An edge is along the box's sides when it turns at most this much from them (radians) */
const SQUARE_TOLERANCE = (12 * Math.PI) / 180;
/** Corners closer than this (m) are one, and coordinates closer than this one line */
const MERGE_M = 0.3;
/** Outlines with more corners than this are not cut into wings */
const MAX_CORNERS = 12;
/** A wing's ridge runs along it only where it is clearly longer than wide, but a wing joining another */
const LONGER_BY = 1.1;

/** The ridges of a way of cutting an outline into wings, gabled and hipped, and half its main wing's width (m) */
export interface WingRidges {
  gabled: Point[][];
  hipped: Point[][];
  run: number;
}

interface Wing {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Along u (0) or v (1) */
  axis?: 0 | 1;
}

/**
 * The outline turned to its oriented box's frame and squared: its corners, each between an edge along u and one
 * along v, or undefined when an edge runs at a slant or the outline has too few or too many corners
 */
function squared(ring: Ring, toLocal: (p: Point) => Point): Point[] | undefined {
  const local = simplifyRing(ring, MERGE_M / 2).map(toLocal);
  // each edge's axis and its coordinate across it
  const edges: { axis: 0 | 1; at: number }[] = [];
  for (let i = 0; i < local.length; i++) {
    const [a, b] = [local[i], local[(i + 1) % local.length]];
    const [du, dv] = [b[0] - a[0], b[1] - a[1]];
    if (Math.hypot(du, dv) < MERGE_M) {
      continue;
    }
    const angle = Math.atan2(Math.abs(dv), Math.abs(du));
    const axis: 0 | 1 | undefined = angle <= SQUARE_TOLERANCE ? 0 : angle >= Math.PI / 2 - SQUARE_TOLERANCE ? 1 : undefined;
    if (axis === undefined) {
      return undefined;
    }
    const at = axis === 0 ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
    const last = edges[edges.length - 1];
    if (last && last.axis === axis) {
      last.at = (last.at + at) / 2;
    } else {
      edges.push({ axis, at });
    }
  }
  if (edges.length > 1 && edges[0].axis === edges[edges.length - 1].axis) {
    const last = edges.pop();
    if (last) {
      edges[0].at = (edges[0].at + last.at) / 2;
    }
  }
  if (edges.length < 6 || edges.length > MAX_CORNERS || edges.length % 2 !== 0) {
    return undefined;
  }
  // a corner where each edge meets the next
  return edges.map((edge, i) => {
    const next = edges[(i + 1) % edges.length];
    return edge.axis === 0 ? [next.at, edge.at] : [edge.at, next.at];
  });
}

/** Values closer than MERGE_M as one, sorted */
function lines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > MERGE_M) {
      out.push(v);
    }
  }
  return out;
}

const nearest = (values: number[], v: number) => values.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(values[best] - v) ? i : best), 0);

/**
 * The ways an outline of square corners cuts into wings, each its ridges in the outline's frame; none for an outline
 * that is not one (a rectangle has its own shapes)
 */
export function wingRidges(ring: Ring): WingRidges[] {
  const box = orientedBox(ring);
  const centre = boxCentre(ring, box.angle);
  const [cos, sin] = [Math.cos(box.angle), Math.sin(box.angle)];
  const toLocal = ([e, n]: Point): Point => [(e - centre[0]) * cos + (n - centre[1]) * sin, -(e - centre[0]) * sin + (n - centre[1]) * cos];
  const toWorld = ([u, v]: Point): Point => [centre[0] + u * cos - v * sin, centre[1] + u * sin + v * cos];
  const corners = squared(ring, toLocal);
  if (!corners) {
    return [];
  }
  const us = lines(corners.map(([u]) => u));
  const vs = lines(corners.map(([, v]) => v));
  const [nu, nv] = [us.length - 1, vs.length - 1];
  const inside: boolean[][] = [];
  for (let i = 0; i < nu; i++) {
    inside.push([]);
    for (let j = 0; j < nv; j++) {
      inside[i].push(pointInRing([(us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2], corners));
    }
  }
  const cell = (i: number, j: number) => i >= 0 && j >= 0 && i < nu && j < nv && inside[i][j];
  // the inner corners: turning against the outline's way round
  const area = corners.reduce((sum, [u, v], i) => sum + u * corners[(i + 1) % corners.length][1] - corners[(i + 1) % corners.length][0] * v, 0);
  const reflex = corners.filter((c, i) => {
    const [a, b] = [corners[(i + corners.length - 1) % corners.length], corners[(i + 1) % corners.length]];
    const cross = (c[0] - a[0]) * (b[1] - c[1]) - (c[1] - a[1]) * (b[0] - c[0]);
    return Math.sign(cross) === -Math.sign(area);
  });
  if (reflex.length === 0 || reflex.length > 4) {
    return [];
  }
  const out: WingRidges[] = [];
  const seen = new Set<string>();
  for (let choice = 0; choice < 1 << reflex.length; choice++) {
    // the cuts: from each inner corner along u or v through the outline's inside, as walls between cells
    const walls = new Set<string>();
    for (const [k, [u, v]] of reflex.entries()) {
      const [i0, j0] = [nearest(us, u), nearest(vs, v)];
      if ((choice >> k) & 1) {
        // along u, a wall between rows j0 - 1 and j0, both ways from the corner while cells are inside on both sides
        for (const step of [1, -1]) {
          for (let i = step > 0 ? i0 : i0 - 1; cell(i, j0 - 1) && cell(i, j0); i += step) {
            walls.add(`v${i},${j0}`);
          }
        }
      } else {
        for (const step of [1, -1]) {
          for (let j = step > 0 ? j0 : j0 - 1; cell(i0 - 1, j) && cell(i0, j); j += step) {
            walls.add(`u${i0},${j}`);
          }
        }
      }
    }
    const wings = cut(nu, nv, cell, walls, us, vs);
    const key = wings?.map((w) => [w.u0, w.u1, w.v0, w.v1].map((x) => x.toFixed(1)).join(",")).sort().join(";");
    if (!wings || wings.length < 2 || key === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const ridges = ridgesOf(wings, corners);
    // a hipped wing too short for a ridge of its own is no roof of hipped wings
    const length = (line: Point[]) => Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
    if (ridges && ridges.hipped.some((line) => length(line) < MERGE_M)) {
      ridges.hipped = [];
    }
    if (ridges) {
      out.push({ gabled: ridges.gabled.map((line) => line.map(toWorld)), hipped: ridges.hipped.map((line) => line.map(toWorld)), run: ridges.run });
    }
  }
  return out;
}

/** The wings the cells make between the walls, or undefined when one is not a rectangle */
function cut(nu: number, nv: number, cell: (i: number, j: number) => boolean, walls: Set<string>, us: number[], vs: number[]): Wing[] | undefined {
  const label: number[][] = Array.from({ length: nu }, () => Array.from({ length: nv }, () => -1));
  const wings: Wing[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      if (!cell(i, j) || label[i][j] >= 0) {
        continue;
      }
      const id = wings.length;
      const stack: [number, number][] = [[i, j]];
      label[i][j] = id;
      const members: [number, number][] = [];
      while (stack.length > 0) {
        const top = stack.pop();
        if (!top) {
          break;
        }
        const [a, b] = top;
        members.push([a, b]);
        const next: [number, number, string][] = [
          [a + 1, b, `u${a + 1},${b}`],
          [a - 1, b, `u${a},${b}`],
          [a, b + 1, `v${a},${b + 1}`],
          [a, b - 1, `v${a},${b}`],
        ];
        for (const [x, y, wall] of next) {
          if (cell(x, y) && label[x][y] < 0 && !walls.has(wall)) {
            label[x][y] = id;
            stack.push([x, y]);
          }
        }
      }
      const [i0, i1] = [Math.min(...members.map(([a]) => a)), Math.max(...members.map(([a]) => a))];
      const [j0, j1] = [Math.min(...members.map(([, b]) => b)), Math.max(...members.map(([, b]) => b))];
      if (members.length !== (i1 - i0 + 1) * (j1 - j0 + 1)) {
        return undefined;
      }
      wings.push({ u0: us[i0], u1: us[i1 + 1], v0: vs[j0], v1: vs[j1 + 1] });
    }
  }
  return wings;
}

/** Whether a stretch of a line along u (at v, from a to b) or along v lies on the outline */
function onOutline(corners: Point[], axis: 0 | 1, at: number, a: number, b: number): boolean {
  const covered = corners.flatMap((c, i) => {
    const d = corners[(i + 1) % corners.length];
    const edgeAxis = Math.abs(c[1] - d[1]) < 1e-6 ? 0 : 1;
    if (edgeAxis !== axis || Math.abs((axis === 0 ? c[1] : c[0]) - at) > MERGE_M) {
      return [];
    }
    const [x, y] = axis === 0 ? [c[0], d[0]] : [c[1], d[1]];
    return [[Math.min(x, y), Math.max(x, y)]];
  });
  // the stretch's middle and both ends a little in, each on an edge
  return [a + (b - a) * 0.05, (a + b) / 2, a + (b - a) * 0.95].every((p) => covered.some(([x, y]) => p >= x - MERGE_M && p <= y + MERGE_M));
}

/** The wings' ridges, gabled and hipped, or undefined when the wings do not join as a roof of wings can */
function ridgesOf(wings: Wing[], corners: Point[]): { gabled: Point[][]; hipped: Point[][]; run: number } | undefined {
  const size = (w: Wing) => (w.u1 - w.u0) * (w.v1 - w.v0);
  const main = wings.reduce((best, w) => (size(w) > size(best) ? w : best), wings[0]);
  const [mu, mv] = [main.u1 - main.u0, main.v1 - main.v0];
  if (Math.max(mu, mv) < LONGER_BY * Math.min(mu, mv)) {
    return undefined;
  }
  main.axis = mu >= mv ? 0 : 1;
  const gabled: Point[][] = [];
  const hipped: Point[][] = [];
  // the main wing first, then each joining one already placed
  const placed: Wing[] = [main];
  const ridgeOf = (w: Wing, axis: 0 | 1, from: number, to: number, hipFrom: boolean, hipTo: boolean) => {
    const across = axis === 0 ? (w.v0 + w.v1) / 2 : (w.u0 + w.u1) / 2;
    const half = (axis === 0 ? w.v1 - w.v0 : w.u1 - w.u0) / 2;
    const [a, b] = [from + (hipFrom ? Math.sign(to - from) * half : 0), to - (hipTo ? Math.sign(to - from) * half : 0)];
    const line = (s: number, t: number): Point[] => (axis === 0 ? [[s, across], [t, across]] : [[across, s], [across, t]]);
    gabled.push(line(from, to));
    hipped.push(line(a, b));
  };
  {
    const [from, to] = main.axis === 0 ? [main.u0, main.u1] : [main.v0, main.v1];
    const ends = [from, to].map((at) => (main.axis === 0 ? onOutline(corners, 1, at, main.v0, main.v1) : onOutline(corners, 0, at, main.u0, main.u1)));
    if (!ends[0] || !ends[1]) {
      return undefined;
    }
    ridgeOf(main, main.axis, from, to, true, true);
  }
  const rest = wings.filter((w) => w !== main);
  while (rest.length > 0) {
    // a wing sharing a side with one placed, whose ridge runs across that side
    let joined = false;
    for (const w of rest) {
      for (const p of placed) {
        const shared = sharedSide(w, p);
        if (!shared || p.axis === undefined || shared.axis !== p.axis) {
          continue;
        }

        const axis: 0 | 1 = shared.axis === 0 ? 1 : 0;
        const pRidge = p.axis === 0 ? (p.v0 + p.v1) / 2 : (p.u0 + p.u1) / 2;
        const [lo, hi] = axis === 0 ? [w.u0, w.u1] : [w.v0, w.v1];
        const outer = Math.abs(lo - shared.at) < Math.abs(hi - shared.at) ? hi : lo;
        const outerOnOutline = axis === 0 ? onOutline(corners, 1, outer, w.v0, w.v1) : onOutline(corners, 0, outer, w.u0, w.u1);
        if (!outerOnOutline) {
          continue;
        }
        w.axis = axis;
        ridgeOf(w, axis, outer, pRidge, true, false);
        placed.push(w);
        rest.splice(rest.indexOf(w), 1);
        joined = true;
        break;
      }
      if (joined) {
        break;
      }
    }
    if (!joined) {
      return undefined;
    }
  }
  return { gabled, hipped, run: Math.min(mu, mv) / 2 };
}

/** The side two wings share: along u (axis 0, at v) or v, if they touch along one */
function sharedSide(a: Wing, b: Wing): { axis: 0 | 1; at: number } | undefined {
  const overlap = (x0: number, x1: number, y0: number, y1: number) => Math.min(x1, y1) - Math.max(x0, y0) > MERGE_M;
  if ((Math.abs(a.v1 - b.v0) < MERGE_M || Math.abs(a.v0 - b.v1) < MERGE_M) && overlap(a.u0, a.u1, b.u0, b.u1)) {
    return { axis: 0, at: Math.abs(a.v1 - b.v0) < MERGE_M ? a.v1 : a.v0 };
  }
  if ((Math.abs(a.u1 - b.u0) < MERGE_M || Math.abs(a.u0 - b.u1) < MERGE_M) && overlap(a.v0, a.v1, b.v0, b.v1)) {
    return { axis: 1, at: Math.abs(a.u1 - b.u0) < MERGE_M ? a.u1 : a.u0 };
  }
  return undefined;
}

/**
 * The share of the roof's height ridgeRoofs draws from the ridges over the outline at a point (0 at the eaves, 1 at
 * the ridges), or undefined when it draws none from them
 */
export function roofShareOf(ring: Ring, ridges: Point[][]): ((p: Point) => number | undefined) | undefined {
  const building: Building = {
    osm: "",
    kind: "yes",
    part: false,
    hasParts: false,
    height: 10,
    minHeight: 0,
    roofHeight: 1,
    roofShapeEstimated: true,
    polygon: { outer: ring, holes: [] },
  };
  if (ridgeRoofs([building], ridges) === 0 || !building.roofFaces) {
    return undefined;
  }
  const { points, triangles } = building.roofFaces;
  const at = (k: number): [number, number, number] => [points[3 * k], points[3 * k + 1], points[3 * k + 2]];
  return ([e, n]) => {
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [at(triangles[t]), at(triangles[t + 1]), at(triangles[t + 2])];
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-12) {
        continue;
      }
      const l1 = ((b[1] - c[1]) * (e - c[0]) + (c[0] - b[0]) * (n - c[1])) / det;
      const l2 = ((c[1] - a[1]) * (e - c[0]) + (a[0] - c[0]) * (n - c[1])) / det;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
        return l1 * a[2] + l2 * b[2] + l3 * c[2];
      }
    }
    return undefined;
  };
}
