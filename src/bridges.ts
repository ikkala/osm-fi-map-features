// Bridges' spans and their landings, for the heights' program (heights.ts): the lines spanning (bridges, lines
// carried through buildings between them, lines above the ground steps lift), the heights steps up to them tell
// (RISER_M a step), and where they land, each with the ways leading on. The elevation model is bare ground, and it
// smooths the cut under a bridge into a wider hollow, so a landing is taken where its approach stops rising steeply.
// A boardwalk lies on the ground instead: its deck follows it.
import { distancesAlong, pointKey, pushTo, type Point } from "./geometry.ts";
import type { Road } from "./osm.ts";
import { inTunnel, isBridge, offStructures } from "./profile.ts";
import { isRoad, type Way } from "./ways.ts";

/** The approach is walked this often, and at most this far from the bridge's end (m), for the hollow under it */
const APPROACH_STEP_M = 2;
const HOLLOW_REACH_M = 24;
/** The ground has stopped rising steeply where it rises less than this in a step (m) */
const APPROACH_RISE_M = 0.2;
/** The hollow's bottom may reach on this far from the bridge's end before the ground starts rising (m) */
const APPROACH_LEVEL_M = 6;
/** A step's rise (m) */
const RISER_M = 0.16;
/** A deck's crest is rounded over a curve of this radius (m) */
const CREST_RADIUS_M = 400;
/** Steps lift a way above the ground that is no bridge only where they tell it more than this over the ground (m) */
const LIFT_M = 0.5;
/** A boardwalk's deck is this far (m) over the ground, level over a dip narrower than BOARDWALK_SPAN_M */
const BOARDWALK_OVER_M = 0.3;
const BOARDWALK_SPAN_M = 6;
/** The ground under a boardwalk is looked at this often (m), and its deck gets a point where it bends more than BOARDWALK_STRAIGHT_M */
const BOARDWALK_STEP_M = 2;
const BOARDWALK_STRAIGHT_M = 0.05;
type HeightAt = (e: number, n: number) => number | undefined;

/**
 * The lines spanning: the bridges but boardwalks, the lines carried through buildings between bridges' ends, and the
 * lines above the ground that steps lift; the heights steps up to a point tell (from the ground at their other end, a
 * riser a step), the steps telling them, and the lifted lines
 */
export function spansOf(ways: Way[], atPoint: Map<string, Way[]>, heightAt: HeightAt, through: (road: Road) => boolean) {
  const spanning = (l: Way) => isBridge(l) && !(isRoad(l) && l.boardwalk === true) && l.line.length >= 2;
  const ends = (l: Way) => [l.line[0], l.line[l.line.length - 1]];
  const bridgeEnds = new Set(ways.filter(spanning).flatMap((l) => ends(l).map(pointKey)));
  const carried = ways.filter((l) => isRoad(l) && !isBridge(l) && l.line.length >= 2 && through(l) && ends(l).every((p) => bridgeEnds.has(pointKey(p))));
  const steps = roads(ways).filter((l) => !isBridge(l) && (l.stepCount ?? 0) > 0 && l.incline !== undefined && l.line.length >= 2);
  const telling = new Set<Way>(steps);
  const stepped = new Map<string, { h: number; by: Way }[]>();
  for (const l of steps) {
    const [start, end] = ends(l);
    const rise = (l.incline === "up" ? 1 : -1) * (l.stepCount ?? 0) * RISER_M;
    for (const [at, from, up] of [[end, start, rise], [start, end, -rise]] as const) {
      const ground = heightAt(...from);
      if (ground !== undefined) {
        pushTo(stepped, pointKey(at), { h: ground + up, by: l });
      }
    }
  }
  const toldAt = (p: Point, except?: Way) => {
    const heights = (stepped.get(pointKey(p)) ?? []).filter((t) => t.by !== except).map((t) => t.h);
    return heights.length > 0 ? Math.max(...heights) : undefined;
  };
  const others = (l: Way, p: Point) => (atPoint.get(pointKey(p)) ?? []).filter((o) => o !== l);
  const onGround = (o: Way) => !isBridge(o) && !inTunnel(o) && o.layer <= 0;
  // whether steps up to p lift l there, its other end at r
  const lifted = (l: Way, p: Point, r: Point) => {
    const [h, ground, below] = [toldAt(p, l), heightAt(...p), heightAt(...r)];
    const beyond = others(l, r);
    return (
      h !== undefined &&
      ground !== undefined &&
      h > ground + LIFT_M &&
      others(l, p).every((o) => !isBridge(o) && (o.layer > 0 || telling.has(o))) &&
      (beyond.length === 0 || (beyond.some(onGround) && below !== undefined && h <= below + LIFT_M))
    );
  };
  const lifting = new Set(
    ways.filter((l) => !isBridge(l) && !carried.includes(l) && !inTunnel(l) && l.layer > 0 && l.line.length >= 2 && (lifted(l, l.line[0], l.line[l.line.length - 1]) || lifted(l, l.line[l.line.length - 1], l.line[0]))),
  );
  return { spans: [...ways.filter(spanning), ...carried, ...lifting], toldAt, telling, lifting };
}

