// Bridge deck heights. The elevation model is bare ground, so a deck instead runs from the ground at
// one end of a span (bridge ways joined end to end) to the other, through the heights steps up to it
// tell, bending one way only. The model smooths the cut under a bridge into a wider hollow, so ends
// are taken where the approach stops rising steeply.
import type { Point } from "./geometry.ts";

export interface BridgeLine {
  bridge: boolean;
  line: Point[];
  /** Deck height (meters above sea level) at every point of line; set by setBridgeDecks */
  deck?: number[];
  /** Steps: how many, and whether they climb along line or go down it */
  stepCount?: number;
  incline?: "up" | "down";
}

/** The approach is walked this often, and at most this far from the bridge's end (m) */
const APPROACH_STEP_M = 2;
const APPROACH_REACH_M = 24;
/** The ground has stopped rising steeply where it rises less than this in a step (m) */
const APPROACH_RISE_M = 0.2;
/** The hollow's bottom may reach on this far from the bridge's end before the ground starts rising (m) */
const APPROACH_LEVEL_M = 6;
/** A step's rise (m) */
const RISER_M = 0.16;
/** A deck's crest is rounded over a curve of this radius (m), with a point this often (m) */
const CREST_RADIUS_M = 400;
const CREST_STEP_M = 2;
/** Maximum rounds of junction height averaging */
const JUNCTION_ROUNDS = 1000;

/**
 * Sets `deck` on every bridge line: straight along each span between its ends, also over the model's hump under
 * it (the ground under a bridge is the gap spanned from the ground around). Steps with a count and a way they
 * climb, from the ground to a point of the span, tell its height there (RISER_M a step): the deck then runs
 * straight between the heights on the upper hull of them and its ends, rising and falling but never dipping, its
 * crests rounded (CREST_RADIUS_M, the lines getting points over them).
 * Returns how many points of spans steps told the height of.
 * Approaches are split off the lines leading on and get decks too. heightAt takes meters east / north. An end that
 * no line leads on from but ways indoors do (indoors) goes into a building, at whatever floor: it takes no height
 * from the ground, so the deck runs level from the span's other end. A line through a building (through) from one
 * bridge's end to another's carries the span on through it, getting a deck as the bridges do.
 */
