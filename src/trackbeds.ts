// Track beds: railways rise and fall gently, so a line's bed is the ground averaged along it, never more
// than BURY_M under the ground. Lines meeting end to end share its height: a deck or tunnel floor ending
// there, else the ground averaged around it. Tramways meeting end to end, two at a point, are one line for
// this, their changes of grade are rounded to vertical curves, under a deck their bed leaves a tram its room, and
// one branching off another's middle ends at that one's bed.
import { densify } from "./tunnels.ts";
import type { Point } from "./geometry.ts";
import type { Rail } from "./osm.ts";

/** railway=* kinds that get beds, trams too */
const BED_KINDS = new Set(["rail", "narrow_gauge", "preserved", "subway", "tram", "light_rail"]);
const TRAM_KINDS = new Set(["tram", "light_rail"]);
/** The ground is averaged over this long a stretch, centred on each point (m) */
const BED_WINDOW_M = 30;
/** The ground along a line is sampled this often (m) */
const SAMPLE_M = 2;
/** A line is densified to this step before simplifying (m) */
const BED_STEP_M = 10;
/** The bed is at most this far under the ground under it (m), but where a tramway's curves or a deck take it */
const BURY_M = 0.5;
/** The ground at a line's end is averaged within this radius (m) */
const END_RADIUS_M = 10;
/** Points are dropped where the line and its bed stay this close to straight without them (m) */
const TOLERANCE_M = 0.05;
/** and a tramway's, whose curves are kept closer (m) */
const TRAM_TOLERANCE_M = 0.02;
/** A tramway's bed bends no tighter than this radius (m), over a crest or through a dip */
const TRAM_CURVE_M = 300;
/** A tramway's bed is rounded in at most this many sweeps along it */
const ROUNDING_SWEEPS = 2000;
/** A branch's end is this near (m) the line it branches off, which the simplified line strays from by its tolerance */
const BRANCH_M = 0.5;

/** A line of a chain, and whether it runs against the chain */
type Member = { rail: Rail; reversed: boolean };

/**
 * Sets `bed` (reshaping the line) on railway lines without decks or floors; returns how many got one. ceilingAt
 * gives the highest a tramway's bed may be at a point of a line on a layer (under a deck), or undefined. A point
 * another of the rails or of others (the roads' lines) has stays in a tramway's line: a junction or a level crossing.
 */
export function setTrackBeds(
  rails: Rail[],
  heightAt: (e: number, n: number) => number | undefined,
  ceilingAt: (p: Point, layer: number) => number | undefined = () => undefined,
  others: Point[][] = [],
): number {
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const used = new Map<string, number>();
  for (const line of [...rails.map((r) => r.line), ...others]) {
    for (const p of new Set(line.map(key))) {
      used.set(p, (used.get(p) ?? 0) + 1);
    }
  }
  const meets = (p: Point) => (used.get(key(p)) ?? 0) > 1;
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

  const eligible = rails.filter((rail) => BED_KINDS.has(rail.kind) && !rail.bridge && !rail.tunnel && !rail.deck && !rail.floor && rail.line.length >= 2);
  const lines = new Map(eligible.map((rail) => [rail, rail.line]));
  // the tramways' points between their ends, where another may branch off
  const middles = new Map<string, Rail>();
  for (const rail of eligible) {
    if (TRAM_KINDS.has(rail.kind)) {
      for (const p of rail.line.slice(1, -1)) {
        middles.set(key(p), rail);
      }
    }
  }
  const all = chains(eligible, new Set(decks.keys()));
  let count = 0;
  for (const chain of all) {
    if (setChainBed(chain, heightAt, endHeight, ceilingAt, meets)) {
      count += chain.length;
    }
  }
  // a tramway branching off another's middle ends at that one's bed there, once that has it
  for (const chain of all) {
    const [first, last] = [chain[0], chain[chain.length - 1]];
    const firstLine = lines.get(first.rail) ?? first.rail.line;
    const lastLine = lines.get(last.rail) ?? last.rail.line;
    const chainEnds = [first.reversed ? firstLine[firstLine.length - 1] : firstLine[0], last.reversed ? lastLine[0] : lastLine[lastLine.length - 1]];
    let branches = false;
    for (const p of chainEnds) {
      const main = middles.get(key(p));
      const h = main && !chain.some((m) => m.rail === main) && !decks.has(key(p)) ? bedAt(main, p) : undefined;
      if (h !== undefined) {
        ends.set(key(p), h);
        branches = true;
      }
    }
    if (branches) {
      for (const { rail } of chain) {
        rail.line = lines.get(rail) ?? rail.line;
      }
      setChainBed(chain, heightAt, endHeight, ceilingAt, meets);
    }
  }
  return count;
}

