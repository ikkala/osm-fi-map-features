// Ways under bridges. A bridge's deck runs straight from the ground at its ends, and the elevation model has no
// ground under it, only the gap spanned from the ground around: a way under a bridge often has too little room
// under the deck, or lies on the span rising with the embankments beside it. The deck stays straight; the way goes
// down into a cut under it instead, ramping down to the floor the room needs, or to its own ground spanned along it
// from either side of the bridge, and up again.
import { deckAt } from "./bridges.ts";
import { distanceToSegment, indexBoxes, MinHeap, pointInPolygon, pointKey, type Point } from "./geometry.ts";
import { bounds, NOT_FOR_VEHICLES, type BridgeOutline, type Rail, type Road } from "./osm.ts";

/** Room a way needs under a deck (m), and the deck's thickness */
const ROOM_M = { people: 2.7, vehicles: 4.2, trams: 4.7, trains: 5.5 };
/** A tramway's bed leaves this much under a deck (m): a tram's height, its rails over the bed and a margin */
const TRAM_BED_ROOM_M = 4;
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
/** The model's span of a bridge's gap reaches this far (m) past the bridge's sides along a way */
const GAP_EDGE_M = 2;
/** A way under a deck with room enough goes down to its own ground only where the model's is this much (m) over it */
const MIN_RISE_M = 0.5;
/** An outline's deck is the nearest bridge way's within this far (m) */
const OUTLINE_REACH_M = 30;
const TRAMS = new Set(["tram", "light_rail"]);

type Way = Road | Rail;

