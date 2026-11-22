// Ways under bridges. A bridge's deck runs straight from the ground at its ends, and a way under it, on the bare
// ground there (bareGround.ts), often has too little room under the deck. The deck stays straight; the way goes down
// into a cut under it instead, ramping down to the floor the room needs, and up again.
import { deckAt } from "./bridges.ts";
import { DeckIndex } from "./deckIndex.ts";
import { distanceToSegment, indexBoxes, MinHeap, pointInPolygon, pointKey, type Point, type Rect } from "./geometry.ts";
import { bounds, type BridgeDeck, type BridgeOutline } from "./osm.ts";
import { DECK_EDGE_M, DECK_THICKNESS_M, GRADE, STAIRS_GRADE, isRoad, MIN_CLEARANCE_M, TRAM_CUT_CLEARANCE_M, TRAMWAYS, userOf, widthOf, type Way } from "./ways.ts";

/** A ramp out of a cut's bottom rises EASE_M · d² (m) d meters from it until it has its grade, so that the floor
 * bends gently there: by EASE_M · 100 m² from the line between its heights 10 m either side */
const EASE_M = 0.0012;
/** A cut's floor keeps the points it needs to stay within this (m) of its heights */
const FLOOR_TOLERANCE_M = 0.02;
/** A cut goes no deeper than this (m). Where the room needs more, the way goes down this far, which leaves it less
 * room than its users need but more than the ground would */
const MAX_DEPTH_M = 3;
/** A way is looked at this often (m), and lowered by less than this (m) not at all */
const SAMPLE_M = 1;
const MIN_DEPTH_M = 0.05;

/**
 * The highest a tramway's bed may be at a point under a deck, leaving a tram its room: under the decks of the bridges
 * that are not tramways (a tramway's bridge outline reaches over its own ways beside the bridge) and their outlines,
 * where the ground is at most MAX_DEPTH_M over that (deeper, the deck is the tramway's own or the data is wrong), else
 * undefined
 */
export function tramBedCeiling(
  bridges: Way[],
  outlines: BridgeOutline[],
  heightAt: (e: number, n: number) => number | undefined,
): (p: Point, layer: number) => number | undefined {
  const decks = new DeckIndex(bridges.filter((b) => !TRAMWAYS.has(b.kind)), outlines);
  return (p, layer) => {
    const deck = decks.over(p, layer);
    const ground = heightAt(...p);
    if (!deck || ground === undefined) {
      return undefined;
    }
    const ceiling = deck.deck - DECK_THICKNESS_M - MIN_CLEARANCE_M.trams;
    return ground - ceiling <= MAX_DEPTH_M ? ceiling : undefined;
  };
}

/**
 * Lowers the ways passing under bridges (`deck`) and bridge outlines into cuts where the deck leaves them less than
 * its users' MIN_CLEARANCE_M (a tramway TRAM_CUT_CLEARANCE_M) and its thickness over the ground: the stretch is split off the way with a `floor`, at that depth under
 * the deck and ramping up to the ground, easing out of the bottom (EASE_M) into no steeper than GRADE, steps as stairs (STAIRS_GRADE). Ways of a kind
 * on a layer go down together where they meet, at one height there, the ramps rising from the deepest places along
 * them all, so that paths meeting under a bridge stay joined. A cut is left out where a way ends in it, and where another
 * way meets it (of another kind or layer, a bridge or a
 * way on one, or one of `others`: a junction or a level crossing, which would be left over it); so are the bridges
 * themselves and the ways on them. An outline's deck is the one built (decks), where given (DeckIndex). Returns how
 * many cuts; the OSM ids of the bridges over them go into `over` (a cut may tell of a bridge's ends too low in the
 * model).
 */