/** A line's bed (m) at its point nearest p, when that is within BRANCH_M of p */
function bedAt(rail: Rail, p: Point): number | undefined {
  const { line, bed } = rail;
  let best: { off: number; h: number } | undefined;
  for (let i = 1; bed && i < line.length; i++) {
    const [a, c] = [line[i - 1], line[i]];
    const length2 = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
    const t = length2 > 0 ? Math.min(Math.max(((p[0] - a[0]) * (c[0] - a[0]) + (p[1] - a[1]) * (c[1] - a[1])) / length2, 0), 1) : 0;
    const off = Math.hypot(a[0] + (c[0] - a[0]) * t - p[0], a[1] + (c[1] - a[1]) * t - p[1]);
    if (!best || off < best.off) {
      best = { off, h: bed[i - 1] + (bed[i] - bed[i - 1]) * t };
    }
  }
  return best && best.off <= BRANCH_M ? best.h : undefined;
}

/** The lines in chains: tramways joined end to end where exactly two meet and no deck or floor ends, others alone */
function chains(rails: Rail[], deckEnds: Set<string>): Member[][] {
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const trams = rails.filter((r) => TRAM_KINDS.has(r.kind));
  const byEnd = new Map<string, Rail[]>();
  for (const rail of trams) {
    for (const p of [rail.line[0], rail.line[rail.line.length - 1]]) {
      byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), rail]);
    }
  }
  // the line going on from rail at its end p, or undefined
  const onward = (rail: Rail, p: Point): Rail | undefined => {
    const there = byEnd.get(key(p)) ?? [];
    const other = there.find((r) => r !== rail);
    return there.length === 2 && other && !deckEnds.has(key(p)) ? other : undefined;
  };
  const out: Member[][] = rails.filter((r) => !TRAM_KINDS.has(r.kind)).map((rail) => [{ rail, reversed: false }]);
  const done = new Set<Rail>();
  for (const start of trams) {
    if (done.has(start)) {
      continue;
    }
    // back to the chain's first line, then along it
    let first = start;
    let reversed = false;
    const seen = new Set([start]);
    for (;;) {
      const p: Point = reversed ? first.line[first.line.length - 1] : first.line[0];
      const before: Rail | undefined = onward(first, p);
      if (!before || seen.has(before)) {
        break;
      }
      seen.add(before);
      reversed = key(before.line[0]) === key(p);
      first = before;
    }
    const chain: Member[] = [];
    let rail: Rail | undefined = first;
    let backwards = reversed;
    while (rail && !done.has(rail)) {
      done.add(rail);
      chain.push({ rail, reversed: backwards });
      const end = backwards ? rail.line[0] : rail.line[rail.line.length - 1];
      const next = onward(rail, end);
      backwards = next !== undefined && key(next.line[next.line.length - 1]) === key(end);
      rail = next;
    }
    out.push(chain);
  }
  return out;
}

