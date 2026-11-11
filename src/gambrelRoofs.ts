// Gambrel roofs: two slopes on either side of the ridge, the lower one much steeper, which hold a storey in the roof.
// Fitted to the laser scanning's points (laserScanning.ts) over an outline near its box, the ridge along the box or
// across it: the points out to the eaves count, where the lower slopes are, and the ridge may lie a little off the
// box's middle line, as an outline drawn on an aerial photograph lies a little off the roof. For each offset of the
// ridge and each place of the knee, z = top - slope * min(d, knee) - lowerSlope * max(d - knee, 0) with d the
// distance from the ridge is fitted by least squares, the far points left out a few rounds over, and so a gabled roof
// on the same points; the best is the one the points lie nearest, each counted at most MISS_CAP_M, so that a
// chimney's or a tree's do not outweigh the lower slopes' few. It is a gambrel roof (isGambrel) where its slopes bend
// as one's do and its lower slopes' points, on both sides, lie much nearer it than a gabled roof: dormers on them
// and lower roofs beside them make the whole roof's misses alike. The roof is drawn as triangles (roofFaces) over the
// outline, centred on its box, the knee's share of the roof's height along the outline's sides.
import { boxCentre, orientedBox, ringArea, triangulate, type Point, type Polygon } from "./geometry.ts";
import { GUESS_MIN_FILL, type Building } from "./osm.ts";
import type { RoofFaces } from "./roofRidges.ts";

export interface GambrelFit {
  /** 0 with the ridge along the long side of the outline's oriented box, 90 across it */
  angle: number;
  /** How far (m) the ridge lies off the box's middle line, to the left of the ridge's direction */
  offset: number;
  /** The knee's distance from the ridge, a share of the way to the eaves */
  knee: number;
  /** From the eaves at the outline to the top (m) */
  rise: number;
  /** The top (m above sea level) */
  top: number;
  /** Rise over run of the upper slopes, and of the lower */
  slope: number;
  lowerSlope: number;
  /** The mean distance of the points from the fit, each counted at most MISS_CAP_M (m) */
  miss: number;
  /** The median distance of the lower slopes' points from the fit, and from a gabled roof fitted to the same points (m) */
  lowerMiss: number;
  gabledLowerMiss: number;
  /** The points on the lower slopes: the fewer of the two sides' */
  lowerPoints: number;
}

/** How far (m) the ridge may lie off the box's middle line, and the steps it is tried in */
const OFFSET_M = 1.5;
const OFFSET_STEP_M = 0.25;
/** The knee's places tried, as shares of the way from the ridge to the eaves */
const KNEES = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
/** Points this close (m) to the gable ends, and to the eaves, are left out (walls, misalignment) */
const END_MARGIN_M = 0.5;
const EAVE_MARGIN_M = 0.3;
/** A point's distance from a fit counts at most this much (m) */
const MISS_CAP_M = 0.6;
/** Fewer points than this tell no gambrel roof */
const MIN_POINTS = 24;
/** Rounds of leaving out the points far off the fit, and how far: this many times the typical miss, at least the floor */
const TRIM_ROUNDS = 3;
const TRIM_TIMES = 3;
const TRIM_FLOOR_M = 0.3;

/** Points near an outline (east, north, height) that its gambrel roof is fitted to reach this far (m) past it */
export const GAMBREL_REACH_M = OFFSET_M + 0.5;

/** The least squares fit of z = c0 + c1 * x1 + c2 * x2 over the rows (x1, x2, z), or undefined where it is singular */
function solve(rows: [number, number, number][]): [number, number, number] | undefined {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (const [x1, x2, z] of rows) {
    const x = [1, x1, x2];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        m[3 * i + j] += x[i] * x[j];
      }
      r[i] += x[i] * z;
    }
  }
  const det = (a: number[]) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det(m);
  if (Math.abs(d) < 1e-6 * Math.max(1, m[0] ** 3)) {
    return undefined;
  }
  const column = (k: number) => m.map((v, index) => (index % 3 === k ? r[Math.floor(index / 3)] : v));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
}