export function lowerUnderBridges<T extends Way>(
  ways: T[],
  bridges: Way[],
  outlines: BridgeOutline[],
  heightAt: (e: number, n: number) => number | undefined,
  over: Set<string> = new Set(),
  others: Way[] = ways,
  decks?: BridgeDeck[],
): number {
  const index = new DeckIndex(bridges, outlines, decks);
  const deckOver = (p: Point, layer: number) => index.over(p, layer);
  const eligible = ways.filter((w) => !w.bridge && !w.tunnel && !w.deck && !w.floor && !w.lid && w.line.length >= 2);
  // each way's samples, every SAMPLE_M along it and at its points, and which point a sample is (-1: none)
  const lines = eligible.map((way) => {
    const along = [0];
    for (let i = 1; i < way.line.length; i++) {
      along.push(along[i - 1] + Math.hypot(way.line[i][0] - way.line[i - 1][0], way.line[i][1] - way.line[i - 1][1]));
    }
    const length = along[along.length - 1];
    const marks = along.map((d, point) => ({ d, point }));
    for (let d = 0; d < length; d += SAMPLE_M) {
      marks.push({ d, point: -1 });
    }
    marks.sort((a, b) => a.d - b.d || b.point - a.point);
    const ds: number[] = [];
    const pointOf: number[] = [];
    const sampleOf: number[] = [];
    for (const { d, point } of marks) {
      const last = ds.length - 1;
      if (last >= 0 && d - ds[last] < 1e-6 && (point < 0 || pointOf[last] >= 0)) {
        if (point >= 0) {
          sampleOf[point] = last;
        }
        continue;
      }
      ds.push(d);
      pointOf.push(point);
      if (point >= 0) {
        sampleOf[point] = ds.length - 1;
      }
    }
    const kind = userOf(way);
    return { way, along, length, ds, pointOf, sampleOf, room: kind === "trams" ? TRAM_CUT_CLEARANCE_M : MIN_CLEARANCE_M[kind], grade: way.kind === "steps" ? STAIRS_GRADE : GRADE[kind], group: `${kind}|${way.layer}` };
  });
  // a sample's node: a point shared by the ways of a group is one node
  const nodeId = (w: number, i: number) => {
    const line = lines[w];
    const point = line.pointOf[i];
    return point >= 0 ? `${line.group}|${pointKey(line.way.line[point])}` : `${w}:${i}`;
  };
  const members = new Map<string, [number, number][]>();
  lines.forEach((line, w) => {
    line.sampleOf.forEach((i) => {
      const id = nodeId(w, i);
      const list = members.get(id) ?? [];
      if (!list.some(([w2, i2]) => w2 === w && i2 === i)) {
        list.push([w, i]);
      }
      members.set(id, list);
    });
  });
  const membersOf = (id: string, w: number, i: number) => members.get(id) ?? [[w, i]];
  const pointAt = (w: number, i: number): Point => stretch(lines[w].way.line, lines[w].along, lines[w].ds[i], lines[w].ds[i])[0];
  const grounds = new Map<string, number | undefined>();
  const groundOf = (w: number, i: number) => {
    const id = nodeId(w, i);
    if (!grounds.has(id)) {
      grounds.set(id, heightAt(...pointAt(w, i)));
    }
    return grounds.get(id);
  };
  // where the deck is too low over a way: the floor it needs there, and the bridge
  const needs = new Map<string, { floor: number; osm: string; room: number }>();
  lines.forEach((line, w) => {
    for (let i = 0; i < line.ds.length; i++) {
      const deck = deckOver(pointAt(w, i), line.way.layer);
      const ground = deck && groundOf(w, i);
      if (!deck || ground === undefined) {
        continue;
      }
      const underside = deck.deck - DECK_THICKNESS_M;
      // the floor the room needs, no deeper than MAX_DEPTH_M
      const floor = Math.max(underside - line.room, ground - MAX_DEPTH_M);
      const id = nodeId(w, i);
      if (ground - floor > MIN_DEPTH_M && floor < (needs.get(id)?.floor ?? Infinity)) {
        needs.set(id, { floor, osm: deck.osm, room: underside - floor });
      }
    }
  });
  if (needs.size === 0) {
    return 0;
  }
  const needAt = new Map<string, [number, number]>();
  for (const [w, line] of lines.entries()) {
    line.ds.forEach((_, i) => {
      const id = nodeId(w, i);
      if (needs.has(id) && !needAt.has(id)) {
        needAt.set(id, [w, i]);
      }
    });
  }
  // the floor: the lowest of what each place needs, rising from it along the ways (easing out of the bottom, or at
  // once at the grade), spreading only while under the ground; and where each place is
  const spread = (eased: boolean) => {
    const floors = new Map<string, number>();
    const at = new Map(needAt);
    const heap = new MinHeap<string>();
    for (const [id, { floor }] of needs) {
      floors.set(id, floor);
      heap.push(id, floor);
    }
    const inCut = (id: string) => {
      const [w, i] = at.get(id) ?? [-1, -1];
      const ground = w >= 0 ? groundOf(w, i) : undefined;
      return ground !== undefined && (floors.get(id) ?? Infinity) < ground - MIN_DEPTH_M;
    };
    const neighbours = (id: string): { id: string; w: number; i: number; d: number }[] => {
      const [w0, i0] = at.get(id) ?? [-1, -1];
      return membersOf(id, w0, i0).flatMap(([w, i]) =>
        [i - 1, i + 1].filter((j) => j >= 0 && j < lines[w].ds.length).map((j) => ({ id: nodeId(w, j), w, i: j, d: Math.abs(lines[w].ds[j] - lines[w].ds[i]) })),
      );
    };
    // each place's floor as the rise from the place it spreads from
    const from = new Map<string, { floor: number; d: number }>();
    for (let top = heap.pop(); top; top = heap.pop()) {
      if (top.value > (floors.get(top.item) ?? Infinity) || !inCut(top.item)) {
        continue;
      }
      const [w0] = at.get(top.item) ?? [0];
      const { grade } = lines[w0];
      const source = from.get(top.item) ?? { floor: top.value, d: 0 };
      for (const next of neighbours(top.item)) {
        const d = source.d + next.d;
        const floor = source.floor + (eased ? rise(grade, d) : grade * d);
        if (floor < (floors.get(next.id) ?? Infinity)) {
          floors.set(next.id, floor);
          at.set(next.id, [next.w, next.i]);
          from.set(next.id, { floor: source.floor, d });
          heap.push(next.id, floor);
        }
      }
    }
    return { floors, at, inCut, neighbours };
  };
  // the points of all the ways, by which ways have them
  const usedBy = new Map<string, Set<Way>>();
  for (const way of [...ways, ...others]) {
    for (const p of way.line) {
      usedBy.set(pointKey(p), (usedBy.get(pointKey(p)) ?? new Set<Way>()).add(way));
    }
  }
  // the cuts: the places under the ground and the ramps' tops around them, joined along the ways; each kept whole or
  // left out whole. Their ramps ease out of the bottom, or where such a cut is left out (its longer ramps reaching a
  // junction or an end), rise at once at the grade: the places of those cuts are within the eased one's
  const kept = new Map<number, Set<number>>();
  const chosen = new Map<string, number>();
  let count = 0;
  const failed = new Set<string>();
  for (const eased of [true, false]) {
    const { floors, at, inCut, neighbours } = spread(eased);
    const done = new Set<string>();
    for (const start of floors.keys()) {
      if (done.has(start) || !inCut(start) || (!eased && !failed.has(start))) {
        continue;
      }
      const cut = [start];
      done.add(start);
      for (let k = 0; k < cut.length; k++) {
        if (inCut(cut[k])) {
          for (const next of neighbours(cut[k])) {
            if (!done.has(next.id) && floors.has(next.id)) {
              done.add(next.id);
              cut.push(next.id);
            }
          }
        }
      }
      const wrong = cut.some((id) => {
        const [w0, i0] = at.get(id) ?? [0, 0];
        const list = membersOf(id, w0, i0);
        // a way ending here and no other going on
        if (list.length === 1 && (i0 === 0 || i0 === lines[w0].ds.length - 1)) {
          return true;
        }
        // a way of another kind, or one not lowered, meeting it here
        const point = lines[w0].pointOf[i0];
        const mine = new Set<Way>(list.map(([w]) => lines[w].way));
        return point >= 0 && [...(usedBy.get(pointKey(lines[w0].way.line[point])) ?? [])].some((way) => !mine.has(way));
      });
      if (wrong) {
        for (const id of cut) {
          failed.add(id);
        }
        continue;
      }
      count++;
      for (const id of cut) {
        const need = needs.get(id);
        if (need) {
          over.add(need.osm);
        }
        const floor = floors.get(id);
        if (floor !== undefined) {
          chosen.set(id, floor);
        }
        const [w0, i0] = at.get(id) ?? [0, 0];
        for (const [w, i] of membersOf(id, w0, i0)) {
          kept.set(w, (kept.get(w) ?? new Set<number>()).add(i));
        }
      }
    }
  }
  // a cut's floor rises only to meet the ground: between two lower places along a way, under the ground, it runs
  // straight, with no ridge of its own (where the needs of the ways meeting it leave it rising and falling again)
  for (const [w, samples] of kept) {
    const run = [...samples].sort((x, y) => x - y).filter((i) => membersOf(nodeId(w, i), w, i).length === 1);
    const { ds } = lines[w];
    for (let moved = true; moved; ) {
      moved = false;
      for (const i of run) {
        const [before, after] = [i - 1, i + 1];
        const [hb, h, ha] = [chosen.get(nodeId(w, before)), chosen.get(nodeId(w, i)), chosen.get(nodeId(w, after))];
        const ground = groundOf(w, i);
        if (hb === undefined || h === undefined || ha === undefined || ground === undefined || !samples.has(before) || !samples.has(after)) {
          continue;
        }
        const line = hb + ((ha - hb) * (ds[i] - ds[before])) / (ds[after] - ds[before]);
        if (h > line + 1e-6 && h < ground - MIN_DEPTH_M) {
          chosen.set(nodeId(w, i), line);
          moved = true;
        }
      }
    }
  }
  // each way split at its cuts
  const added: T[] = [];
  for (const [w, samples] of kept) {
    const { way, along, length, ds, pointOf } = lines[w];
    const runs: [number, number][] = [];
    for (let i = 0; i < ds.length; i++) {
      if (samples.has(i) && samples.has(i - 1) && runs.length > 0 && runs[runs.length - 1][1] === i - 1) {
        runs[runs.length - 1][1] = i;
      } else if (samples.has(i)) {
        runs.push([i, i]);
      }
    }
    const pieces: { line: Point[]; floor?: number[]; room?: number }[] = [];
    let from = 0;
    for (const [a, b] of runs.filter(([a, b]) => b > a)) {
      pieces.push({ line: stretch(way.line, along, from, ds[a]) });
      // the way's points, and of the samples those the floor's shape needs: a ramp at its grade has none between its
      // ends, so that heights and coordinates rounded in a map's tiles do not make it waver
      const run: number[] = [];
      for (let i = a; i <= b; i++) {
        run.push(i);
      }
      const heightOf = (i: number) => Math.min(chosen.get(nodeId(w, i)) ?? Infinity, groundOf(w, i) ?? Infinity);
      const kept = simplified(run, (i) => ds[i], heightOf, FLOOR_TOLERANCE_M, (i) => pointOf[i] >= 0);
      pieces.push({
        line: kept.map((i) => pointAt(w, i)),
        floor: kept.map(heightOf),
        room: Math.min(lines[w].room, ...run.map((i) => needs.get(nodeId(w, i))?.room ?? Infinity)),
      });
      from = ds[b];
    }
    pieces.push({ line: stretch(way.line, along, from, length) });
    const [head, ...rest] = pieces.filter((p) => p.line.length >= 2);
    if (!head) {
      continue;
    }
    // a road's room in the cut is the one its floor leaves under the deck, so its roof stays under it
    for (const piece of rest) {
      const copy = { ...way, line: piece.line };
      if (piece.floor) {
        copy.floor = piece.floor;
        if (isRoad(copy)) {
          copy.room = piece.room;
        }
      }
      added.push(copy);
    }
    way.line = head.line;
    if (head.floor) {
      way.floor = head.floor;
      if (isRoad(way)) {
        way.room = head.room;
      }
    }
  }
  ways.push(...added);
  return count;
}

