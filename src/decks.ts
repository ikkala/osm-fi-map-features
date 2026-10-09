// Bridge outlines (man_made=bridge) as decks: the bridge ways on an outline follow one straight profile
// (from the highest of their decks at one end to that at the other), the ways leading on meet it, and the
// outline is triangulated in short pieces with the deck's heights so the area between the ways, and trees and
// lamps on it, have a deck.
import { crests, deckAt, pointAlong, rounded, upperHull } from "./bridges.ts";
import { dedupe, distanceToSegment, nearestOnLine, orientedBox, pointInPolygon, pointInRing, ringArea, triangulate, type Point, type Polygon, type Ring } from "./geometry.ts";
import { bounds, crossing, type BridgeDeck, type BridgeOutline } from "./osm.ts";

/** A road or railway: a bridge's (bridge, deck) or not */
export interface DeckLine {
  bridge: boolean;
  line: Point[];
  deck?: number[];
  lid?: number[];
  floor?: number[];
}

/** A way is on an outline when at least this share of its length is inside it */
const ON_OUTLINE_SHARE = 0.5;
/** Lines are sampled this often (m) */
const SAMPLE_M = 1;
/** A way's end this near (m) a way on an outline meets it */
const TOUCH_M = 0.5;
/** A way on an outline reaching on past it at most this far (m) has the deck to its end */
const END_REACH_M = 5;
/** A way leading on meets a deck less than this (m) off as it is */
const MEET_M = 0.05;
/** A way on the ground leading on ramps to a deck no steeper than this unless given its own, with a point this often (m) */
const RAMP_GRADE = 0.06;
const RAMP_STEP_M = 2;
/** The highest deck within this (m) of an end is the deck's height there, and past the ends it goes on at its slope
 * over this much more (m) */
const END_M = 2;
const END_SLOPE_M = 10;
/** The ways on an outline run mostly one way when their directions add up to this share of their length (1: all one way) */
const WAYS_ALIGNED = 0.7;
/** The ways on an outline get a point at least this often (m), so their decks follow the bridge's */
const LINE_STEP_M = 5;
/** The pieces of an outline are this long (m) along the bridge */
const PIECE_M = 4;
/** A corner of a piece this near (m) the line between the corners before and after it is left out */
const STRAIGHT_M = 0.001;
/** Triangles steeper than this (rise over run) are left out: slivers that would stand on edge */
const MAX_DECK_SLOPE = 1;

/**
 * Unifies the decks of the bridge ways on each outline into one straight deck, and has the ways leading on from
 * them meet it: a way with a deck (an approach) is tilted to it, and a way on the ground gets a ramp split off it
 * (a deck up to it, or a floor in a cut down to it) no steeper than gradeOf, pushed onto lines. heightAt takes
 * meters east / north; without it the ways on the ground are left as they are. Returns the outlines' deck pieces
 * and how many ways were on them.
 */
