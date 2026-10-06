// Ways under bridges. A bridge's deck runs straight from the ground at its ends, and the elevation model has no
// ground under it, only the gap spanned from the ground around: a way under a bridge often has too little room
// under the deck. The deck stays straight; the way goes down into a cut under it instead, ramping down to the
// floor the room needs and up again.
import { deckAt } from "./bridges.ts";
import { distanceToSegment, pointInPolygon, type Point } from "./geometry.ts";
import { bounds, NOT_FOR_VEHICLES, type BridgeOutline, type Rail, type Road } from "./osm.ts";

/** Room a way needs under a deck (m), and the deck's thickness */
const ROOM_M = { people: 2.7, vehicles: 4.2, trams: 4.7, trains: 5.5 };
const DECK_THICKNESS_M = 1;
/** A way ramps down into a cut no steeper than this */
const GRADE = { people: 0.08, vehicles: 0.06, trains: 0.03 };
/** A way needing to go down more than this (m) is left as it is */
const MAX_DEPTH_M = 3;
/** A deck reaches this far (m) beyond its way's edges, and the cut's bottom a meter more */
const DECK_EDGE_M = 0.5;
const BOTTOM_SIDE_M = 1;
/** A railway is this wide (m) */
const RAIL_WIDTH_M = 3;
/** A way is looked at this often (m), and lowered by less than this (m) not at all */
const SAMPLE_M = 1;
const MIN_DEPTH_M = 0.05;
/** An outline's deck is the nearest bridge way's within this far (m) */
const OUTLINE_REACH_M = 30;
const TRAMS = new Set(["tram", "light_rail"]);

type Way = Road | Rail;

/**
 * Lowers the ways passing under bridges (`deck`) and bridge outlines into cuts where the deck leaves them less than
 * ROOM_M and its thickness over the ground: the stretch is split off the way with a `floor`, at that depth under
 * the deck and ramping up to the ground no steeper than GRADE. Ways of a kind meeting end to end (exactly two at a
 * point) go down as one. A way that would go deeper than MAX_DEPTH_M, ends in the cut, or meets another way in it
 * (`others`: a junction or a level crossing, which would be left over it), is left as it is, as are the bridges themselves and the ways on them. Returns how many cuts;
 * the OSM ids of the bridges over them go into `over` (a cut may tell of a bridge's ends too low in the model).
 */