/**
 * Of indices in order along a line (at x), the first, the last, those that must stay, and between them those that
 * keep y within tolerance of the straight lines between the ones kept (Douglas-Peucker)
 */
function simplified(indices: number[], x: (i: number) => number, y: (i: number) => number, tolerance: number, must: (i: number) => boolean): number[] {
  const keep = new Set<number>([0, indices.length - 1]);
  const spans: [number, number][] = [];
  let start = 0;
  for (let k = 1; k < indices.length; k++) {
    if (k === indices.length - 1 || must(indices[k])) {
      keep.add(k);
      spans.push([start, k]);
      start = k;
    }
  }
  for (let span = spans.pop(); span; span = spans.pop()) {
    const [s, e] = span;
    const [xs, xe, ys, ye] = [x(indices[s]), x(indices[e]), y(indices[s]), y(indices[e])];
    let worst = -1;
    let most = tolerance;
    for (let k = s + 1; k < e; k++) {
      const off = Math.abs(y(indices[k]) - (ys + ((ye - ys) * (x(indices[k]) - xs)) / (xe - xs || 1)));
      if (off > most) {
        most = off;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      spans.push([s, worst], [worst, e]);
    }
  }
  return indices.filter((_, k) => keep.has(k));
}

/** How much a ramp at a grade rises d meters from a cut's bottom: EASE_M · d² until it has the grade, then on at it */
function rise(grade: number, d: number): number {
  const eased = grade / (2 * EASE_M);
  return d < eased ? EASE_M * d * d : EASE_M * eased * eased + grade * (d - eased);
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
