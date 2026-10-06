// Bridge deck heights. The elevation model is bare ground, so a deck instead runs from the ground at
// one end of a span (bridge ways joined end to end) to the other. The model smooths the cut under a
// bridge into a wider hollow, so ends are taken where the approach stops rising steeply.
import type { Point } from "./geometry.ts";
import { crossing, NOT_FOR_VEHICLES, type Rail, type Road } from "./osm.ts";

export interface BridgeLine {
  bridge: boolean;
  line: Point[];
  /** Deck height (meters above sea level) at every point of line; set by setBridgeDecks */
  deck?: number[];
}

/** The approach is walked this often, and at most this far from the bridge's end (m) */
const APPROACH_STEP_M = 2;
const APPROACH_REACH_M = 24;
/** The ground has stopped rising steeply where it rises less than this in a step (m) */
const APPROACH_RISE_M = 0.2;
/** The hollow's bottom may reach on this far from the bridge's end before the ground starts rising (m) */
const APPROACH_LEVEL_M = 6;
/** Room a bridge leaves over a way under it (m), and its deck's thickness */
const ROOM_OVER_M = { people: 2.7, vehicles: 4.2, trams: 4.7, trains: 5.5 };
const DECK_THICKNESS_M = 1;
/** A deck needing to rise more than this (m) is left as it is: the model's ground under a bridge spans the gap from
 * the ground around it, and may be far over the way there */
const MAX_LIFT_M = 3;
/** The bridge's other points rise toward the deck over such a way no steeper than this, for people, vehicles and trains */
const RISE_GRADE = { people: 0.08, vehicles: 0.06, trains: 0.03 };
/** The deck is that high over the way's width and this far (m) either side */
const PLATEAU_SIDE_M = 1;
const TRAMS = new Set(["tram", "light_rail"]);
/** Maximum rounds of junction height averaging */
const JUNCTION_ROUNDS = 1000;

/**
 * Sets `deck` on every bridge line: linear along each span between its ends, never below the ground.
 * Approaches are split off the lines leading on and get decks too. heightAt takes meters east / north.
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
      const heights = [heightAt(...end), ...approaches.map((a) => a.top)].filter((h) => h !== undefined);
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

  for (const { span, points, distances } of spans) {
    const total = distances[distances.length - 1];
    const first = heightOf(key(points[0].p));
    const last = heightOf(key(points[points.length - 1].p));
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
  }
  for (const end of ends.values()) {
    for (const a of end.approaches) {
      if (end.height !== undefined && a.length > 0) {
        raiseApproach(lines, a, end.height, heightAt);
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

/**
 * Lifts bridge decks to leave room over the ways under them: the elevation model leaves out a bridge's ramps and
 * steps, so a deck from the ground at its ends is often too low over a road or railway it crosses. Where a way
 * crosses under a bridge line (at a lower layer, a bridge at least at layer 1; not in a tunnel) with less than ROOM_OVER_M and the deck's
 * thickness over its ground (or floor), and at most MAX_LIFT_M more than the deck there, the deck is that high over the way's width and a meter either side (the
 * line gets points there), and the other points of the bridge (its lines joined end to end) rise toward it no
 * steeper than RISE_GRADE; the bridge's ends stay. Returns how many crossings lifted a deck.
 */
