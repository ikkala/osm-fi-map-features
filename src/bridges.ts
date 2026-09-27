// Bridge deck heights. The elevation model is the bare ground, so under a bridge it has the river or
// the road below; the deck instead runs from the ground at one end of the bridge to the ground at
// the other. A bridge is often several OSM ways in a row (split where its tags change), so ways
// that meet end to end are joined into one span first.
//
// The model's 2 m grid also smooths the cut under a bridge into a hollow wider than the bridge, so the
// ground at a short bridge's end (a railway over a road) is already down in it. The end's height is
// taken instead where the ground up the way leading on stops rising steeply, and that stretch of the
// way (the approach) gets deck heights too, so it does not dip into the hollow either.
import type { Point } from "./geometry.ts";

export interface BridgeLine {
  bridge: boolean;
  line: Point[];
  /** Deck height (meters above sea level) at every point of line; set by setBridgeDecks */
  deck?: number[];
}

/** The approach is walked this often, and at most this far from the bridge's end (m) */
const APPROACH_STEP_M = 2;
const APPROACH_REACH_M = 12;
/** The ground has stopped rising steeply where it rises less than this in a step (m) */
const APPROACH_RISE_M = 0.2;

/**
 * Sets `deck` on every bridge line: along each span of bridge lines joined end to end, the height
 * goes linearly by distance from the ground at the span's first end to the ground at its last, and
 * never below the ground under it. The ends' ground is taken up the approaches (see above), which are
 * split off the lines leading on (added to lines, not bridges) with deck heights of their own.
 * heightAt takes meters east / north of the map origin.
 */
export function setBridgeDecks<T extends BridgeLine>(lines: T[], heightAt: (e: number, n: number) => number | undefined): void {
  const bridges = lines.filter((l) => l.bridge && l.line.length >= 2);
  const key = (p: Point) => `${p[0]},${p[1]}`;
  // the lines leading on from bridges, by their ends
  const onward = new Map<string, T[]>();
  for (const l of lines) {
    if (!l.bridge && l.line.length >= 2) {
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
  const done = new Set<BridgeLine>();
  for (const start of bridges) {
    if (done.has(start)) {
      continue;
    }
    // the span: walk both ways from `start` through ends shared by exactly two bridge lines
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
    const total = distances[distances.length - 1];
    // the approaches at both ends, and the ends' heights up them
    const ends = [points[0].p, points[points.length - 1].p].map((end) => {
      const approaches = (onward.get(key(end)) ?? []).filter((l) => l.deck === undefined).map((l) => approach(l, key(l.line[0]) === key(end), heightAt));
      const heights = [heightAt(...end), ...approaches.map((a) => a.top)].filter((h) => h !== undefined);
      return { height: heights.length > 0 ? Math.max(...heights) : undefined, approaches };
    });
    const first = ends[0].height;
    const last = ends[1].height;
    const a = first ?? last;
    const b = last ?? first;
    const decks = new Map(span.map((s) => [s.bridge, new Array<number>(s.bridge.line.length).fill(0)]));
    points.forEach(({ p, owner, index }, i) => {
      const ground = heightAt(...p);
      const straight = a === undefined || b === undefined ? ground : a + (b - a) * (total > 0 ? distances[i] / total : 0);
      const deck = decks.get(owner);
      if (deck) {
        deck[index] = Math.max(straight ?? 0, ground ?? -Infinity);
      }
    });
    for (const [bridge, deck] of decks) {
      bridge.deck = deck;
    }
    for (const end of ends) {
      for (const a of end.approaches) {
        if (end.height !== undefined && a.length > 0) {
          raiseApproach(lines, a, end.height, heightAt);
        }
      }
    }
  }
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
    if (h === undefined || top === undefined || h - top < APPROACH_RISE_M) {
      break;
    }
    length = d;
    top = h;
  }
  return { line, atStart, length, top };
}

/**
 * Gives an approach deck heights from the bridge's end (height) down to the ground where it ends,
 * never below the ground: splits it off its line into a line of its own, or gives the whole line deck
 * heights when the approach is all of it.
 */
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
function pointAlong(points: Point[], d: number): Point | undefined {
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