/** The deck over a point of a way on a layer (and its bridge's id): a bridge's within its width, or its outline's */
export function decksOver(bridges: Way[], outlines: BridgeOutline[]): (p: Point, layer: number) => { deck: number; osm: string } | undefined {
  const spans = bridges
    .filter((b) => b.bridge && b.deck && b.line.length >= 2)
    .map((b) => ({ osm: b.osm, line: b.line, deck: b.deck ?? [], box: bounds(b.line), half: ("width" in b ? b.width : RAIL_WIDTH_M) / 2 + DECK_EDGE_M, layer: Math.max(b.layer, 1) }));
  const shapes = outlines.map((o) => ({ polygon: o.polygon, box: bounds(o.polygon.outer) }));
  const reaches = spans.map(({ box }) => ({ minX: box.minX - OUTLINE_REACH_M, minY: box.minY - OUTLINE_REACH_M, maxX: box.maxX + OUTLINE_REACH_M, maxY: box.maxY + OUTLINE_REACH_M }));
  const near = indexBoxes(reaches, bounds(reaches.flatMap((r): Point[] => [[r.minX, r.minY], [r.maxX, r.maxY]])));
  return ([e, n], layer) => {
    let nearest: { d: number; deck: number; osm: string } | undefined;
    for (const index of near({ minX: e, minY: n, maxX: e, maxY: n })) {
      const span = spans[index];
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
}

/**
 * Whether a point is under a bridge (within its way's width, or in its outline with a bridge way in it), where the
 * elevation model has no ground
 */
export function underBridges(bridges: Way[], outlines: BridgeOutline[]): (p: Point) => boolean {
  const spans = bridges
    .filter((b) => b.bridge && b.line.length >= 2)
    .map((b) => ({ line: b.line, box: bounds(b.line), half: ("width" in b ? b.width : RAIL_WIDTH_M) / 2 + DECK_EDGE_M }));
  const shapes = outlines
    .map((o) => ({ polygon: o.polygon, box: bounds(o.polygon.outer) }))
    .filter(({ polygon }) => spans.some(({ line }) => line.some((p) => pointInPolygon(p, polygon))));
  return ([e, n]) =>
    spans.some(
      ({ line, box, half }) =>
        e >= box.minX - half &&
        e <= box.maxX + half &&
        n >= box.minY - half &&
        n <= box.maxY + half &&
        line.some((a, i) => i + 1 < line.length && distanceToSegment([e, n], a, line[i + 1]) <= half),
    ) || shapes.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
}

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
  const over = decksOver(bridges.filter((b) => !TRAMS.has(b.kind)), outlines);
  return (p, layer) => {
    const deck = over(p, layer);
    const ground = heightAt(...p);
    if (!deck || ground === undefined) {
      return undefined;
    }
    const ceiling = deck.deck - DECK_THICKNESS_M - TRAM_BED_ROOM_M;
    return ground - ceiling <= MAX_DEPTH_M ? ceiling : undefined;
  };
}

/**
 * Lowers the ways passing under bridges (`deck`) and bridge outlines into cuts where the deck leaves them less than
 * ROOM_M and its thickness over the ground: the stretch is split off the way with a `floor`, at that depth under
 * the deck and ramping up to the ground no steeper than GRADE. Ways of a kind on a layer go down together where they
 * meet, at one height there, the ramps rising from the deepest places along them all, so that paths meeting under a
 * bridge stay joined. A cut is left out where it would go deeper than MAX_DEPTH_M, where a way ends in it, and where
 * another way meets it (of another kind or layer, a bridge or a way on one, or one of `others`: a junction or a level
 * crossing, which would be left over it); so are the bridges themselves and the ways on them. Returns how many cuts;
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
  const deckOver = decksOver(bridges, outlines);
  const classOf = (way: Way) => ("width" in way ? (NOT_FOR_VEHICLES.has(way.kind) ? "people" : "vehicles") : TRAMS.has(way.kind) ? "trams" : "trains");
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
    const kind = classOf(way);
    return { way, along, length, ds, pointOf, sampleOf, room: ROOM_M[kind], grade: GRADE[kind === "trams" ? "trains" : kind], group: `${kind}|${way.layer}` };
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
  // the ground along a way where the model has none, under a bridge: spanned along the way from where it has, on
  // either side (the model's own span, across the bridge, rises with the embankments beside the way)
  const gap = underBridges(bridges, outlines);
  const spanned = (w: number): (number | undefined)[] => {
    const { ds } = lines[w];
    const inGap = ds.map((_, i) => gap(pointAt(w, i)));
    const under = ds.map((d, i) => {
      for (let j = i; j >= 0 && d - ds[j] <= GAP_EDGE_M; j--) {
        if (inGap[j]) {
          return true;
        }
      }
      for (let j = i + 1; j < ds.length && ds[j] - d <= GAP_EDGE_M; j++) {
        if (inGap[j]) {
          return true;
        }
      }
      return false;
    });
    const own = ds.map((_, i) => (under[i] ? undefined : groundOf(w, i)));
    return ds.map((d, i) => {
      if (!under[i]) {
        return own[i];
      }
      let a = i;
      while (a >= 0 && own[a] === undefined) {
        a--;
      }
      let b = i;
      while (b < ds.length && own[b] === undefined) {
        b++;
      }
      const before = a >= 0 ? own[a] : undefined;
      const after = b < ds.length ? own[b] : undefined;
      if (before === undefined || after === undefined) {
        return before ?? after ?? groundOf(w, i);
      }
      return before + ((after - before) * (d - ds[a])) / (ds[b] - ds[a]);
    });
  };
  // where the deck is too low over a way, or the model's ground under it over the way's own: the floor it needs
  // there, and the bridge; where the deck would need it deeper than MAX_DEPTH_M
  const needs = new Map<string, { floor: number; osm: string }>();
  const tooDeep = new Set<string>();
  lines.forEach((line, w) => {
    let own: (number | undefined)[] | undefined;
    for (let i = 0; i < line.ds.length; i++) {
      const deck = deckOver(pointAt(w, i), line.way.layer);
      const ground = deck && groundOf(w, i);
      if (!deck || ground === undefined) {
        continue;
      }
      own ??= spanned(w);
      const base = own[i] ?? ground;
      const room = deck.deck - DECK_THICKNESS_M - line.room;
      const floor = Math.min(room, base);
      const id = nodeId(w, i);
      if (base - room > MAX_DEPTH_M) {
        tooDeep.add(id);
      } else if (ground - floor > (floor === room ? MIN_DEPTH_M : MIN_RISE_M) && floor < (needs.get(id)?.floor ?? Infinity)) {
        needs.set(id, { floor, osm: deck.osm });
      }
    }
  });
  if (needs.size === 0) {
    return 0;
  }
  // the floor: the lowest of what each place needs, rising from it at the grade along the ways, spreading only
  // while under the ground
  const floors = new Map<string, number>();
  const at = new Map<string, [number, number]>();
  const heap = new MinHeap<string>();
  for (const [id, { floor }] of needs) {
    floors.set(id, floor);
    heap.push(id, floor);
  }
  for (const [w, line] of lines.entries()) {
    line.ds.forEach((_, i) => {
      const id = nodeId(w, i);
      if (needs.has(id) && !at.has(id)) {
        at.set(id, [w, i]);
      }
    });
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
  for (let top = heap.pop(); top; top = heap.pop()) {
    if (top.value > (floors.get(top.item) ?? Infinity) || !inCut(top.item)) {
      continue;
    }
    const [w0] = at.get(top.item) ?? [0];
    for (const next of neighbours(top.item)) {
      const floor = top.value + lines[w0].grade * next.d;
      if (floor < (floors.get(next.id) ?? Infinity)) {
        floors.set(next.id, floor);
        at.set(next.id, [next.w, next.i]);
        heap.push(next.id, floor);
      }
    }
  }
  // the points of all the ways, by which ways have them
  const usedBy = new Map<string, Set<Way>>();
  for (const way of [...ways, ...others]) {
    for (const p of way.line) {
      usedBy.set(pointKey(p), (usedBy.get(pointKey(p)) ?? new Set<Way>()).add(way));
    }
  }
  // the cuts: the places under the ground and the ramps' tops around them, joined along the ways; each kept whole or
  // left out whole
  const kept = new Map<number, Set<number>>();
  const done = new Set<string>();
  let count = 0;
  for (const start of floors.keys()) {
    if (done.has(start) || !inCut(start)) {
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
      if (tooDeep.has(id)) {
        return true;
      }
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
      continue;
    }
    count++;
    for (const id of cut) {
      const need = needs.get(id);
      if (need) {
        over.add(need.osm);
      }
      const [w0, i0] = at.get(id) ?? [0, 0];
      for (const [w, i] of membersOf(id, w0, i0)) {
        kept.set(w, (kept.get(w) ?? new Set<number>()).add(i));
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
    const pieces: { line: Point[]; floor?: number[] }[] = [];
    let from = 0;
    for (const [a, b] of runs.filter(([a, b]) => b > a)) {
      pieces.push({ line: stretch(way.line, along, from, ds[a]) });
      // the samples every other SAMPLE_M, and the way's points
      const kept = [];
      for (let i = a; i <= b; i++) {
        if (i === a || i === b || pointOf[i] >= 0 || Math.round(ds[i] / SAMPLE_M) % 2 === 0) {
          kept.push(i);
        }
      }
      pieces.push({
        line: kept.map((i) => pointAt(w, i)),
        floor: kept.map((i) => Math.min(floors.get(nodeId(w, i)) ?? Infinity, groundOf(w, i) ?? Infinity)),
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
        if ("width" in copy) {
          copy.room = lines[w].room;
        }
      }
      added.push(copy);
    }
    way.line = head.line;
    if (head.floor) {
      way.floor = head.floor;
      if ("width" in way) {
        way.room = lines[w].room;
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