/** Sets the beds of a chain's lines; false where it has no ground */
function setChainBed(
  chain: Member[],
  heightAt: (e: number, n: number) => number | undefined,
  endHeight: (p: Point) => number | undefined,
  ceilingAt: (p: Point, layer: number) => number | undefined,
  meets: (p: Point) => boolean,
): boolean {
  // the chain's line, densified, and where each member's points are in it
  const line: Point[] = [];
  const spans: [number, number][] = [];
  for (const { rail, reversed } of chain) {
    const points = densify(reversed ? [...rail.line].reverse() : rail.line, BED_STEP_M);
    const from = Math.max(0, line.length - 1);
    line.push(...(line.length > 0 ? points.slice(1) : points));
    spans.push([from, line.length - 1]);
  }
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
    return false;
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
  const tram = TRAM_KINDS.has(chain[0].rail.kind);
  if (tram) {
    // under a deck, the lowest ceiling within a point's segments on either side, so the line between stays under it
    const layer = chain[0].rail.layer;
    const ceilings = samples.map((s) => ({ d: s.d, c: ceilingAt(pointAt(line, along, s.d), layer) }));
    const ceiling = along.map((d, i) => {
      const from = along[Math.max(0, i - 1)];
      const to = along[Math.min(along.length - 1, i + 1)];
      const under = ceilings.filter((s) => s.c !== undefined && s.d >= from && s.d <= to).map((s) => s.c ?? Infinity);
      return under.length > 0 ? Math.min(...under) : Infinity;
    });
    // a deck the curves cannot pass under (too near the line's ends) is left over it
    const rounded = [...bed];
    if (round(rounded, along, ceiling)) {
      bed.splice(0, bed.length, ...rounded);
    } else {
      round(bed, along, along.map(() => Infinity));
    }
  }
  chain.forEach(({ rail, reversed }, k) => {
    const [from, to] = spans[k];
    const points = line.slice(from, to + 1);
    const heights = bed.slice(from, to + 1);
    if (reversed) {
      points.reverse();
      heights.reverse();
    }
    const kept = simplifyProfile(points, heights, tram ? TRAM_TOLERANCE_M : TOLERANCE_M, (p) => tram && meets(p));
    rail.line = kept.map((i) => points[i]);
    rail.bed = kept.map((i) => heights[i]);
  });
  return true;
}

/**
 * Rounds a bed (heights at points along[i] meters along its line, its ends kept) to vertical curves no tighter than
 * TRAM_CURVE_M, under the ceilings at its points. A point off the chord between its neighbours by more than such a
 * curve's bend there is brought back to it with them, by the least change of the three, and points over their
 * ceiling down to it, sweep after sweep until none moves.
 */
function round(heights: number[], along: number[], ceiling: number[]): boolean {
  const last = heights.length - 1;
  for (let sweep = 0; sweep < ROUNDING_SWEEPS; sweep++) {
    let moved = 0;
    for (let i = 1; i < last; i++) {
      const a = along[i] - along[i - 1];
      const b = along[i + 1] - along[i];
      if (a <= 0 || b <= 0) {
        continue;
      }
      const [before, after] = [b / (a + b), a / (a + b)];
      const off = heights[i] - before * heights[i - 1] - after * heights[i + 1];
      const bend = (a * b) / (2 * TRAM_CURVE_M);
      const excess = off > bend ? off - bend : off < -bend ? off + bend : 0;
      if (excess === 0) {
        continue;
      }
      // the ends stay where they are
      const [wb, wa] = [i - 1 > 0 ? before : 0, i + 1 < last ? after : 0];
      const norm = wb * wb + 1 + wa * wa;
      heights[i - 1] += (excess * wb) / norm;
      heights[i] -= excess / norm;
      heights[i + 1] += (excess * wa) / norm;
      moved = Math.max(moved, Math.abs(excess));
    }
    for (let i = 1; i < last; i++) {
      if (heights[i] > ceiling[i]) {
        moved = Math.max(moved, heights[i] - ceiling[i]);
        heights[i] = ceiling[i];
      }
    }
    if (moved < 1e-4) {
      return true;
    }
  }
  return false;
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

/** Indices of points to keep so the line and its heights stay within tolerance of straight between them, and the
 * points keep says */
function simplifyProfile(line: Point[], heights: number[], tolerance: number, keep: (p: Point) => boolean): number[] {
  const kept = [0];
  let from = 0;
  while (from < line.length - 1) {
    let to = from + 1;
    while (to + 1 < line.length && !keep(line[to]) && straight(line, heights, from, to + 1, tolerance)) {
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