function roads(ways: Way[]): Road[] {
  return ways.filter(isRoad);
}

/**
 * The spans' landings: where a line ends that no other span goes on from, or a way on the ground meets them (not steps
 * telling a height), each with its height (the ground's, or up the ways leading on where the hollow under the bridge
 * reaches past it, or the boardwalk's it ends on; none for a free end: into a building, or a lifted line's dead end)
 * and the ways leading on, which the lifted lines raise none of, with how far each is raised out of the hollow
 */
export function landings(spans: Way[], atPoint: Map<string, Way[]>, heightAt: HeightAt, indoors: (p: Point) => boolean, lifting: Set<Way>, telling: Set<Way>, boardwalks: Road[]): Landing[] {
  const spanned = new Set(spans);
  const found = new Map<string, Landing>();
  for (const span of spans) {
    for (const p of [span.line[0], span.line[span.line.length - 1]]) {
      const there = atPoint.get(pointKey(p)) ?? [];
      const leading = there.filter((o) => !spanned.has(o));
      const onwards = there.filter((o) => spanned.has(o) && o !== span);
      if (found.has(pointKey(p)) || (onwards.length > 0 && leading.every((o) => telling.has(o)))) {
        continue;
      }
      const lifts = there.some((o) => lifting.has(o));
      const free = (indoors(p) && leading.length === 0) || (lifts && leading.length === 0);
      const host = boardwalks.find((b) => b.deck && leading.includes(b));
      const approaches = lifts ? [] : leading.filter(approachable(telling)).map((line) => approach(line, p, heightAt));
      const heights = [free ? undefined : heightAt(...p), ...approaches.map((a) => a.top)].filter((h) => h !== undefined);
      const height = host?.deck ? deckAt(host.line, host.deck, p) : heights.length > 0 ? Math.max(...heights) : undefined;
      found.set(pointKey(p), { p, height, approaches, host: host !== undefined, inner: false });
    }
    // the ways leading off a span from its inner points are its approaches too, which hang from its deck there
    for (const p of span.line.slice(1, -1)) {
      const leading = (atPoint.get(pointKey(p)) ?? []).filter((o) => !spanned.has(o) && approachable(telling)(o));
      if (!found.has(pointKey(p)) && leading.length > 0 && !lifting.has(span)) {
        found.set(pointKey(p), { p, height: undefined, approaches: leading.map((line) => approach(line, p, heightAt)), host: false, inner: true });
      }
    }
  }
  return [...found.values()];
}

export interface Landing {
  p: Point;
  height: number | undefined;
  approaches: Approach[];
  /** On a boardwalk's deck, which it keeps to */
  host: boolean;
  /** At a span's inner point: no landing, its deck the span's */
  inner: boolean;
}

/** Whether a way may be raised as an approach: on the ground, no steps telling a height */
export function approachable(telling: Set<Way>): (way: Way) => boolean {
  return (way) => offStructures(way) && !telling.has(way) && way.line.length >= 2;
}

/**
 * A boardwalk's deck: BOARDWALK_OVER_M over the ground, which it follows but over dips narrower than
 * BOARDWALK_SPAN_M (the lowest of the highest grounds of the stretches that long around each point), its line
 * getting points where the deck bends. A boardwalk with no ground under it gets none.
 */
