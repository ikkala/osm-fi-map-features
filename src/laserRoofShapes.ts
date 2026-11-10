// Roof shapes from the laser scanning's points on a roof (laserScanning.ts): the shapes the map draws (gabled and
// hipped with the ridge along the outline's oriented box or across it, pyramidal, skillion) and a flat one, each
// fitted to the points by least squares in the box's frame, the points far off the fit left out a few rounds over
// (chimneys, dormers, trees over the eaves); for an outline of wings (an L, a T, a U: roofWings.ts) also each way of
// cutting it into wings, gabled and hipped, as ridgeRoofs draws it. The fits are kept (laserScanning.ts caches them) and the shape chosen from
// them: a pitched one only where it fits the points closely, much better than a flat roof, is no steeper than a roof
// is drawn and rises enough to tell, of shapes that fit about as well the simpler one; else a flat one only where the
// points lie flat, not on trees (a building newer than the scanning) nor a roof of many levels.
import { boxCentre, orientedBox, ringArea, type Point, type Polygon } from "./geometry.ts";
import { GUESS_MIN_FILL, roofDegrees, type Building, type RoofShape } from "./osm.ts";
import { ridgeRoofs } from "./roofRidges.ts";
import { roofShareOf, wingRidges } from "./roofWings.ts";

export interface LaserRoofShape {
  /** No shape: a flat roof */
  shape?: RoofShape;
  /**
   * Degrees counter-clockwise from the long side of the outline's oriented box (orientedBox): the ridge's direction,
   * or the direction a skillion roof slopes down to; the same in any frame the outline is turned in
   */
  angle: number;
  /** From the eaves to the top (m) */
  rise: number;
  /** The top (m above sea level) */
  top: number;
  /** A roof of wings (gabled or hipped): which of the outline's ways of cutting into them (wingRidges) */
  wings?: number;
}

/** Fewer points than this on a roof tell no shape */
export const MIN_SHAPE_POINTS = 12;
/** A pitched roof rises at least this much (m) from its eaves to its top */
const MIN_RISE_M = 1.2;
/** Slopes (rise over run) a pitched roof may have */
const MIN_SLOPE = Math.tan((10 * Math.PI) / 180);
const MAX_SLOPE = Math.tan((60 * Math.PI) / 180);
/** A pitched shape's typical miss is at most this share of a flat roof's */
const PITCHED_SHARE = 0.6;
/** A pitched shape's typical miss is at most this (m) */
const MAX_MISS_M = 0.3;
/** A flat roof's typical miss is at most this (m): a roof's points, not a tree's crown */
const MAX_FLAT_MISS_M = 0.15;
/** A simpler shape is taken over a better fitting one when its typical miss is at most this much more */
const SIMPLER_BY = 1.15;
/** Rounds of leaving out the points far off the fit, and how far: this many times the typical miss, at least the floor */
const TRIM_ROUNDS = 3;
const TRIM_TIMES = 3;
const TRIM_FLOOR_M = 0.3;

/** A shape fitted to a roof's points: angle, rise and top as in LaserRoofShape */
export interface RoofFit {
  /** No shape: a flat roof */
  shape?: RoofShape;
  angle: number;
  rise: number;
  top: number;
  /** The median distance of all the points from the fit (m) */
  miss: number;
  /** Rise over run */
  slope: number;
  /** As in LaserRoofShape */
  wings?: number;
}

/** Fits z = top - slope * d(u, v) to the points, leaving out the far ones; undefined with too few left */
function fitDown(points: [number, number, number][], d: (u: number, v: number) => number): { top: number; slope: number; miss: number } | undefined {
  let kept = points;
  let fit: { top: number; slope: number } | undefined;
  for (let round = 0; round <= TRIM_ROUNDS; round++) {
    // least squares of z = top - slope * d
    let [n, sd, sz, sdd, sdz] = [0, 0, 0, 0, 0];
    for (const [u, v, z] of kept) {
      const x = d(u, v);
      [n, sd, sz, sdd, sdz] = [n + 1, sd + x, sz + z, sdd + x * x, sdz + x * z];
    }
    const det = n * sdd - sd * sd;
    const slope = det > 1e-9 ? -(n * sdz - sd * sz) / det : 0;
    fit = { top: (sz + slope * sd) / n, slope };
    const f = fit;
    const misses = points.map(([u, v, z]) => Math.abs(z - (f.top - f.slope * d(u, v))));
    const limit = Math.max(TRIM_TIMES * median(misses), TRIM_FLOOR_M);
    const next = points.filter((_, i) => misses[i] <= limit);
    if (next.length < MIN_SHAPE_POINTS / 2 || next.length === kept.length) {
      break;
    }
    kept = next;
  }
  if (fit === undefined) {
    return undefined;
  }
  const f = fit;
  return { ...f, miss: median(points.map(([u, v, z]) => Math.abs(z - (f.top - f.slope * d(u, v))))) };
}