/** The least squares fit of z = c0 + c1 * x1 over the rows (x1, unused, z), c2 0, or undefined where it is singular */
function line(rows: [number, number, number][]): [number, number, number] | undefined {
  let [n, sx, sz, sxx, sxz] = [0, 0, 0, 0, 0];
  for (const [x, , z] of rows) {
    [n, sx, sz, sxx, sxz] = [n + 1, sx + x, sz + z, sxx + x * x, sxz + x * z];
  }
  const det = n * sxx - sx * sx;
  if (det <= 1e-9) {
    return undefined;
  }
  const c1 = (n * sxz - sx * sz) / det;
  return [(sz - c1 * sx) / n, c1, 0];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Fits z = top - slope * min(d, k) - lower * max(d - k, 0) to the points (distance from the ridge, height), the
 * far ones left out; k past every point fits a gabled roof. Returns the fit and its capped mean miss over all points.
 */
function fitProfile(points: [number, number][], k: number): { top: number; slope: number; lower: number; miss: number } | undefined {
  const gabled = points.every(([d]) => d <= k);
  let kept = points;
  let fit: { top: number; slope: number; lower: number } | undefined;
  for (let round = 0; round <= TRIM_ROUNDS; round++) {
    const rows = kept.map(([d, z]): [number, number, number] => [-Math.min(d, k), gabled ? 0 : -Math.max(d - k, 0), z]);
    const solved = gabled ? line(rows) : solve(rows);
    if (solved === undefined) {
      break;
    }
    const f = { top: solved[0], slope: solved[1], lower: solved[2] };
    fit = f;
    const misses = points.map(([d, z]) => Math.abs(z - (f.top - f.slope * Math.min(d, k) - f.lower * Math.max(d - k, 0))));
    const limit = Math.max(TRIM_TIMES * median(misses), TRIM_FLOOR_M);
    const next = points.filter((_, i) => misses[i] <= limit);
    if (next.length < MIN_POINTS / 2 || next.length === kept.length) {
      break;
    }
    kept = next;
  }
  if (fit === undefined) {
    return undefined;
  }
  const f = fit;
  const miss = points.reduce((sum, [d, z]) => sum + Math.min(MISS_CAP_M, Math.abs(z - (f.top - f.slope * Math.min(d, k) - f.lower * Math.max(d - k, 0)))), 0) / points.length;
  return { ...f, miss };
}

/**
 * The gambrel roof that fits the points near an outline best (east, north, height: those over the ground within
 * GAMBREL_REACH_M of it, inside or out), its ridge along the outline's box or across it; undefined with too few, or
 * for an outline with holes or far from its box (GUESS_MIN_FILL)
 */
export function fitGambrel(points: [number, number, number][], outline: Polygon): GambrelFit | undefined {
  const box = orientedBox(outline.outer);
  if (outline.holes.length > 0 || Math.abs(ringArea(outline.outer)) < GUESS_MIN_FILL * box.length * box.width) {
    return undefined;
  }
  const centre: Point = boxCentre(outline.outer, box.angle);
  const [cos, sin] = [Math.cos(box.angle), Math.sin(box.angle)];
  const local = points.map(([e, n, z]): [number, number, number] => {
    const [de, dn] = [e - centre[0], n - centre[1]];
    return [de * cos + dn * sin, -de * sin + dn * cos, z];
  });
  let best: GambrelFit | undefined;
  for (const angle of [0, 90]) {
    // along the ridge (s) and across it (t), and their half extents
    const [along, run] = angle === 0 ? [box.length / 2, box.width / 2] : [box.width / 2, box.length / 2];
    const turned = local.map(([u, v, z]) => (angle === 0 ? [u, v, z] : [v, -u, z]));
    let gambrel: GambrelFit | undefined;
    for (let offset = -OFFSET_M; offset <= OFFSET_M + 1e-9; offset += OFFSET_STEP_M) {
      const profile: [number, number][] = [];
      const sides: number[] = [];
      for (const [s, t, z] of turned) {
        if (Math.abs(s) <= along - END_MARGIN_M && Math.abs(t - offset) <= run - EAVE_MARGIN_M) {
          profile.push([Math.abs(t - offset), z]);
          sides.push(t >= offset ? 1 : 0);
        }
      }
      if (profile.length < MIN_POINTS) {
        continue;
      }
      const gabled = fitProfile(profile, Infinity);
      for (const share of KNEES) {
        const k = share * run;
        const fit = fitProfile(profile, k);
        if (!fit || (gambrel && fit.miss >= gambrel.miss)) {
          continue;
        }
        const lower = [0, 1].map((side) => profile.filter(([d], i) => sides[i] === side && d > k).length);
        const outer = profile.filter(([d]) => d > k);
        gambrel = {
          angle,
          offset,
          knee: share,
          rise: fit.slope * k + fit.lower * (run - k),
          top: fit.top,
          slope: fit.slope,
          lowerSlope: fit.lower,
          miss: fit.miss,
          lowerMiss: median(outer.map(([d, z]) => Math.abs(z - (fit.top - fit.slope * k - fit.lower * (d - k))))),
          gabledLowerMiss: gabled ? median(outer.map(([d, z]) => Math.abs(z - (gabled.top - gabled.slope * d)))) : Infinity,
          lowerPoints: Math.min(...lower),
        };
      }
    }
    if (gambrel && (!best || gambrel.miss < best.miss)) {
      best = gambrel;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const round = (x: number, by: number) => Math.round(x * by) / by;
  const b = best;
  return {
    angle: b.angle,
    offset: round(b.offset, 100),
    knee: round(b.knee, 100),
    rise: round(b.rise, 100),
    top: round(b.top, 100),
    slope: round(b.slope, 1000),
    lowerSlope: round(b.lowerSlope, 1000),
    miss: round(b.miss, 1000),
    lowerMiss: round(b.lowerMiss, 1000),
    gabledLowerMiss: round(b.gabledLowerMiss, 1000),
    lowerPoints: b.lowerPoints,
  };
}

/** The least and the most an upper slope may rise, the least and most a lower one, and the least they differ by (degrees) */
const MIN_UPPER_DEGREES = 12;
const MAX_UPPER_DEGREES = 40;
const MIN_LOWER_DEGREES = 40;
const MAX_LOWER_DEGREES = 80;
const MIN_BEND_DEGREES = 20;
/**
 * A gambrel roof's miss is at most this (m), and on its lower slopes at most this much, and this share of a gabled
 * roof's, which misses them by at least this much (m): the lower slopes' few points tell it apart
 */
const MAX_MISS_M = 0.22;
const MAX_LOWER_MISS_M = 0.4;
const GABLED_SHARE = 0.5;
const MIN_GABLED_LOWER_MISS_M = 0.4;
/** The fewer side's points on the lower slopes are at least this many */
const MIN_LOWER_POINTS = 4;
/** A gambrel roof rises at least this much (m), its lower slopes at least this much: a storey's walls, not a kick at the eaves */
const MIN_RISE_M = 2;
const MIN_LOWER_RISE_M = 1.5;

/** Whether a fit is a gambrel roof: its slopes bent as one's, fitting the points closely, much better than a gabled roof */
export function isGambrel(fit: GambrelFit): boolean {
  const degrees = (slope: number) => (Math.atan(slope) * 180) / Math.PI;
  const [upper, lower] = [degrees(fit.slope), degrees(fit.lowerSlope)];
  return (
    upper >= MIN_UPPER_DEGREES &&
    upper <= MAX_UPPER_DEGREES &&
    lower >= MIN_LOWER_DEGREES &&
    lower <= MAX_LOWER_DEGREES &&
    lower - upper >= MIN_BEND_DEGREES &&
    fit.miss <= MAX_MISS_M &&
    fit.lowerMiss <= MAX_LOWER_MISS_M &&
    fit.lowerMiss <= GABLED_SHARE * fit.gabledLowerMiss &&
    fit.gabledLowerMiss >= MIN_GABLED_LOWER_MISS_M &&
    fit.lowerPoints >= MIN_LOWER_POINTS &&
    fit.rise >= MIN_RISE_M &&
    fit.rise * kneeShare(fit) >= MIN_LOWER_RISE_M
  );
}

/** The share of a gambrel roof's height at its knee, from the eaves */
export function kneeShare(fit: Pick<GambrelFit, "knee" | "slope" | "lowerSlope">): number {
  const lower = fit.lowerSlope * (1 - fit.knee);
  return lower / (fit.slope * fit.knee + lower);
}

/** The points of a ring with t (across the ridge) between lo and hi, its edges cut where they cross them */
function clipBetween(ring: Point[], t: (p: Point) => number, lo: number, hi: number): Point[] {
  let out = ring;
  for (const [limit, keep] of [
    [lo, (x: number) => x >= lo - 1e-9],
    [hi, (x: number) => x <= hi + 1e-9],
  ] as const) {
    const next: Point[] = [];
    for (let i = 0; i < out.length; i++) {
      const [a, b] = [out[i], out[(i + 1) % out.length]];
      const [ta, tb] = [t(a), t(b)];
      if (keep(ta)) {
        next.push(a);
      }
      if (keep(ta) !== keep(tb)) {
        const k = (limit - ta) / (tb - ta);
        next.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * A gambrel roof's faces over an outline (map metres), its ridge at angle (radians counter-clockwise from east)
 * through the middle of the outline's extent across it: the outline cut into the four slopes, each triangulated, every
 * point with its share of the roof's height, kneeShare at the knee, a share knee of the way from the ridge to the eaves
 */
export function gambrelFaces(outer: Point[], angle: number, knee: number, kneeHeight: number): RoofFaces {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const across = (p: Point) => -p[0] * sin + p[1] * cos;
  const ts = outer.map(across);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  const middle = (t0 + t1) / 2;
  const run = (t1 - t0) / 2;
  const t = (p: Point) => across(p) - middle;
  const share = (p: Point) => {
    const d = Math.min(1, Math.abs(t(p)) / run);
    return d <= knee ? 1 - ((1 - kneeHeight) * d) / knee : (kneeHeight * (1 - d)) / (1 - knee);
  };
  const faces: RoofFaces = { points: [], triangles: [] };
  const k = knee * run;
  for (const [lo, hi] of [
    [-run - 1, -k],
    [-k, 0],
    [0, k],
    [k, run + 1],
  ]) {
    const piece = clipBetween(outer, t, lo, hi);
    if (piece.length < 3) {
      continue;
    }
    const start = faces.points.length / 3;
    for (const p of piece) {
      faces.points.push(p[0], p[1], Math.round(share(p) * 1000) / 1000);
    }
    for (const index of triangulate({ outer: piece, holes: [] })) {
      faces.triangles.push(start + index);
    }
  }
  return faces;
}

/**
 * Where OSM tags a gambrel roof the knee is this share of the way from the ridge to the eaves, at this share of the
 * roof's height: about where the laser scanning finds it
 */
const TAGGED_KNEE = 0.65;
const TAGGED_KNEE_HEIGHT = 0.7;

/**
 * Draws the gabled roofs OSM tags gambrel (roofGambrel) by their faces (gambrelFaces), the knee at TAGGED_KNEE, where
 * their outline has no holes and is near its box. Returns how many.
 */
export function taggedGambrels(buildings: Building[]): number {
  let count = 0;
  for (const b of buildings) {
    const box = orientedBox(b.polygon.outer);
    if (
      !b.roofGambrel ||
      b.roofShape !== "gabled" ||
      b.roofAngle === undefined ||
      !b.roofHeight ||
      b.roofFaces ||
      b.polygon.holes.length > 0 ||
      Math.abs(ringArea(b.polygon.outer)) < GUESS_MIN_FILL * box.length * box.width
    ) {
      continue;
    }
    b.roofFaces = gambrelFaces(b.polygon.outer, (b.roofAngle * Math.PI) / 180, TAGGED_KNEE, TAGGED_KNEE_HEIGHT);
    delete b.roofShape;
    delete b.roofAngle;
    count++;
  }
  return count;
}