export function setOutlineDecks<T extends DeckLine>(
  outlines: BridgeOutline[],
  lines: T[],
  heightAt?: (e: number, n: number) => number | undefined,
  gradeOf: (line: T) => number = () => RAMP_GRADE,
): { decks: BridgeDeck[]; ways: number } {
  const decks: BridgeDeck[] = [];
  const on = new Set<T>();
  const outlined: { outline: BridgeOutline; members: T[] }[] = [];
  for (const outline of outlines) {
    const box = bounds(outline.polygon.outer);
    const members = lines.filter((l) => {
      const deck = l.deck;
      if (!l.bridge || !deck || deck.length !== l.line.length || l.line.length < 2) {
        return false;
      }
      const b = bounds(l.line);
      return b.maxX >= box.minX && b.minX <= box.maxX && b.maxY >= box.minY && b.minY <= box.maxY && insideShare(l.line, outline.polygon) >= ON_OUTLINE_SHARE;
    });
    if (members.length > 0) {
      outlined.push({ outline, members });
      for (const m of members) {
        on.add(m);
      }
    }
  }
  // the ends of the ways leading on, and the deck heights they are to meet
  const meets = new Map<T, { start?: number; end?: number }>();
  for (const { outline, members } of outlined) {
    const angle = waysAngle(members, outline.polygon) ?? orientedBox(outline.polygon.outer).angle;
    const u: Point = [Math.cos(angle), Math.sin(angle)];
    const along = (p: Point) => p[0] * u[0] + p[1] * u[1];
    const profile = deckProfile(members, outline.polygon, along);
    for (const m of members) {
      const deck = m.deck;
      if (!deck) {
        continue;
      }
      // a tunnel's lid or floor goes point by point with the line, so such a way keeps its points
      const line = m.lid || m.floor ? m.line : densify(m.line, LINE_STEP_M);
      const own = line.map((p) => deckAt(m.line, deck, p));
      m.line = line;
      m.deck = straightened(
        line,
        own,
        line.map((p) => pointInPolygon(p, outline.polygon)),
        (p) => profile(along(p)),
      );
    }
    const box = bounds(outline.polygon.outer);
    for (const l of lines) {
      if (on.has(l) || l.lid || l.floor || l.line.length < 2) {
        continue;
      }
      const b = bounds(l.line);
      if (b.maxX < box.minX - TOUCH_M || b.minX > box.maxX + TOUCH_M || b.maxY < box.minY - TOUCH_M || b.minY > box.maxY + TOUCH_M) {
        continue;
      }
      const ends: ["start" | "end", Point][] = [
        ["start", l.line[0]],
        ["end", l.line[l.line.length - 1]],
      ];
      for (const [which, p] of ends) {
        const m = members.find((m) => m.deck && nearestOnLine(m.line, p).distance <= TOUCH_M);
        if (m?.deck) {
          meets.set(l, { ...meets.get(l), [which]: deckAt(m.line, m.deck, p) });
        }
      }
    }

    // the pieces, with the deck of the nearest way at their corners
    const heightAt = (p: Point) => {
      let best = { distance: Infinity, height: 0 };
      for (const m of members) {
        const deck = m.deck;
        if (deck) {
          const { distance } = nearestOnLine(m.line, p);
          if (distance < best.distance) {
            best = { distance, height: deckAt(m.line, deck, p) };
          }
        }
      }
      return best.height;
    };
    for (const piece of acrossPieces(outline.polygon, angle, PIECE_M)) {
      const heights = piece.vertices.map(heightAt);
      const triangles: number[] = [];
      for (let i = 0; i + 2 < piece.triangles.length; i += 3) {
        const corners = [piece.triangles[i], piece.triangles[i + 1], piece.triangles[i + 2]];
        if (slope(corners.map((k) => [...piece.vertices[k], heights[k]])) <= MAX_DECK_SLOPE) {
          triangles.push(...corners);
        }
      }
      if (triangles.length > 0) {
        decks.push({ osm: outline.osm, ...(outline.name !== undefined && { name: outline.name }), vertices: piece.vertices, triangles, heights });
      }
    }
  }
  // the ways leading on meet the decks, and the ways on the ground ending on their ramps meet those in turn
  const done = new Set<T>(on);
  const queue = [...meets];
  const ground = (o: T) => !o.bridge && !o.deck && !o.floor && !o.lid && o.line.length >= 2;
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [l, { start, end }] = next;
    if (done.has(l)) {
      continue;
    }
    done.add(l);
    const crosses = (ramp: Point[]) => lines.some((o) => o !== l && ground(o) && crossesAway(ramp, o.line));
    for (const ramp of meet(lines, l, start, end, heightAt, gradeOf(l), crosses)) {
      const box = bounds(ramp.line);
      for (const o of lines) {
        if (done.has(o) || !ground(o)) {
          continue;
        }
        const b = bounds(o.line);
        if (b.maxX < box.minX - TOUCH_M || b.minX > box.maxX + TOUCH_M || b.maxY < box.minY - TOUCH_M || b.minY > box.maxY + TOUCH_M) {
          continue;
        }
        const [p, q] = [o.line[0], o.line[o.line.length - 1]];
        const at = (x: Point) => (nearestOnLine(ramp.line, x).distance <= TOUCH_M ? deckAt(ramp.line, ramp.heights, x) : undefined);
        const [s, e] = [at(p), at(q)];
        if (s !== undefined || e !== undefined) {
          queue.push([o, { ...(s !== undefined && { start: s }), ...(e !== undefined && { end: e }) }]);
        }
      }
    }
  }
  return { decks, ways: on.size };
}

