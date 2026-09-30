// Bridge decks as areas. OSM draws a bridge's ways (the road, its sidewalks, a cycleway) as lines, and
// bridges.ts gives each span of them a deck of its own, but many bridges are also drawn as an outline
// (man_made=bridge): the whole deck, with what is on it between the ways, such as planted strips. Within
// an outline the ways' decks are made one: along the bridge they follow the highest of them (a way that
// ends in the middle of another took its end's height from the ground under the bridge), except near
// the ways' free ends, where each keeps its own to meet the way leading on. The outline is then made
// triangles with the deck's height at their corners, in short pieces along the bridge, so a deck can be
// drawn between the ways too, and the trees and lamps on it stand on it.
import { deckAt, pointAlong } from "./bridges.ts";
import { dedupe, distanceToSegment, nearestOnLine, orientedBox, pointInPolygon, pointInRing, ringArea, triangulate, type Point, type Polygon, type Ring } from "./geometry.ts";
import { bounds, type BridgeDeck, type BridgeOutline } from "./osm.ts";

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
/** The deck along the bridge: the highest of the ways' decks every this many meters */
const PROFILE_STEP_M = 4;
/** A way keeps its own deck at its free ends, and has the bridge's this far (m) from them */
const FADE_M = 15;
/** A way's end is not free where it is this near (m) another way on the outline (a way leading on along the bridge) */
const TOUCH_M = 0.5;
/** The ways on an outline get a point at least this often (m), so their decks follow the bridge's */
const LINE_STEP_M = 5;
/** The pieces of an outline are this long (m) along the bridge */
const PIECE_M = 4;
/** A corner of a piece this near (m) the line between the corners before and after it is left out */
const STRAIGHT_M = 0.001;
/**
 * A triangle steeper than this (rise over run) with the deck's heights at its corners is left out: a
 * sliver (three corners nearly in line) whose corners are at different heights, which would stand on its edge
 */
const MAX_DECK_SLOPE = 1;

/**
 * Makes one deck of the decks of the bridge ways on each outline (see above) and returns the outlines'
 * pieces with the deck's height at their corners; outlines with no bridge way with a deck on them are left
 * out. The ways on an outline get points every LINE_STEP_M. Returns also how many ways were on outlines.
 */
export function setOutlineDecks(outlines: BridgeOutline[], lines: DeckLine[]): { decks: BridgeDeck[]; ways: number } {
  const decks: BridgeDeck[] = [];
  const on = new Set<DeckLine>();
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
    if (members.length === 0) {
      continue;
    }
    const { angle } = orientedBox(outline.polygon.outer);
    const u: Point = [Math.cos(angle), Math.sin(angle)];
    const along = (p: Point) => p[0] * u[0] + p[1] * u[1];
    const profile = deckProfile(members, outline.polygon, along);

    // the free ends: the ways' ends that meet no other way on the outline, and where they leave it
    const free: Point[] = [];
    for (const m of members) {
      for (const end of [m.line[0], m.line[m.line.length - 1]]) {
        if (!members.some((other) => other !== m && nearestOnLine(other.line, end).distance <= TOUCH_M)) {
          free.push(end);
        }
      }
      let previous: Point | undefined;
      for (const p of samples(m.line)) {
        if (previous && pointInPolygon(p, outline.polygon) !== pointInPolygon(previous, outline.polygon)) {
          free.push([(p[0] + previous[0]) / 2, (p[1] + previous[1]) / 2]);
        }
        previous = p;
      }
    }
    const own = (p: Point) => {
      if (!pointInPolygon(p, outline.polygon)) {
        return 1;
      }
      return Math.max(0, ...free.map((e) => 1 - Math.hypot(p[0] - e[0], p[1] - e[1]) / FADE_M));
    };
    for (const m of members) {
      const deck = m.deck;
      if (!deck) {
        continue;
      }
      // a tunnel's lid or floor goes point by point with the line, so such a way keeps its points
      const line = m.lid || m.floor ? m.line : densify(m.line, LINE_STEP_M);
      const heights = line.map((p) => deckAt(m.line, deck, p));
      m.line = line;
      m.deck = line.map((p, i) => {
        const bridge = profile(along(p));
        return bridge + (heights[i] - bridge) * own(p);
      });
      on.add(m);
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
  return { decks, ways: on.size };
}

/**
 * The deck's height along the bridge (by `along`, meters along its length): the highest of the ways'
 * decks on the outline every PROFILE_STEP_M, straight between those and level past the last ones
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
  const t0 = Math.min(...points.map((p) => p.t));
  const count = Math.max(1, Math.round((Math.max(...points.map((p) => p.t)) - t0) / PROFILE_STEP_M) + 1);
  const highest = new Array<number | undefined>(count).fill(undefined);
  for (const { t, h } of points) {
    const i = Math.min(count - 1, Math.max(0, Math.round((t - t0) / PROFILE_STEP_M)));
    highest[i] = Math.max(highest[i] ?? -Infinity, h);
  }
  const known = highest.flatMap((h, i) => (h === undefined ? [] : [{ i, h }]));
  const values = highest.map((h, i) => {
    if (h !== undefined) {
      return h;
    }
    const before = known.filter((k) => k.i < i).at(-1);
    const after = known.find((k) => k.i > i);
    if (before && after) {
      return before.h + ((after.h - before.h) * (i - before.i)) / (after.i - before.i);
    }
    return (before ?? after)?.h ?? 0;
  });
  return (t) => {
    const x = Math.min(count - 1, Math.max(0, (t - t0) / PROFILE_STEP_M));
    const i = Math.min(count - 2, Math.floor(x));
    return i < 0 ? values[0] : values[i] + (values[i + 1] - values[i]) * (x - i);
  };
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
 * A polygon cut across its length (angle: its direction) into pieces `length` meters long, as triangles.
 * Cutting the polygon itself would leave slivers over a gap in it (a notch between two decks side by side:
 * the cut ring runs along the cut and back over the gap), so its triangles are cut instead (each cut is
 * convex), and a piece's cuts joined into polygons again by leaving out the sides they share.
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
 * A convex ring cut at x = at, keeping the side at or above it (above) or at or below it. Where a side
 * crosses the cut is worked out from its ends in the same order whichever way the side runs, so the two
 * triangles on a side get the same point.
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

/**
 * Counter-clockwise convex pieces of a polygon joined into polygons: the sides that two pieces share (in
 * opposite directions) are left out and the rest followed around. Rings running clockwise are holes, in
 * the polygon around them.
 */
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

/**
 * Stands the trees and the street lamps (those not on a way's deck already) on the bridge decks they are
 * on. Returns how many of each.
 */
export function standOnDecks(decks: BridgeDeck[], trees: { point: Point; base?: number }[], lamps: { point: Point; base?: number }[]): { trees: number; lamps: number } {
  const index = indexDecks(decks);
  const stand = (list: { point: Point; base?: number }[]) => {
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
  return { trees: stand(trees), lamps: stand(lamps) };
}