export function setBridgeDecks<T extends BridgeLine>(
  lines: T[],
  heightAt: (e: number, n: number) => number | undefined,
  indoors: (p: Point) => boolean = () => false,
  through: (line: T) => boolean = () => false,
): number {
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const bridgeEnds = new Set(lines.filter((l) => l.bridge && l.line.length >= 2).flatMap((l) => [key(l.line[0]), key(l.line[l.line.length - 1])]));
  const carried = new Set(
    lines.filter((l) => !l.bridge && l.line.length >= 2 && through(l) && bridgeEnds.has(key(l.line[0])) && bridgeEnds.has(key(l.line[l.line.length - 1]))),
  );
  const bridges = lines.filter((l) => (l.bridge || carried.has(l)) && l.line.length >= 2);
  // the lines leading on from bridges, by their ends
  const onward = new Map<string, T[]>();
  for (const l of lines) {
    if (!l.bridge && !carried.has(l) && l.line.length >= 2) {
      for (const p of [l.line[0], l.line[l.line.length - 1]]) {
        onward.set(key(p), [...(onward.get(key(p)) ?? []), l]);
      }
    }
  }
  const byEnd = new Map<string, T[]>();
  for (const b of bridges) {
    for (const p of [b.line[0], b.line[b.line.length - 1]]) {
      const list = byEnd.get(key(p)) ?? [];
      list.push(b);
      byEnd.set(key(p), list);
    }
  }
  // the spans: walk both ways from each bridge line through ends shared by exactly two bridge lines
  const spans: { span: { bridge: T; reversed: boolean }[]; points: { p: Point; owner: T; index: number }[]; distances: number[] }[] = [];
  const done = new Set<BridgeLine>();
  for (const start of bridges) {
    if (done.has(start)) {
      continue;
    }
    const span: { bridge: T; reversed: boolean }[] = [{ bridge: start, reversed: false }];
    done.add(start);
    const extend = (atEnd: boolean) => {
      for (;;) {
        const edge = atEnd ? span[span.length - 1] : span[0];
        const line = edge.bridge.line;
        // the free end of the edge line in the direction we walk
        const free = (edge.reversed !== atEnd ? line[line.length - 1] : line[0]);
        const next = (byEnd.get(key(free)) ?? []).filter((b) => b !== edge.bridge);
        if (next.length !== 1 || done.has(next[0]) || (byEnd.get(key(free)) ?? []).length !== 2) {
          return;
        }
        const nextLine = next[0].line;
        const startsHere = key(nextLine[0]) === key(free);
        // walking forward, the next line should start at `free`; walking backward, end there
        const item = { bridge: next[0], reversed: atEnd ? !startsHere : startsHere };
        done.add(next[0]);
        if (atEnd) {
          span.push(item);
        } else {
          span.unshift(item);
        }
      }
    };
    extend(true);
    extend(false);

    // the span's points in order, and each one's distance along it
    const points: { p: Point; owner: T; index: number }[] = [];
    for (const { bridge, reversed } of span) {
      const indices = bridge.line.map((_, i) => i);
      if (reversed) {
        indices.reverse();
      }
      for (const i of indices) {
        points.push({ p: bridge.line[i], owner: bridge, index: i });
      }
    }
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      distances.push(distances[i - 1] + Math.hypot(points[i].p[0] - points[i - 1].p[0], points[i].p[1] - points[i - 1].p[1]));
    }
    spans.push({ span, points, distances });
  }

  // A junction (three or more bridge lines meet) has no ground of its own: its height is the average of
  // the spans' other ends, weighted by nearness, like a stretched net
  const junction = (k: string) => (byEnd.get(k) ?? []).length > 2;
  const ends = new Map<string, { height: number | undefined; approaches: Approach<T>[] }>();
  for (const { points } of spans) {
    for (const end of [points[0].p, points[points.length - 1].p]) {
      if (ends.has(key(end)) || junction(key(end))) {
        continue;
      }
      const approaches = (onward.get(key(end)) ?? []).filter((l) => l.deck === undefined).map((l) => approach(l, key(l.line[0]) === key(end), heightAt));
      const inBuilding = indoors(end) && (onward.get(key(end)) ?? []).length === 0;
      const heights = [inBuilding ? undefined : heightAt(...end), ...approaches.map((a) => a.top)].filter((h) => h !== undefined);
      ends.set(key(end), { height: heights.length > 0 ? Math.max(...heights) : undefined, approaches });
    }
  }
  const junctions = new Map<string, number>();
  const heightOf = (k: string) => (junction(k) ? junctions.get(k) : ends.get(k)?.height);
  for (let round = 0; round < JUNCTION_ROUNDS; round++) {
    let moved = 0;
    const sums = new Map<string, { sum: number; weight: number }>();
    for (const { points, distances } of spans) {
      const total = distances[distances.length - 1];
      const [k0, k1] = [key(points[0].p), key(points[points.length - 1].p)];
      for (const [k, other] of [[k0, k1], [k1, k0]]) {
        const h = heightOf(other);
        if (junction(k) && k !== other && total > 0 && h !== undefined) {
          const s = sums.get(k) ?? { sum: 0, weight: 0 };
          sums.set(k, { sum: s.sum + h / total, weight: s.weight + 1 / total });
        }
      }
    }
    for (const [k, { sum, weight }] of sums) {
      const h = sum / weight;
      moved = Math.max(moved, Math.abs(h - (junctions.get(k) ?? Infinity)));
      junctions.set(k, h);
    }
    if (moved < 0.001) {
      break;
    }
  }

  // the heights steps up to a point tell: from the ground at their other end, a riser a step
  const stepped = new Map<string, number>();
  for (const l of lines) {
    if (l.bridge || !l.stepCount || !l.incline || l.line.length < 2) {
      continue;
    }
    const [start, end] = [l.line[0], l.line[l.line.length - 1]];
    const rise = (l.incline === "up" ? 1 : -1) * l.stepCount * RISER_M;
    for (const [at, from, up] of [[end, start, rise], [start, end, -rise]] as const) {
      const ground = heightAt(...from);
      if (ground !== undefined) {
        stepped.set(key(at), Math.max(stepped.get(key(at)) ?? -Infinity, ground + up));
      }
    }
  }
  let told = 0;
  for (const { span, points, distances } of spans) {
    const total = distances[distances.length - 1];
    const first = heightOf(key(points[0].p));
    const last = heightOf(key(points[points.length - 1].p));
    // the known heights along the span: its ends, and where steps come up to it; an end without one is level
    const known: { d: number; h: number }[] = points.flatMap(({ p }, i) => {
      const h = stepped.get(key(p));
      return h === undefined ? [] : [{ d: distances[i], h }];
    });
    told += known.length;
    const a = first ?? known[0]?.h ?? last;
    const b = last ?? known[known.length - 1]?.h ?? first;
    const profile = a === undefined || b === undefined ? undefined : upperHull([{ d: 0, h: a }, ...known, { d: total, h: b }]);
    const curves = profile ? crests(profile) : [];
    // each line's points by their distance along the span, with points added where the deck curves
    const byOwner = new Map<T, Map<number, number>>();
    points.forEach(({ owner, index }, i) => byOwner.set(owner, (byOwner.get(owner) ?? new Map<number, number>()).set(index, distances[i])));
    for (const { bridge } of span) {
      const at = byOwner.get(bridge) ?? new Map<number, number>();
      const height = (d: number, p: Point) => (profile ? rounded(profile, curves, d) : heightAt(...p)) ?? 0;
      const line: Point[] = [];
      const deck: number[] = [];
      bridge.line.forEach((p, j) => {
        const d = at.get(j) ?? 0;
        if (j > 0) {
          const [q, d0] = [bridge.line[j - 1], at.get(j - 1) ?? 0];
          for (const x of over(curves, d0, d)) {
            const t = (x - d0) / (d - d0);
            const r: Point = [q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t];
            line.push(r);
            deck.push(height(x, r));
          }
        }
        line.push(p);
        deck.push(height(d, p));
      });
      bridge.line = line;
      bridge.deck = deck;
    }
  }
  for (const end of ends.values()) {
    for (const a of end.approaches) {
      if (end.height !== undefined && a.length > 0) {
        raiseApproach(lines, a, end.height, heightAt);
      }
    }
  }  return told;
}