export function raiseDecksOverWays(bridges: (Road | Rail)[], ways: (Road | Rail)[], heightAt: (e: number, n: number) => number | undefined): number {
  const under = ways.filter((w) => !w.bridge && !w.tunnel && !w.deck && w.line.length >= 2);
  const lines = bridges.filter((b) => b.bridge && b.deck && b.line.length >= 2);
  // the plateaus over the ways under each line: the points to add, by segment, and their heights
  const plateaus = new Map<Road | Rail, { i: number; at: number; height: number }[]>();
  let count = 0;
  for (const bridge of lines) {
    const deck = bridge.deck ?? [];
    for (let i = 0; i + 1 < bridge.line.length; i++) {
      const [a, c] = [bridge.line[i], bridge.line[i + 1]];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
      for (const way of under) {
        // a bridge is over the ground's layer, tagged or not
        if (way.layer >= Math.max(bridge.layer, 1) || length === 0) {
          continue;
        }
        const room = "width" in way ? (NOT_FOR_VEHICLES.has(way.kind) ? ROOM_OVER_M.people : ROOM_OVER_M.vehicles) : TRAMS.has(way.kind) ? ROOM_OVER_M.trams : ROOM_OVER_M.trains;
        const wayWidth = ("width" in way ? way.width : 3) + 2 * PLATEAU_SIDE_M;
        for (let k = 0; k + 1 < way.line.length; k++) {
          const hit = crossing(a, c, way.line[k], way.line[k + 1], wayWidth);
          if (!hit || hit.at <= 0 || hit.at >= 1) {
            continue;
          }
          const p: Point = [a[0] + (c[0] - a[0]) * hit.at, a[1] + (c[1] - a[1]) * hit.at];
          const ground = way.floor ? deckAt(way.line, way.floor, p) : heightAt(...p);
          const needed = ground === undefined ? undefined : ground + room + DECK_THICKNESS_M;
          const here = deck[i] + (deck[i + 1] - deck[i]) * hit.at;
          if (needed !== undefined && needed > here && needed - here <= MAX_LIFT_M) {
            const half = hit.half / length;
            const list = plateaus.get(bridge) ?? [];
            for (const at of [hit.at - half, hit.at, hit.at + half]) {
              if (at > 0 && at < 1) {
                list.push({ i, at, height: needed });
              }
            }
            plateaus.set(bridge, list);
            count++;
          }
        }
      }
    }
  }
  if (count === 0) {
    return 0;
  }
  // the plateaus' points into their lines, the deck between linear
  const peaks = new Map<Road | Rail, Set<number>>();
  for (const [bridge, list] of plateaus) {
    const deck = bridge.deck ?? [];
    list.sort((x, y) => x.i - y.i || x.at - y.at);
    const line: Point[] = [];
    const heights: number[] = [];
    const top = new Set<number>();
    for (let i = 0; i < bridge.line.length; i++) {
      line.push(bridge.line[i]);
      heights.push(deck[i]);
      const [a, c] = [bridge.line[i], bridge.line[i + 1]];
      for (const { at, height } of list.filter((r) => r.i === i)) {
        top.add(line.length);
        line.push([a[0] + (c[0] - a[0]) * at, a[1] + (c[1] - a[1]) * at]);
        heights.push(height);
      }
    }
    bridge.line = line;
    bridge.deck = heights;
    peaks.set(bridge, top);
  }
  // the bridges: lines joined end to end where exactly two meet; their points in order and how far along
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const byEnd = new Map<string, (Road | Rail)[]>();
  for (const b of lines) {
    for (const p of [b.line[0], b.line[b.line.length - 1]]) {
      byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), b]);
    }
  }
  const done = new Set<Road | Rail>();
  for (const start of plateaus.keys()) {
    if (done.has(start)) {
      continue;
    }
    // walk to one end of the chain, then collect it from there
    let first: Road | Rail = start;
    let atStart = true;
    const seen = new Set([start]);
    for (;;) {
      const free: Point = atStart ? first.line[0] : first.line[first.line.length - 1];
      const next: (Road | Rail)[] = (byEnd.get(key(free)) ?? []).filter((b) => b !== first);
      if (next.length !== 1 || seen.has(next[0])) {
        break;
      }
      const n: Road | Rail = next[0];
      seen.add(n);
      atStart = key(n.line[n.line.length - 1]) === key(free);
      first = n;
    }
    // each point once; the point a line shares with the one before is that one's twin
    const chain: { bridge: Road | Rail; i: number; twins: { bridge: Road | Rail; i: number }[] }[] = [];
    let line: Road | Rail = first;
    let forward = atStart;
    for (;;) {
      done.add(line);
      const indices = line.line.map((_, i) => i);
      for (const i of forward ? indices : indices.reverse()) {
        if (chain.length > 0 && i === (forward ? 0 : line.line.length - 1)) {
          chain[chain.length - 1].twins.push({ bridge: line, i });
        } else {
          chain.push({ bridge: line, i, twins: [] });
        }
      }
      const end: Point = forward ? line.line[line.line.length - 1] : line.line[0];
      const next: (Road | Rail)[] = (byEnd.get(key(end)) ?? []).filter((b) => b !== line);
      if (next.length !== 1 || done.has(next[0])) {
        break;
      }
      line = next[0];
      forward = key(line.line[0]) === key(end);
    }
    const along = [0];
    for (let j = 1; j < chain.length; j++) {
      const [p, q] = [chain[j - 1].bridge.line[chain[j - 1].i], chain[j].bridge.line[chain[j].i]];
      along.push(along[j - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    const height = (j: number) => (chain[j].bridge.deck ?? [])[chain[j].i];
    const tops = chain.map((c, j) => (peaks.get(c.bridge)?.has(c.i) ? j : -1)).filter((j) => j >= 0);
    const grade = "width" in start ? (NOT_FOR_VEHICLES.has(start.kind) ? RISE_GRADE.people : RISE_GRADE.vehicles) : RISE_GRADE.trains;
    const raised = chain.map((_, j) => Math.max(height(j), ...tops.map((k) => height(k) - grade * Math.abs(along[j] - along[k]))));
    chain.forEach(({ bridge, i, twins }, j) => {
      if (j > 0 && j + 1 < chain.length) {
        for (const point of [{ bridge, i }, ...twins]) {
          const deck = point.bridge.deck;
          if (deck) {
            deck[point.i] = raised[j];
          }
        }
      }
    });
  }
  return count;
}