/** Fits a plane z = c + gu * u + gv * v, leaving out the far points */
function fitPlane(points: [number, number, number][]): { c: number; gu: number; gv: number; miss: number } | undefined {
  let kept = points;
  let plane: { c: number; gu: number; gv: number } | undefined;
  for (let round = 0; round <= TRIM_ROUNDS; round++) {
    let [n, su, sv, sz, suu, svv, suv, suz, svz] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const [u, v, z] of kept) {
      [n, su, sv, sz] = [n + 1, su + u, sv + v, sz + z];
      [suu, svv, suv, suz, svz] = [suu + u * u, svv + v * v, suv + u * v, suz + u * z, svz + v * z];
    }
    // centred normal equations
    const [mu, mv, mz] = [su / n, sv / n, sz / n];
    const [cuu, cvv, cuv, cuz, cvz] = [suu / n - mu * mu, svv / n - mv * mv, suv / n - mu * mv, suz / n - mu * mz, svz / n - mv * mz];
    const det = cuu * cvv - cuv * cuv;
    if (Math.abs(det) < 1e-9) {
      return undefined;
    }
    const gu = (cuz * cvv - cvz * cuv) / det;
    const gv = (cvz * cuu - cuz * cuv) / det;
    plane = { c: mz - gu * mu - gv * mv, gu, gv };
    const p = plane;
    const misses = points.map(([u, v, z]) => Math.abs(z - (p.c + p.gu * u + p.gv * v)));
    const limit = Math.max(TRIM_TIMES * median(misses), TRIM_FLOOR_M);
    const next = points.filter((_, i) => misses[i] <= limit);
    if (next.length < MIN_SHAPE_POINTS / 2 || next.length === kept.length) {
      break;
    }
    kept = next;
  }
  if (plane === undefined) {
    return undefined;
  }
  const p = plane;
  return { ...p, miss: median(points.map(([u, v, z]) => Math.abs(z - (p.c + p.gu * u + p.gv * v)))) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The shape of a roof from the points on it, as chooseRoofShape chooses from fitRoofShapes' fits */
export function fitRoofShape(points: [number, number, number][], outline: Polygon): LaserRoofShape | undefined {
  return chooseRoofShape(fitRoofShapes(points, outline));
}

/**
 * Every shape fitted to a roof's points (easting, northing and height, in the outline's frame), the flat one first;
 * none when they are too few.
 */
export function fitRoofShapes(points: [number, number, number][], outline: Polygon): RoofFit[] {
  if (points.length < MIN_SHAPE_POINTS) {
    return [];
  }
  const box = orientedBox(outline.outer);
  const centre: Point = boxCentre(outline.outer, box.angle);
  const [cos, sin] = [Math.cos(box.angle), Math.sin(box.angle)];
  // along the box's long side (u) and across it (v), from its centre
  const local = points.map(([e, n, z]): [number, number, number] => {
    const [de, dn] = [e - centre[0], n - centre[1]];
    return [de * cos + dn * sin, -de * sin + dn * cos, z];
  });
  const [a, b] = [box.length / 2, box.width / 2];
  const fits: RoofFit[] = [];
  const flat = fitDown(local, () => 0);
  if (flat === undefined) {
    return [];
  }
  fits.push({ angle: 0, rise: 0, top: flat.top, miss: flat.miss, slope: 0 });
  // the pitched shapes, simplest first: z falls from the ridge with the distance d, rising slope * run in all
  const shapes: { shape: RoofShape; angle: number; d: (u: number, v: number) => number; run: number }[] = [
    { shape: "gabled", angle: 0, d: (_, v) => Math.abs(v), run: b },
    { shape: "gabled", angle: 90, d: (u) => Math.abs(u), run: a },
    { shape: "hipped", angle: 0, d: (u, v) => Math.max(Math.abs(v), Math.abs(u) - (a - b)), run: b },
    { shape: "pyramidal", angle: 0, d: (u, v) => Math.max((Math.abs(u) * b) / a, Math.abs(v)), run: b },
  ];
  for (const { shape, angle, d, run } of shapes) {
    const fit = fitDown(local, d);
    if (fit) {
      fits.push({ shape, angle, rise: fit.slope * run, top: fit.top, miss: fit.miss, slope: fit.slope });
    }
  }
  const plane = fitPlane(local);
  if (plane) {
    const slope = Math.hypot(plane.gu, plane.gv);
    // down the slope, and the roof's extent that way
    const down = Math.atan2(-plane.gv, -plane.gu);
    const run = 2 * (a * Math.abs(Math.cos(down)) + b * Math.abs(Math.sin(down)));
    const top = Math.max(...[-a, a].flatMap((u) => [-b, b].map((v) => plane.c + plane.gu * u + plane.gv * v)));
    fits.push({ shape: "skillion", angle: (((down * 180) / Math.PI) % 360 + 360) % 360, rise: slope * run, top, miss: plane.miss, slope });
  }
  // the roofs of wings, in the outline's frame: their share of the roof's height from the eaves
  if (outline.holes.length === 0) {
    for (const [index, ways] of wingRidges(outline.outer).entries()) {
      for (const [shape, ridges] of [["gabled", ways.gabled], ["hipped", ways.hipped]] as const) {
        const share = roofShareOf(outline.outer, ridges);
        if (!share) {
          continue;
        }
        const on = points.filter(([e, n]) => share([e, n]) !== undefined);
        const fit = on.length >= MIN_SHAPE_POINTS ? fitDown(on, (e, n) => 1 - (share([e, n]) ?? 0)) : undefined;
        if (fit) {
          // the points off the roof drawn count as missed by the flat fit's typical miss
          const miss = (fit.miss * on.length + flat.miss * (points.length - on.length)) / points.length;
          fits.push({ shape, angle: 0, rise: fit.slope, top: fit.top, miss, slope: fit.slope / ways.run, wings: index });
        }
      }
    }
  }
  const round = (x: number, by: number) => Math.round(x * by) / by;
  return fits.map((f) => ({ ...f, angle: round(f.angle, 10), rise: round(f.rise, 100), top: round(f.top, 100), miss: round(f.miss, 1000), slope: round(f.slope, 1000) }));
}

/** The shape of a roof from its fits (fitRoofShapes), or undefined when none fits well, not even a flat one */
export function chooseRoofShape(fits: readonly RoofFit[]): LaserRoofShape | undefined {
  const flat = fits.find((f) => f.shape === undefined);
  if (flat === undefined) {
    return undefined;
  }
  const pitched = fits.filter(
    (f) => f.shape && f.rise >= MIN_RISE_M && f.slope >= MIN_SLOPE && f.slope <= MAX_SLOPE && f.miss <= MAX_MISS_M && f.miss <= PITCHED_SHARE * flat.miss,
  );
  if (pitched.length === 0) {
    return flat.miss <= MAX_FLAT_MISS_M ? { angle: 0, rise: 0, top: flat.top } : undefined;
  }
  const best = Math.min(...pitched.map((f) => f.miss));
  const { shape, angle, rise, top, wings } = pitched.find((f) => f.miss <= best * SIMPLER_BY) ?? pitched[0];
  return { shape, angle, rise, top, ...(wings !== undefined && { wings }) };
}

/** Roofs at least this big (m²) take the shape the laser scanning tells */
export const MIN_SHAPED_AREA_M2 = 40;

export interface LaserShapeMatch {
  /** Buildings given a pitched roof of the shape the points tell */
  pitched: number;
  /** Buildings whose guessed pitched roof the points tell flat */
  flattened: number;
}

/**
 * Gives the buildings and parts OSM tells no roof shape of (nor ridges), of MIN_SHAPED_AREA_M2 at least, the shape
 * their points tell (shapeOf): a pitched one where the outline is nearly its box (GUESS_MIN_FILL), turned as the box
 * is in the map's frame, or a roof of wings drawn from their ridges (ridgeRoofs), its rise at most half the
 * building's height; flat where the points tell flat. A building whose height is estimated takes the measured top too.
 */
export function applyLaserShapes(buildings: Building[], shapeOf: (b: Building) => LaserRoofShape | undefined): LaserShapeMatch {
  const result: LaserShapeMatch = { pitched: 0, flattened: 0 };
  for (const b of buildings) {
    const measured = shapeOf(b);
    const area = Math.abs(ringArea(b.polygon.outer));
    if (!measured || b.roofFaces || !b.roofShapeEstimated || area < MIN_SHAPED_AREA_M2 || b.base === undefined) {
      continue;
    }
    if (b.heightEstimated && measured.top - b.base > MIN_RISE_M) {
      b.height = measured.top - b.base;
      delete b.heightEstimated;
      delete b.heightFromLevels;
      delete b.heightByType;
    }
    if (measured.shape === undefined) {
      if (b.roofShape) {
        delete b.roofShape;
        delete b.roofAngle;
        delete b.roofHeight;
        delete b.roofHeightEstimated;
        result.flattened++;
      }
      continue;
    }
    if (measured.wings !== undefined) {
      // a roof of wings as ridgeRoofs draws it from their ridges in the map's frame
      const ways = wingRidges(b.polygon.outer)[measured.wings];
      const roofHeight = Math.min(measured.rise, b.height / 2);
      const before = { roofShape: b.roofShape, roofAngle: b.roofAngle, roofHeight: b.roofHeight };
      b.roofHeight = roofHeight;
      if (ways && ridgeRoofs([b], measured.shape === "hipped" ? ways.hipped : ways.gabled) > 0) {
        delete b.roofHeightEstimated;
        result.pitched++;
      } else {
        Object.assign(b, before);
      }
      continue;
    }
    const box = orientedBox(b.polygon.outer);
    if (b.polygon.holes.length > 0 || area < GUESS_MIN_FILL * box.length * box.width) {
      continue;
    }
    b.roofShape = measured.shape;
    b.roofAngle = roofDegrees(box.angle + (measured.angle * Math.PI) / 180);
    b.roofHeight = Math.min(measured.rise, b.height / 2);
    delete b.roofHeightEstimated;
    result.pitched++;
  }
  return result;
}