/** Whether two lines cross away from where one ends on the other (a junction) */
function crossesAway(a: Point[], b: Point[]): boolean {
  const ab = bounds(a);
  const bb = bounds(b);
  if (bb.maxX < ab.minX || bb.minX > ab.maxX || bb.maxY < ab.minY || bb.minY > ab.maxY) {
    return false;
  }
  const ends = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const hit = crossing(a[i], a[i + 1], b[j], b[j + 1], 0);
      if (hit) {
        const x: Point = [a[i][0] + (a[i + 1][0] - a[i][0]) * hit.at, a[i][1] + (a[i + 1][1] - a[i][1]) * hit.at];
        if (!ends.some((p) => Math.hypot(p[0] - x[0], p[1] - x[1]) <= TOUCH_M)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Each point's distance along a line */
function distances(line: Point[]): number[] {
  const along = [0];
  for (let i = 1; i < line.length; i++) {
    along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  }
  return along;
}

/**
 * A way's deck on an outline: the profile at its points inside it, and outside straight between the points inside
 * around, or, where it reaches on past the outline more than END_REACH_M, from the last point inside to its own deck
 * (own) at its end
 */
function straightened(line: Point[], own: number[], inside: boolean[], profile: (p: Point) => number): number[] {
  const along = distances(line);
  const deck = line.map(profile);
  const first = inside.indexOf(true);
  const last = inside.lastIndexOf(true);
  if (first < 0) {
    return deck;
  }
  const between = (i: number, a: number, ha: number, b: number, hb: number) => ha + ((hb - ha) * (along[i] - along[a])) / (along[b] - along[a] || 1);
  for (let i = first + 1; i < last; i++) {
    if (!inside[i]) {
      const previous = inside.lastIndexOf(true, i);
      const next = inside.indexOf(true, i);
      deck[i] = between(i, previous, deck[previous], next, deck[next]);
    }
  }
  const end = line.length - 1;
  if (along[first] > END_REACH_M) {
    for (let i = 0; i < first; i++) {
      deck[i] = between(i, 0, own[0], first, deck[first]);
    }
  }
  if (along[end] - along[last] > END_REACH_M) {
    for (let i = last + 1; i <= end; i++) {
      deck[i] = between(i, last, deck[last], end, own[end]);
    }
  }
  return deck;
}

/**
 * Has a way leading on meet a deck at its start and or end: one with a deck is tilted to it; one on the ground gets
 * a ramp split off it at each end, from the deck to the ground no steeper than grade (steeper where the way is too
 * short for both): a deck where the deck is over the ground at the way's end, else a floor in a cut. A ramp that
 * would cross another way is not made. Returns the ramps made, with their heights.
 */
function meet<T extends DeckLine>(
  lines: T[],
  l: T,
  start: number | undefined,
  end: number | undefined,
  heightAt: ((e: number, n: number) => number | undefined) | undefined,
  grade: number,
  crosses: (ramp: Point[]) => boolean,
): { line: Point[]; heights: number[] }[] {
  const along = distances(l.line);
  const length = along[along.length - 1];
  const deck = l.deck;
  if (deck) {
    const a = start === undefined ? 0 : start - deck[0];
    const b = end === undefined ? 0 : end - deck[deck.length - 1];
    if (Math.abs(a) > MEET_M || Math.abs(b) > MEET_M) {
      l.deck = deck.map((h, i) => h + a + ((b - a) * along[i]) / (length || 1));
    }
    return [];
  }
  if (!heightAt || length <= 0) {
    return [];
  }
  // how far each ramp reaches: from the deck to the ground at the way's end, at the grade
  const reach = (target: number | undefined, p: Point) => {
    const ground = heightAt(...p);
    return target === undefined || ground === undefined || Math.abs(target - ground) <= MEET_M ? 0 : Math.abs(target - ground) / grade;
  };
  let a = reach(start, l.line[0]);
  let b = reach(end, l.line[l.line.length - 1]);
  if (a + b > length) {
    [a, b] = [(length * a) / (a + b), (length * b) / (a + b)];
  }
  if (a > 0 && crosses(part(l.line, along, 0, a, 0))) {
    a = 0;
  }
  if (b > 0 && crosses(part(l.line, along, length - b, length, 0))) {
    b = 0;
  }
  if (a === 0 && b === 0) {
    return [];
  }
  const pieces: { from: number; to: number; target?: number; atStart?: boolean }[] = [];
  if (a > 0) {
    pieces.push({ from: 0, to: a, target: start, atStart: true });
  }
  if (length - a - b > 1e-6) {
    pieces.push({ from: a, to: length - b });
  }
  if (b > 0) {
    pieces.push({ from: length - b, to: length, target: end, atStart: false });
  }
  const made = pieces.map(({ from, to, target, atStart }): { line: Point[]; deck?: number[]; floor?: number[] } => {
    if (target === undefined) {
      return { line: part(l.line, along, from, to, 0) };
    }
    const line = part(l.line, along, from, to, RAMP_STEP_M);
    const ground = line.map((p) => heightAt(...p) ?? target);
    // from the deck at the way's end to the ground at the ramp's other end
    const [h0, h1] = atStart ? [target, ground[ground.length - 1]] : [ground[0], target];
    const pieceAlong = distances(line);
    const total = pieceAlong[pieceAlong.length - 1] || 1;
    const straight = pieceAlong.map((d) => h0 + ((h1 - h0) * d) / total);
    const raised = target > (atStart ? ground[0] : ground[ground.length - 1]);
    return raised ? { line, deck: straight.map((h, i) => Math.max(h, ground[i])) } : { line, floor: straight.map((h, i) => Math.min(h, ground[i])) };
  });
  const ramps = made.flatMap((piece) => {
    const heights = piece.deck ?? piece.floor;
    return heights ? [{ line: piece.line, heights }] : [];
  });
  const [head, ...rest] = made;
  for (const piece of rest) {
    const copy = { ...l, line: piece.line, deck: piece.deck, floor: piece.floor };
    if (!piece.deck) {
      delete copy.deck;
    }
    if (!piece.floor) {
      delete copy.floor;
    }
    lines.push(copy);
  }
  l.line = head.line;
  if (head.deck) {
    l.deck = head.deck;
  }
  if (head.floor) {
    l.floor = head.floor;
  }
  return ramps;
}

/** The part of a line from `from` to `to` meters along it (along: its points' distances), with a point every step (0: its own) */
function part(line: Point[], along: number[], from: number, to: number, step: number): Point[] {
  const at = (d: number): Point => pointAlong(line, Math.min(d, along[along.length - 1])) ?? line[line.length - 1];
  const points: Point[] = [at(from)];
  for (let i = 0; i < line.length; i++) {
    if (along[i] > from + 1e-9 && along[i] < to - 1e-9) {
      points.push(line[i]);
    }
  }
  points.push(at(to));
  const result = dedupe(points);
  return step > 0 ? densify(result, step) : result;
}

/**
 * The way the ways on an outline run (radians, either way along them), weighted by their lengths inside it: a bridge
 * may be wider than long (a wide road over a narrow one), so its outline's shape does not tell. Undefined where they
 * do not run mostly one way (WAYS_ALIGNED; a junction on a bridge), or have no length inside it.
 */
function waysAngle(members: DeckLine[], polygon: Polygon): number | undefined {
  // doubled angles, so a way and the same way reversed add up
  let [c, s, total] = [0, 0, 0];
  for (const m of members) {
    for (let i = 1; i < m.line.length; i++) {
      const [a, b] = [m.line[i - 1], m.line[i]];
      if (pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], polygon)) {
        const [de, dn] = [b[0] - a[0], b[1] - a[1]];
        const length = Math.hypot(de, dn);
        const doubled = 2 * Math.atan2(dn, de);
        c += length * Math.cos(doubled);
        s += length * Math.sin(doubled);
        total += length;
      }
    }
  }
  return total > 0 && Math.hypot(c, s) >= WAYS_ALIGNED * total ? Math.atan2(s, c) / 2 : undefined;
}

/**
 * The deck's height by meters along the bridge: the upper hull of its ways' decks, straight where they are and bending
 * one way only where they rise to a crest, rounded there as a bridge's (see setBridgeDecks), and on straight past its ends
 */
function deckProfile(members: DeckLine[], polygon: Polygon, along: (p: Point) => number): (t: number) => number {
  const points: { t: number; h: number }[] = [];
  for (const m of members) {
    const deck = m.deck;
    if (deck) {
      for (const p of samples(m.line)) {
        if (pointInPolygon(p, polygon)) {
          points.push({ t: along(p), h: deckAt(m.line, deck, p) });
        }
      }
    }
  }
  if (points.length === 0) {
    // the ways only cross the outline's corners: their ends' heights
    for (const m of members) {
      const deck = m.deck;
      if (deck) {
        points.push(...m.line.map((p, i) => ({ t: along(p), h: deck[i] })));
      }
    }
  }
  // at each end the highest deck within END_M of it, so a way ending a little short and lower does not bend it
  const t0 = Math.min(...points.map((p) => p.t));
  const t1 = Math.max(...points.map((p) => p.t));
  const first = Math.max(...points.filter((p) => p.t <= t0 + END_M).map((p) => p.h));
  const last = Math.max(...points.filter((p) => p.t >= t1 - END_M).map((p) => p.h));
  const inner = points.filter((p) => p.t > t0 + END_M && p.t < t1 - END_M).map(({ t, h }) => ({ d: t, h }));
  const hull = upperHull([{ d: t0, h: first }, ...inner, { d: t1, h: last }]);
  const curves = crests(hull);
  const on = (t: number) => rounded(hull, curves, t);
  if (t1 - t0 < 1e-9) {
    return () => first;
  }
  // past the ends, on at the slope over END_SLOPE_M (or the whole deck) inside them
  const reach = Math.min(END_SLOPE_M, t1 - t0);
  const [before, after] = [(on(t0 + reach) - first) / reach, (last - on(t1 - reach)) / reach];
  return (t) => (t < t0 ? first + before * (t - t0) : t > t1 ? last + after * (t - t1) : on(t));
}

/** The share of a line's length inside a polygon */
function insideShare(line: Point[], polygon: Polygon): number {
  let inside = 0;
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const length = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    const mid: Point = [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2];
    total += length;
    if (pointInPolygon(mid, polygon)) {
      inside += length;
    }
  }
  return total > 0 ? inside / total : 0;
}

