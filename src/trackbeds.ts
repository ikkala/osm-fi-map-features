// Track beds: railways rise and fall gently, so a line's bed is the ground averaged along it, never more
// than BURY_M under the ground. Lines meeting at an end share its height: a deck or tunnel floor ending
// there, else the ground averaged around it.
import { densify } from "./tunnels.ts";
import type { Point } from "./geometry.ts";
import type { Rail } from "./osm.ts";

/** railway=* kinds that get beds; trams run in the streets, at the ground */
const BED_KINDS = new Set(["rail", "narrow_gauge", "preserved", "subway"]);
/** The ground is averaged over this long a stretch, centred on each point (m) */
const BED_WINDOW_M = 30;
/** The ground along a line is sampled this often (m) */
const SAMPLE_M = 2;
/** A line is densified to this step before simplifying (m) */
const BED_STEP_M = 10;
/** The bed is at most this far under the ground under it (m) */
const BURY_M = 0.5;
/** The ground at a line's end is averaged within this radius (m) */
const END_RADIUS_M = 10;
/** Points are dropped where the line and its bed stay this close to straight without them (m) */
const TOLERANCE_M = 0.05;

/** Sets `bed` (reshaping the line) on railway lines without decks or floors; returns how many got one. */
export function setTrackBeds(rails: Rail[], heightAt: (e: number, n: number) => number | undefined): number {
  const key = (p: Point) => `${p[0]},${p[1]}`;
  // lines ending on a deck or tunnel floor end at its height
  const decks = new Map<string, number>();
  for (const rail of rails) {
    const heights = rail.deck ?? rail.floor;
    if (heights && rail.line.length >= 2) {
      decks.set(key(rail.line[0]), heights[0]);
      decks.set(key(rail.line[rail.line.length - 1]), heights[heights.length - 1]);
    }
  }
  const ends = new Map<string, number | undefined>();
  const endHeight = (p: Point) => {
    if (!ends.has(key(p))) {
      ends.set(key(p), decks.get(key(p)) ?? averageAround(p, heightAt));
    }
    return ends.get(key(p));
  };

  let count = 0;
  for (const rail of rails) {
    if (!BED_KINDS.has(rail.kind) || rail.bridge || rail.tunnel || rail.deck || rail.floor || rail.line.length < 2) {
      continue;
    }
    const line = densify(rail.line, BED_STEP_M);
    const along = [0];
    for (let i = 1; i < line.length; i++) {
      along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    }
    const length = along[along.length - 1];
    // the ground every SAMPLE_M along the line
    const samples: { d: number; h: number }[] = [];
    const steps = Math.max(1, Math.ceil(length / SAMPLE_M));
    for (let k = 0; k <= steps; k++) {
      const d = (length * k) / steps;
      const h = heightAt(...pointAt(line, along, d));
      if (h !== undefined) {
        samples.push({ d, h });
      }
    }
    const first = endHeight(line[0]);
    const last = endHeight(line[line.length - 1]);
    if (samples.length === 0 || first === undefined || last === undefined) {
      continue;
    }
    const average = (d: number) => {
      const near = samples.filter((s) => Math.abs(s.d - d) <= BED_WINDOW_M / 2);
      return near.length > 0 ? near.reduce((sum, s) => sum + s.h, 0) / near.length : undefined;
    };
    const [atStart, atEnd] = [average(0), average(length)];
    const half = BED_WINDOW_M / 2;
    const bed = along.map((d, i) => {
      const smooth = average(d) ?? heightAt(...line[i]) ?? first;
      // bent to the ends' heights over half a window from each end
      const toStart = atStart === undefined ? 0 : (first - atStart) * Math.max(0, 1 - d / half);
      const toEnd = atEnd === undefined ? 0 : (last - atEnd) * Math.max(0, 1 - (length - d) / half);
      const ground = heightAt(...line[i]);
      const h = i === 0 ? first : i === line.length - 1 ? last : smooth + toStart + toEnd;
      return ground === undefined || i === 0 || i === line.length - 1 ? h : Math.max(h, ground - BURY_M);
    });
    const kept = simplifyProfile(line, bed, TOLERANCE_M);
    rail.line = kept.map((i) => line[i]);
    rail.bed = kept.map((i) => bed[i]);
    count++;
  }
  return count;
}

/** The ground averaged over the SAMPLE_M grid within END_RADIUS_M of p, or undefined where there is none */
function averageAround(p: Point, heightAt: (e: number, n: number) => number | undefined): number | undefined {
  let sum = 0;
  let count = 0;
  for (let dx = -END_RADIUS_M; dx <= END_RADIUS_M; dx += SAMPLE_M) {
    for (let dy = -END_RADIUS_M; dy <= END_RADIUS_M; dy += SAMPLE_M) {
      const h = Math.hypot(dx, dy) <= END_RADIUS_M ? heightAt(p[0] + dx, p[1] + dy) : undefined;
      if (h !== undefined) {
        sum += h;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : undefined;
}

/** The point d meters along a line whose points are along[i] meters from its start */
function pointAt(line: Point[], along: number[], d: number): Point {
  for (let i = 1; i < line.length; i++) {
    if (d <= along[i] || i === line.length - 1) {
      const span = along[i] - along[i - 1];
      const t = span > 0 ? Math.min(Math.max((d - along[i - 1]) / span, 0), 1) : 0;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
  }
  return line[0];
}

/** Indices of points to keep so the line and its heights stay within tolerance of straight between them. */
function simplifyProfile(line: Point[], heights: number[], tolerance: number): number[] {
  const kept = [0];
  let from = 0;
  while (from < line.length - 1) {
    let to = from + 1;
    while (to + 1 < line.length && straight(line, heights, from, to + 1, tolerance)) {
      to++;
    }
    kept.push(to);
    from = to;
  }
  return kept;
}

function straight(line: Point[], heights: number[], from: number, to: number, tolerance: number): boolean {
  const [a, c] = [line[from], line[to]];
  const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
  for (let i = from + 1; i < to; i++) {
    const p = line[i];
    const t = length > 0 ? ((p[0] - a[0]) * (c[0] - a[0]) + (p[1] - a[1]) * (c[1] - a[1])) / (length * length) : 0;
    const off = Math.hypot(a[0] + (c[0] - a[0]) * t - p[0], a[1] + (c[1] - a[1]) * t - p[1]);
    const h = heights[from] + (heights[to] - heights[from]) * t;
    if (off > tolerance || Math.abs(h - heights[i]) > tolerance) {
      return false;
    }
  }
  return true;
}
