// Railway platforms. The elevation model has a platform as a ridge between the tracks, smoothed at its edges;
// a platform is level, so it gets one height: its top, the ground's median inside its outline. A tram stop's
// platform is as high over the tramways passing it instead, over their lowest bed beside it, so that a tram's
// floor clears it all along.
import { distanceToRing, pointInPolygon, type Point } from "./geometry.ts";
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

/** Sets `top` on the platform areas, after the tramways' beds (trackbeds.ts). Returns how many got one. */
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
    const bed = lowestBedBeside(area, trams, (h) => median === undefined || Math.abs(h + TRAM_PLATFORM_M - median) <= TRAM_FROM_GROUND_M);
    const top = bed !== undefined ? bed + TRAM_PLATFORM_M : median;
    if (top !== undefined) {
      area.top = top;
      count++;
    }
  }
  return count;
}

/** The lowest bed of the tramways within TRAM_NEAR_M of the platform's outline, sampled every SAMPLE_M along them,
 * of the heights keep(h) is true for */
function lowestBedBeside(area: Area, trams: Rail[], keep: (h: number) => boolean): number | undefined {
  const box = bounds(area.polygon.outer);
  let lowest: number | undefined;
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
            lowest = lowest === undefined ? h : Math.min(lowest, h);
          }
        }
      }
    }
  }
  return lowest;
}