/** Points along a line every SAMPLE_M, and its last point */
function samples(line: Point[]): Point[] {
  const result: Point[] = [];
  for (let d = 0; ; d += SAMPLE_M) {
    const p = pointAlong(line, d);
    if (!p) {
      break;
    }
    result.push(p);
  }
  result.push(line[line.length - 1]);
  return result;
}

/** A line with points added so no segment is longer than step */
function densify(line: Point[], step: number): Point[] {
  const result: Point[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, c] = [line[i - 1], line[i]];
    const parts = Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / step);
    for (let k = 1; k < parts; k++) {
      result.push([a[0] + ((c[0] - a[0]) * k) / parts, a[1] + ((c[1] - a[1]) * k) / parts]);
    }
    result.push(c);
  }
  return result;
}

/**
 * A polygon cut across its length (angle) into pieces `length` meters long, as triangles. Its triangles
 * are cut and rejoined rather than the polygon itself, which would leave slivers over notches.
 */
function acrossPieces(polygon: Polygon, angle: number, length: number): { vertices: Point[]; triangles: number[] }[] {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  // turned so the length runs along x
  const turn = ([x, y]: Point): Point => [x * c + y * s, -x * s + y * c];
  const back = ([x, y]: Point): Point => [x * c - y * s, x * s + y * c];
  const corners = [polygon.outer, ...polygon.holes].flat().map(turn);
  const all = triangulate(polygon);
  const xs = corners.map(([x]) => x);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const count = Math.max(1, Math.ceil((maxX - minX) / length));
  const step = (maxX - minX) / count;
  const cuts = Array.from({ length: count }, () => new Array<Ring>());
  for (let i = 0; i + 2 < all.length; i += 3) {
    const triangle = [corners[all[i]], corners[all[i + 1]], corners[all[i + 2]]];
    if (ringArea(triangle) < 0) {
      triangle.reverse();
    }
    const low = Math.min(...triangle.map(([x]) => x));
    const high = Math.max(...triangle.map(([x]) => x));
    for (let k = Math.max(0, Math.floor((low - minX) / step)); k < count && minX + k * step < high; k++) {
      const cut = clipBetween(clipBetween(triangle, minX + k * step, true), k === count - 1 ? maxX : minX + (k + 1) * step, false);
      if (cut.length >= 3) {
        cuts[k].push(cut);
      }
    }
  }
  const pieces: { vertices: Point[]; triangles: number[] }[] = [];
  for (const piece of cuts) {
    const vertices: Point[] = [];
    const triangles: number[] = [];
    for (const part of joined(piece)) {
      const first = vertices.length;
      vertices.push(...[part.outer, ...part.holes].flat().map(back));
      triangles.push(...triangulate(part).map((k) => first + k));
    }
    if (triangles.length > 0) {
      pieces.push({ vertices, triangles });
    }
  }
  return pieces;
}

