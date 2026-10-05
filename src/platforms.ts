// Railway platforms. The elevation model has a platform as a ridge between the tracks, smoothed at its edges;
// a platform is level, so it gets one height: its top, the ground's median inside its outline.
import { pointInPolygon, type Point } from "./geometry.ts";
import { bounds, type Area } from "./osm.ts";

/** The ground inside a platform is sampled this often (m) */
const SAMPLE_M = 2;

/** Sets `top` on the platform areas. Returns how many got one. */
export function setPlatformTops(areas: Area[], heightAt: (e: number, n: number) => number | undefined): number {
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
    if (heights.length === 0) {
      continue;
    }
    heights.sort((a, b) => a - b);
    area.top = heights[Math.floor(heights.length / 2)];
    count++;
  }
  return count;
}
