// Railway platforms. The elevation model has a platform as a ridge between the tracks, smoothed at its edges;
// a platform is level, so it gets one height: its top, the ground's median inside its outline. A tram stop's
// platform is as high over the tramways passing it instead, over their lowest bed beside it, so that a tram's
// floor clears it all along; where the tramway rises along it, as a street on a hill does, the platform rises with
// it, level across.
import { distanceToRing, orientedBox, pointInPolygon, ringCentroid, type Point } from "./geometry.ts";
import { bounds, type Area, type Rail } from "./osm.ts";

/** The ground inside a platform, and a tramway beside one, is sampled this often (m) */
const SAMPLE_M = 2;
/** railway=* kinds trams run on */
const TRAMS = new Set(["tram", "light_rail"]);
/** A tramway passes a platform within this of its outline (m) */
const TRAM_NEAR_M = 3;
/** A tram stop's platform is this high over the bed: the rails' tops about 0.15 m over it, the platform 0.25 m over
 * them, under a low floor (m) */
const TRAM_PLATFORM_M = 0.4;
/** A tramway's bed gives a platform its top only that near the ground's median inside it: further, the tramway passes
 * under or over it (m) */
const TRAM_FROM_GROUND_M = 2;
/** A tram stop's platform rises with the tramway beside it where that rises at least this much (m) along it */
const RISE_MIN_M = 0.1;

/** Sets `top` (and `slope`) on the platform areas, after the tramways' beds (trackbeds.ts). Returns how many got one. */
export function setPlatformTops(areas: Area[], heightAt: (e: number, n: number) => number | undefined, rails: Rail[] = []): number {
  const trams = rails.filter((r) => TRAMS.has(r.kind) && r.bed);
  let count = 0;
  for (const area of areas) {
    if (area.kind !== "platform") {
      continue;
    }
    const box = bounds(area.polygon.outer);
    const heights: number[] = [];
    for (let e = box.minX + SAMPLE_M / 2; e < box.maxX; e += SAMPLE_M) {
      for (let n = box.minY + SAMPLE_M / 2; n < box.maxY; n += SAMPLE_M) {
        const p: Point = [e, n];
        const h = pointInPolygon(p, area.polygon) ? heightAt(e, n) : undefined;
        if (h !== undefined) {
          heights.push(h);
        }
      }
    }
    heights.sort((a, b) => a - b);
    const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : undefined;
    // a tramway beside it, not one under or over it: a top near the ground's
    const beds = bedsBeside(area, trams, (h) => median === undefined || Math.abs(h + TRAM_PLATFORM_M - median) <= TRAM_FROM_GROUND_M);
    const slope = beds.length > 0 ? rising(area, beds) : undefined;
    if (slope) {
      const tops: [number, number] = [slope.beds[0] + TRAM_PLATFORM_M, slope.beds[1] + TRAM_PLATFORM_M];
      area.top = Math.min(...tops);
      area.slope = { ends: slope.ends, tops };
      count++;
      continue;
    }
    const top = beds.length > 0 ? Math.min(...beds.map(({ h }) => h)) + TRAM_PLATFORM_M : median;
    if (top !== undefined) {
      area.top = top;
      count++;
    }
  }
  return count;
}

/** A platform's top at p: a rising one's along its slope, as far as p is along the line between its ends */
export function platformTopAt(area: Area, p: Point): number | undefined {
  const slope = area.slope;
  if (!slope) {
    return area.top;
  }
  const [[e1, n1], [e2, n2]] = slope.ends;
  const [de, dn] = [e2 - e1, n2 - n1];
  const length2 = de * de + dn * dn;
  const t = length2 > 0 ? ((p[0] - e1) * de + (p[1] - n1) * dn) / length2 : 0;
  return slope.tops[0] + (slope.tops[1] - slope.tops[0]) * t;
}

/** The bed (h) of the tramways within TRAM_NEAR_M of the platform's outline at points (p) SAMPLE_M apart along them,
 * of the heights keep(h) is true for */
function bedsBeside(area: Area, trams: Rail[], keep: (h: number) => boolean): { p: Point; h: number }[] {
  const box = bounds(area.polygon.outer);
  const beds: { p: Point; h: number }[] = [];
  for (const tram of trams) {
    const bed = tram.bed;
    const near = bounds(tram.line);
    if (!bed || near.minX > box.maxX + TRAM_NEAR_M || near.maxX < box.minX - TRAM_NEAR_M || near.minY > box.maxY + TRAM_NEAR_M || near.maxY < box.minY - TRAM_NEAR_M) {
      continue;
    }
    for (let i = 1; i < tram.line.length; i++) {
      const [a, b] = [tram.line[i - 1], tram.line[i]];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / SAMPLE_M));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (distanceToRing(p, area.polygon.outer) <= TRAM_NEAR_M || pointInPolygon(p, area.polygon)) {
          const h = bed[i - 1] + (bed[i] - bed[i - 1]) * t;
          if (keep(h)) {
            beds.push({ p, h });
          }
        }
      }
    }
  }
  return beds;
}

/**
 * How the beds beside a platform rise along it, fitted to a straight line along its long side, under all of them: the
 * two ends of the side's middle line through the platform's centroid and the line's height abeam each; undefined
 * where they rise less than RISE_MIN_M over its length
 */
function rising(area: Area, beds: { p: Point; h: number }[]): { ends: [Point, Point]; beds: [number, number] } | undefined {
  const { angle, length } = orientedBox(area.polygon.outer);
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  const [ce, cn] = ringCentroid(area.polygon.outer);
  const along = beds.map(({ p }) => (p[0] - ce) * dx + (p[1] - cn) * dy);
  const meanS = along.reduce((sum, s) => sum + s, 0) / beds.length;
  const meanH = beds.reduce((sum, { h }) => sum + h, 0) / beds.length;
  let spread = 0;
  let together = 0;
  beds.forEach(({ h }, i) => {
    spread += (along[i] - meanS) ** 2;
    together += (along[i] - meanS) * (h - meanH);
  });
  const grade = spread > 0 ? together / spread : 0;
  if (Math.abs(grade) * length < RISE_MIN_M) {
    return undefined;
  }
  const half = length / 2;
  // lowered as far as the line is over any of the beds, so that the platform is nowhere higher over one, and its
  // lower end no higher than over the lowest of them (where a street's rails at a junction lie lower than the bed)
  const fit = (s: number) => meanH + grade * (s - meanS);
  const over = Math.max(...beds.map(({ h }, i) => fit(along[i]) - h), Math.min(fit(-half), fit(half)) - Math.min(...beds.map(({ h }) => h)));
  const bedAt = (s: number) => fit(s) - over;
  return {
    ends: [
      [ce - dx * half, cn - dy * half],
      [ce + dx * half, cn + dy * half],
    ],
    beds: [bedAt(-half), bedAt(half)],
  };
}