/**
 * A convex ring cut at x = at, keeping the side above or below. The crossing is computed from the side's
 * ends in a fixed order, so neighbouring triangles get the same point.
 */
function clipBetween(ring: Ring, at: number, above: boolean): Ring {
  const keep = ([x]: Point) => (above ? x >= at : x <= at);
  const result: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
    if (keep(p)) {
      result.push(p);
    }
    if (keep(p) !== keep(q)) {
      const [a, b] = p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]) ? [p, q] : [q, p];
      result.push([at, a[1] + ((b[1] - a[1]) * (at - a[0])) / (b[0] - a[0])]);
    }
  }
  return dedupe(result);
}

/** Counter-clockwise convex pieces joined into polygons by dropping shared sides; clockwise rings are holes */
function joined(pieces: Ring[]): Polygon[] {
  const key = ([x, y]: Point) => `${x.toFixed(6)},${y.toFixed(6)}`;
  const sides = new Map<string, [Point, Point]>();
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) {
      const [p, q] = [piece[i], piece[(i + 1) % piece.length]];
      const reverse = `${key(q)}>${key(p)}`;
      if (sides.has(reverse)) {
        sides.delete(reverse);
      } else {
        sides.set(`${key(p)}>${key(q)}`, [p, q]);
      }
    }
  }
  // sides by where they start; several may start at one point (two rings touching there)
  const from = new Map<string, [Point, Point][]>();
  for (const side of sides.values()) {
    from.set(key(side[0]), [...(from.get(key(side[0])) ?? []), side]);
  }
  const rings: Ring[] = [];
  for (const start of sides.values()) {
    const list = from.get(key(start[0]));
    if (!list?.includes(start)) {
      continue;
    }
    const ring: Ring = [];
    let side: [Point, Point] | undefined = start;
    while (side) {
      const here: [Point, Point][] = from.get(key(side[0])) ?? [];
      here.splice(here.indexOf(side), 1);
      ring.push(side[0]);
      side = key(side[1]) === key(start[0]) ? undefined : from.get(key(side[1]))?.[0];
    }
    const straightened = withoutStraights(ring);
    if (straightened.length >= 3) {
      rings.push(straightened);
    }
  }
  const outers = rings.filter((r) => ringArea(r) > 0);
  const holes = rings.filter((r) => ringArea(r) < 0);
  return outers.map((outer) => ({ outer, holes: holes.filter((hole) => pointInRing(hole[0], outer)) }));
}