export function lowerUnderBridges<T extends Way>(
  ways: T[],
  bridges: Way[],
  outlines: BridgeOutline[],
  heightAt: (e: number, n: number) => number | undefined,
  over: Set<string> = new Set(),
  others: Way[] = ways,
): number {
  const spans = bridges
    .filter((b) => b.bridge && b.deck && b.line.length >= 2)
    .map((b) => ({ osm: b.osm, line: b.line, deck: b.deck ?? [], box: bounds(b.line), half: ("width" in b ? b.width : RAIL_WIDTH_M) / 2 + DECK_EDGE_M, layer: Math.max(b.layer, 1) }));
  const shapes = outlines.map((o) => ({ polygon: o.polygon, box: bounds(o.polygon.outer) }));
  // the deck over p (with its bridge's layer), or undefined
  const deckOver = ([e, n]: Point, layer: number): { deck: number; osm: string } | undefined => {
    let nearest: { d: number; deck: number; osm: string } | undefined;
    for (const span of spans) {
      if (span.layer <= layer || e < span.box.minX - OUTLINE_REACH_M || e > span.box.maxX + OUTLINE_REACH_M || n < span.box.minY - OUTLINE_REACH_M || n > span.box.maxY + OUTLINE_REACH_M) {
        continue;
      }
      for (let i = 0; i + 1 < span.line.length; i++) {
        const d = distanceToSegment([e, n], span.line[i], span.line[i + 1]) - span.half - BOTTOM_SIDE_M;
        if (!nearest || d < nearest.d) {
          nearest = { d, deck: deckAt(span.line, span.deck, [e, n]), osm: span.osm };
        }
      }
    }
    if (!nearest || nearest.d > OUTLINE_REACH_M) {
      return undefined;
    }
    if (nearest.d <= 0) {
      return nearest;
    }
    const inOutline = shapes.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
    return inOutline ? nearest : undefined;
  };
  // the ways that may go down, joined end to end into chains where exactly two of a kind meet
  const classOf = (way: Way) => ("width" in way ? (NOT_FOR_VEHICLES.has(way.kind) ? "people" : "vehicles") : TRAMS.has(way.kind) ? "trams" : "trains");
  const eligible = ways.filter((w) => !w.bridge && !w.tunnel && !w.deck && !w.floor && !w.lid && w.line.length >= 2);
  const key = (p: Point) => `${p[0]},${p[1]}`;
  const byEnd = new Map<string, T[]>();
  for (const way of eligible) {
    for (const p of [way.line[0], way.line[way.line.length - 1]]) {
      byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), way]);
    }
  }
  // the way going on from p, of the way's kind and layer, when it is the only other one there
  const onward = (way: T, p: Point): T | undefined => {
    const there = byEnd.get(key(p)) ?? [];
    const others = there.filter((w) => w !== way);
    return there.length === 2 && others.length === 1 && classOf(others[0]) === classOf(way) && others[0].layer === way.layer ? others[0] : undefined;
  };
  // the points of all the ways, by how many ways have them
  const usedBy = new Map<string, Set<Way>>();
  for (const w of [...ways, ...others]) {
    for (const p of w.line) {
      usedBy.set(key(p), (usedBy.get(key(p)) ?? new Set<Way>()).add(w));
    }
  }
  const added: T[] = [];
  const done = new Set<T>();
  let count = 0;
  for (const start of eligible) {
    if (done.has(start)) {
      continue;
    }
    // walk back to the chain's first way, then along it
    let first = start;
    let reversed = false;
    const seen = new Set([start]);
    for (;;) {
      const p: Point = reversed ? first.line[first.line.length - 1] : first.line[0];
      const before: T | undefined = onward(first, p);
      if (!before || seen.has(before)) {
        break;
      }
      seen.add(before);
      reversed = key(before.line[0]) === key(p);
      first = before;
    }
    const members: { way: T; reversed: boolean; offset: number; length: number }[] = [];
    const line: Point[] = [];
    let way: T | undefined = first;
    let backwards = reversed;
    let offset = 0;
    while (way && !done.has(way)) {
      done.add(way);
      const points = backwards ? [...way.line].reverse() : way.line;
      let length = 0;
      for (let i = 1; i < points.length; i++) {
        length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      }
      members.push({ way, reversed: backwards, offset, length });
      line.push(...(line.length > 0 ? points.slice(1) : points));
      offset += length;
      const end = points[points.length - 1];
      const next = onward(way, end);
      backwards = next !== undefined && key(next.line[next.line.length - 1]) === key(end);
      way = next;
    }
    const people = classOf(first) === "people";
    const room = people ? ROOM_M.people : classOf(first) === "vehicles" ? ROOM_M.vehicles : classOf(first) === "trams" ? ROOM_M.trams : ROOM_M.trains;
    const grade = people ? GRADE.people : classOf(first) === "vehicles" ? GRADE.vehicles : GRADE.trains;
    const along = [0];
    for (let i = 1; i < line.length; i++) {
      along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    }
    const length = along[along.length - 1];
    const at = (d: number): Point => stretch(line, along, d, d)[0];
    // where the deck is too low over the chain: the floor it needs there
    const needs: { d: number; floor: number }[] = [];
    const bridgesOver = new Set<string>();
    // the places under a deck needing more than MAX_DEPTH_M, which keep the cut away
    const tooDeep: number[] = [];
    for (let d = 0; d <= length; d += SAMPLE_M) {
      const p = at(d);
      const deck = deckOver(p, first.layer);
      const ground = heightAt(...p);
      if (deck === undefined || ground === undefined) {
        continue;
      }
      const floor = deck.deck - DECK_THICKNESS_M - room;
      if (ground - floor > MAX_DEPTH_M) {
        tooDeep.push(d);
      } else if (ground - floor > MIN_DEPTH_M) {
        needs.push({ d, floor });
        bridgesOver.add(deck.osm);
      }
    }
    if (needs.length === 0) {
      continue;
    }
    // the floor: the lowest of what each place needs, rising from it at the grade, and never over the ground
    const floorAt = (d: number) => Math.min(...needs.map((x) => x.floor + grade * Math.abs(d - x.d)));
    const stretches: [number, number][] = [];
    for (let d = 0; d <= length; d += SAMPLE_M) {
      const ground = heightAt(...at(d));
      if (ground === undefined || floorAt(d) >= ground - MIN_DEPTH_M) {
        continue;
      }
      const last = stretches[stretches.length - 1];
      if (last && d - SAMPLE_M <= last[1]) {
        last[1] = d;
      } else {
        stretches.push([d, d]);
      }
    }
    // the cut reaches on to where the ramp meets the ground; a chain ending in it is left as it is
    const cuts = stretches.map(([from, to]): [number, number] => [Math.max(0, from - SAMPLE_M), Math.min(length, to + SAMPLE_M)]);
    // a cut reaching a place too deep for it, the chain's end, or a point another way meets it at is left out
    const inChain = new Set<Way>(members.map((m) => m.way));
    const meets = line.map((p, i) => ({ d: along[i], other: [...(usedBy.get(key(p)) ?? [])].some((w) => !inChain.has(w)) })).filter((x) => x.other);
    const kept = cuts.filter(([from, to]) => from > 0 && to < length && !tooDeep.some((d) => d >= from && d <= to) && !meets.some((x) => x.d >= from && x.d <= to));
    cuts.length = 0;
    cuts.push(...kept);
    if (cuts.length === 0) {
      continue;
    }
    count += cuts.length;
    for (const osm of bridgesOver) {
      over.add(osm);
    }
    const height = (d: number) => Math.min(floorAt(d), heightAt(...at(d)) ?? floorAt(d));
    // each member split at the cuts, in its own direction
    for (const m of members) {
      const own = (d: number) => (m.reversed ? m.offset + m.length - d : m.offset + d);
      const local = cuts
        .map(([a, b]): [number, number] => [Math.max(a, m.offset), Math.min(b, m.offset + m.length)])
        .filter(([a, b]) => b > a)
        .map(([a, b]): [number, number] => (m.reversed ? [m.offset + m.length - b, m.offset + m.length - a] : [a - m.offset, b - m.offset]))
        .sort((x, y) => x[0] - y[0]);
      if (local.length === 0) {
        continue;
      }
      const wayAlong = [0];
      for (let i = 1; i < m.way.line.length; i++) {
        wayAlong.push(wayAlong[i - 1] + Math.hypot(m.way.line[i][0] - m.way.line[i - 1][0], m.way.line[i][1] - m.way.line[i - 1][1]));
      }
      const pieces: { line: Point[]; floor?: number[] }[] = [];
      let from = 0;
      for (const [a, b] of local) {
        pieces.push({ line: stretch(m.way.line, wayAlong, from, a) });
        const ds = [a];
        for (let d = Math.ceil(a / (SAMPLE_M * 2)) * SAMPLE_M * 2; d < b; d += SAMPLE_M * 2) {
          if (d > a) {
            ds.push(d);
          }
        }
        ds.push(b);
        pieces.push({ line: ds.map((d) => stretch(m.way.line, wayAlong, d, d)[0]), floor: ds.map((d) => height(own(d))) });
        from = b;
      }
      pieces.push({ line: stretch(m.way.line, wayAlong, from, m.length) });
      const [head, ...rest] = pieces.filter((p) => p.line.length >= 2);
      if (!head) {
        continue;
      }
      for (const piece of rest) {
        const copy = { ...m.way, line: piece.line };
        if (piece.floor) {
          copy.floor = piece.floor;
        }
        added.push(copy);
      }
      m.way.line = head.line;
      if (head.floor) {
        m.way.floor = head.floor;
      }
    }
  }
  ways.push(...added);
  return count;
}

/** The part of a line from `from` to `to` meters along it; along is each point's distance */
function stretch(line: Point[], along: number[], from: number, to: number): Point[] {
  const at = (d: number): Point => {
    for (let i = 1; i < line.length; i++) {
      if (d <= along[i] || i === line.length - 1) {
        const span = along[i] - along[i - 1];
        const t = span > 0 ? Math.min(Math.max((d - along[i - 1]) / span, 0), 1) : 0;
        return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
      }
    }
    return line[0];
  };
  const points: Point[] = [at(from)];
  for (let i = 0; i < line.length; i++) {
    if (along[i] > from && along[i] < to) {
      points.push(line[i]);
    }
  }
  points.push(at(to));
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}