/** The upper hull of heights by distance: the lowest line above them all that bends one way only */
export function upperHull(points: { d: number; h: number }[]): { d: number; h: number }[] {
  const sorted = [...points].sort((p, q) => p.d - q.d || q.h - p.h);
  const hull: { d: number; h: number }[] = [];
  for (const p of sorted) {
    if (hull.length > 0 && hull[hull.length - 1].d === p.d) {
      continue;
    }
    // drop the last point while it lies on or under the line from the one before it to p
    while (hull.length >= 2) {
      const [o, q] = [hull[hull.length - 2], hull[hull.length - 1]];
      if ((q.d - o.d) * (p.h - o.h) - (q.h - o.h) * (p.d - o.d) < 0) {
        break;
      }
      hull.pop();
    }
    hull.push(p);
  }
  return hull;
}

export interface Crest {
  /** Where the curve starts and its length along the span (m), the height and grade there, and the change of grade */
  from: number;
  length: number;
  height: number;
  grade: number;
  change: number;
}

/** The curves rounding a profile's crests: CREST_RADIUS_M, no longer than the stretches on either side */
export function crests(profile: { d: number; h: number }[]): Crest[] {
  const curves: Crest[] = [];
  for (let i = 1; i + 1 < profile.length; i++) {
    const [p, q, r] = [profile[i - 1], profile[i], profile[i + 1]];
    const [before, after] = [(q.h - p.h) / (q.d - p.d), (r.h - q.h) / (r.d - q.d)];
    const change = before - after;
    const length = Math.min(CREST_RADIUS_M * change, q.d - p.d, r.d - q.d);
    if (change > 0 && length > 0) {
      curves.push({ from: q.d - length / 2, length, height: q.h - (before * length) / 2, grade: before, change });
    }
  }
  return curves;
}

/** The height d along a profile, on its crests' curves where they are */
export function rounded(profile: { d: number; h: number }[], curves: Crest[], d: number): number {
  const curve = curves.find((c) => d >= c.from && d <= c.from + c.length);
  if (!curve) {
    return along(profile, d);
  }
  const x = d - curve.from;
  return curve.height + curve.grade * x - (curve.change * x * x) / (2 * curve.length);
}

/** The distances strictly between d0 and d1, from d0 on, every CREST_STEP_M over the curves */
function over(curves: Crest[], d0: number, d1: number): number[] {
  const [low, high] = [Math.min(d0, d1), Math.max(d0, d1)];
  const found: number[] = [];
  for (const c of curves) {
    for (let x = c.from; x <= c.from + c.length; x += CREST_STEP_M) {
      if (x > low + 1e-6 && x < high - 1e-6) {
        found.push(x);
      }
    }
  }
  return found.sort((x, y) => (d1 >= d0 ? x - y : y - x));
}