/** A ring without the corners it goes straight through (where the cuts of its triangles met) */
function withoutStraights(ring: Ring): Ring {
  let result = ring;
  for (let changed = true; changed && result.length > 3; ) {
    changed = false;
    for (let i = 0; i < result.length && result.length > 3; i++) {
      const [p, q, r] = [result[(i + result.length - 1) % result.length], result[i], result[(i + 1) % result.length]];
      if (distanceToSegment(q, p, r) < STRAIGHT_M) {
        result = [...result.slice(0, i), ...result.slice(i + 1)];
        changed = true;
      }
    }
  }
  return result;
}

/** How steep the plane through three points [east, north, height] is: rise over run, Infinity for an upright one */
function slope([a, b, c]: number[][]): number {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  return nz === 0 ? Infinity : Math.hypot(nx, ny) / Math.abs(nz);
}

interface IndexedDeck {
  deck: BridgeDeck;
  box: ReturnType<typeof bounds>;
}

/** The deck's height at a point on a piece of a deck (between its triangles' corners), or undefined off the pieces */
function heightOnDecks(decks: IndexedDeck[], p: Point): number | undefined {
  for (const { deck, box } of decks) {
    if (p[0] < box.minX || p[0] > box.maxX || p[1] < box.minY || p[1] > box.maxY) {
      continue;
    }
    const { triangles, vertices } = deck;
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
      const weights = barycentric(p, vertices[a], vertices[b], vertices[c]);
      if (weights && weights.every((w) => w >= -1e-6)) {
        return weights[0] * deck.heights[a] + weights[1] * deck.heights[b] + weights[2] * deck.heights[c];
      }
    }
  }
  return undefined;
}

function indexDecks(decks: BridgeDeck[]): IndexedDeck[] {
  return decks.map((deck) => ({ deck, box: bounds(deck.vertices) }));
}

function barycentric(p: Point, a: Point, b: Point, c: Point): [number, number, number] | undefined {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-9) {
    return undefined;
  }
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  return [wa, wb, 1 - wa - wb];
}

type Standing = { point: Point; base?: number }[];

/** Stands trees, lamps and playground equipment without a base yet on the bridge decks they are on. Returns how many of each. */
export function standOnDecks(decks: BridgeDeck[], trees: Standing, lamps: Standing, play: Standing): { trees: number; lamps: number; play: number } {
  const index = indexDecks(decks);
  const stand = (list: Standing) => {
    let count = 0;
    for (const item of list) {
      const height = item.base === undefined ? heightOnDecks(index, item.point) : undefined;
      if (height !== undefined) {
        item.base = height;
        count++;
      }
    }
    return count;
  };
  return { trees: stand(trees), lamps: stand(lamps), play: stand(play) };
}