export function setBoardwalkDeck(boardwalk: { line: Point[]; deck?: number[] }, heightAt: HeightAt): void {
  // the ground every step along the line, its points among them
  const samples: { p: Point; d: number; point: boolean }[] = [];
  let d = 0;
  boardwalk.line.forEach((p, i) => {
    if (i > 0) {
      const q = boardwalk.line[i - 1];
      const length = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const steps = Math.ceil(length / BOARDWALK_STEP_M);
      for (let k = 1; k < steps; k++) {
        samples.push({ p: [q[0] + ((p[0] - q[0]) * k) / steps, q[1] + ((p[1] - q[1]) * k) / steps], d: d + (length * k) / steps, point: false });
      }
      d += length;
    }
    samples.push({ p, d, point: true });
  });
  const measured = samples.map((s) => heightAt(...s.p));
  if (measured.every((h) => h === undefined)) {
    return;
  }
  // where the model has no ground, the nearest sample's
  const ground = measured.map((h, i) => {
    if (h !== undefined) {
      return h;
    }
    const nearest = measured.flatMap((m, j) => (m === undefined ? [] : [{ m, far: Math.abs(samples[j].d - samples[i].d) }])).sort((a, b) => a.far - b.far)[0];
    return nearest.m;
  });
  // the highest ground of the stretch from a sample on (or back) BOARDWALK_SPAN_M, within the boardwalk
  const highest = (from: number, to: number) => Math.max(...ground.filter((_, j) => samples[j].d >= from - 1e-9 && samples[j].d <= to + 1e-9));
  const deck = samples.map(({ d: at }) => {
    const starts = samples.filter((s) => s.d >= at - BOARDWALK_SPAN_M - 1e-9 && s.d <= at + 1e-9).map((s) => s.d);
    const ends = samples.filter((s) => s.d >= at - 1e-9 && s.d <= at + BOARDWALK_SPAN_M + 1e-9).map((s) => s.d);
    return Math.min(...starts.map((s) => highest(s, s + BOARDWALK_SPAN_M)), ...ends.map((e) => highest(e - BOARDWALK_SPAN_M, e))) + BOARDWALK_OVER_M;
  });
  // the line's points, and between them the samples where the deck bends away from a straight line
  const kept = new Set(samples.flatMap((s, i) => (s.point ? [i] : [])));
  const keep = (a: number, b: number) => {
    let worst = -1;
    let most = BOARDWALK_STRAIGHT_M;
    for (let i = a + 1; i < b; i++) {
      const t = (samples[i].d - samples[a].d) / (samples[b].d - samples[a].d);
      const off = Math.abs(deck[i] - (deck[a] + (deck[b] - deck[a]) * t));
      if (off > most) {
        [worst, most] = [i, off];
      }
    }
    if (worst >= 0) {
      kept.add(worst);
      keep(a, worst);
      keep(worst, b);
    }
  };
  const points = [...kept].sort((a, b) => a - b);
  for (let i = 0; i + 1 < points.length; i++) {
    keep(points[i], points[i + 1]);
  }
  const indices = [...kept].sort((a, b) => a - b);
  boardwalk.line = indices.map((i) => samples[i].p);
  boardwalk.deck = indices.map((i) => Math.round(deck[i] * 100) / 100);
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


interface Approach {
  line: Way;
  /** How far along the line its landing is, and which way along it the approach goes from there (0: both, from its middle) */
  at: number;
  toward: 1 | -1 | 0;
  /** Meters from the bridge's end to where the ground stops rising steeply (0: it does not rise), and the ground there */
  length: number;
  top: number | undefined;
}

/** Walks a line leading on from a bridge's end at p up to where the ground stops rising steeply (not from its middle) */
function approach(line: Way, p: Point, heightAt: HeightAt): Approach {
  const along = distancesAlong(line.line);
  const i = line.line.findIndex((q) => pointKey(q) === pointKey(p));
  const toward = i === 0 ? 1 : i === line.line.length - 1 ? -1 : 0;
  const points = toward > 0 ? line.line : [...line.line].reverse();
  let length = 0;
  let top = heightAt(...p);
  for (let d = APPROACH_STEP_M; d <= HOLLOW_REACH_M && toward !== 0; d += APPROACH_STEP_M) {
    const q = pointAlong(points, d);
    const h = q && heightAt(...q);
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
  return { line, at: along[Math.max(0, i)], toward, length, top };
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