/** The height d along a profile of points by distance, straight between them and level past its ends */
function along(profile: { d: number; h: number }[], d: number): number {
  if (d <= profile[0].d) {
    return profile[0].h;
  }
  for (let i = 1; i < profile.length; i++) {
    if (d <= profile[i].d) {
      const [p, q] = [profile[i - 1], profile[i]];
      return p.h + ((q.h - p.h) * (d - p.d)) / (q.d - p.d || 1);
    }
  }
  return profile[profile.length - 1].h;
}

interface Approach<T> {
  line: T;
  /** Whether the approach is at the line's start (else its end) */
  atStart: boolean;
  /** Meters from the bridge's end to where the ground stops rising steeply (0: it does not rise) */
  length: number;
  /** The ground there */
  top: number | undefined;
}

/** Walks a line leading on from a bridge's end up to where the ground stops rising steeply. */
function approach<T extends BridgeLine>(line: T, atStart: boolean, heightAt: (e: number, n: number) => number | undefined): Approach<T> {
  const points = atStart ? line.line : [...line.line].reverse();
  let length = 0;
  let top = heightAt(...points[0]);
  for (let d = APPROACH_STEP_M; d <= APPROACH_REACH_M; d += APPROACH_STEP_M) {
    const p = pointAlong(points, d);
    const h = p && heightAt(...p);
    if (h === undefined || top === undefined) {
      break;
    }
    if (h - top < APPROACH_RISE_M) {
      if (length > 0 || d >= APPROACH_LEVEL_M) {
        break;
      }
      continue;
    }
    length = d;
    top = h;
  }
  return { line, atStart, length, top };
}

/** Gives an approach deck heights down from the bridge's end, splitting it off its line unless it is all of it. */
function raiseApproach<T extends BridgeLine>(lines: T[], a: Approach<T>, height: number, heightAt: (e: number, n: number) => number | undefined): void {
  const points = a.atStart ? a.line.line : [...a.line.line].reverse();
  // the approach's points: the line's up to its length, and the point at its length
  const ramp: Point[] = [points[0]];
  let travelled = 0;
  let i = 1;
  for (; i < points.length; i++) {
    const step = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (travelled + step >= a.length) {
      break;
    }
    travelled += step;
    ramp.push(points[i]);
  }
  const end = pointAlong(points, a.length);
  const whole = i >= points.length || !end;
  if (!whole) {
    ramp.push(end);
  }
  const low = heightAt(...ramp[ramp.length - 1]) ?? height;
  let along = 0;
  const deck = ramp.map((p, k) => {
    along += k > 0 ? Math.hypot(p[0] - ramp[k - 1][0], p[1] - ramp[k - 1][1]) : 0;
    const t = a.length > 0 ? Math.min(along / a.length, 1) : 1;
    return Math.max(height + (low - height) * t, heightAt(...p) ?? -Infinity);
  });
  if (whole) {
    a.line.deck = a.atStart ? deck : deck.reverse();
    return;
  }
  const rest = [end, ...points.slice(i)];
  a.line.line = a.atStart ? rest : rest.reverse();
  lines.push({ ...a.line, line: a.atStart ? ramp : [...ramp].reverse(), deck: a.atStart ? deck : [...deck].reverse() });
}

/** The point d meters along a line from its start, or undefined past its end */
export function pointAlong(points: Point[], d: number): Point | undefined {
  let left = d;
  for (let i = 1; i < points.length; i++) {
    const [a, c] = [points[i - 1], points[i]];
    const step = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (left <= step) {
      const k = step > 0 ? left / step : 0;
      return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k];
    }
    left -= step;
  }
  return undefined;
}

/** The deck height at a point on (or next to) a line with deck heights: from the nearest segment. */
export function deckAt(line: Point[], deck: number[], p: Point): number {
  let best = Infinity;
  let height = deck[0];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const dx = line[i + 1][0] - ax;
    const dy = line[i + 1][1] - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.min(Math.max(((p[0] - ax) * dx + (p[1] - ay) * dy) / lengthSq, 0), 1) : 0;
    const distance = Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]);
    if (distance < best) {
      best = distance;
      height = deck[i] + (deck[i + 1] - deck[i]) * t;
    }
  }
  return height;
}
