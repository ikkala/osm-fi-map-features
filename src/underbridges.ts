// Ways under bridges. A bridge's deck runs straight from the ground at its ends, and the elevation model has no
// ground under it, only the gap spanned from the ground around: a way under a bridge often has too little room
// under the deck, or lies on the span rising with the embankments beside it. The deck stays straight; the way goes
// down into a cut under it instead, ramping down to the floor the room needs, or to its own ground spanned along it
// from either side of the bridge, and up again.
import { deckAt } from "./bridges.ts";
import { distanceToSegment, indexBoxes, MinHeap, pointInPolygon, pointKey, type Point, type Rect } from "./geometry.ts";
import { bounds, NOT_FOR_VEHICLES, type BridgeDeck, type BridgeOutline, type Rail, type Road } from "./osm.ts";

/** Room a way needs under a deck (m), and the deck's thickness */
const ROOM_M = { people: 2.7, vehicles: 4.2, trams: 4.7, trains: 5.5 };
/** A tramway's bed leaves this much under a deck (m): a tram's height, its rails over the bed and a margin */
const TRAM_BED_ROOM_M = 4;
const DECK_THICKNESS_M = 1;
/** A way ramps down into a cut no steeper than this */
const GRADE = { people: 0.08, vehicles: 0.06, trains: 0.03 };
/** A ramp out of a cut's bottom rises EASE_M · d² (m) d meters from it until it has its grade, so that the floor
 * bends gently there: by EASE_M · 100 m² from the line between its heights 10 m either side */
const EASE_M = 0.0012;
/** A cut's floor keeps the points it needs to stay within this (m) of its heights */
const FLOOR_TOLERANCE_M = 0.02;
/** A cut goes no deeper than this (m). Where the room needs more, the way goes down this far if that leaves it the
 * least room of its kind (a person's, a bus's, a tram's, a train's), else it is left as it is */
const MAX_DEPTH_M = 3;
const LEAST_ROOM_M = { people: 2.2, vehicles: 3.5, trams: TRAM_BED_ROOM_M, trains: 4.8 };
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

/**
 * The deck over a point of a way on a layer (and its bridge's id): a bridge's within its width, or its outline's. With
 * the outlines' decks as built (setOutlineDecks), an outline's is theirs where they are over the point, the lower of it
 * and a bridge's there, and none where they leave the outline open; else the nearest bridge way's in the outline.
 */
export function decksOver(bridges: Way[], outlines: BridgeOutline[], decks?: BridgeDeck[]): (p: Point, layer: number) => { deck: number; osm: string } | undefined {
  const built = decks && builtDeckAt(decks);
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
    const within = nearest && nearest.d <= 0 ? nearest : undefined;
    if (built) {
      // an outline's deck is over ways under its layer, as a bridge's is
      const piece = layer < 1 ? built([e, n]) : undefined;
      return piece && (!within || piece.deck < within.deck) ? piece : within;
    }
    if (!nearest || nearest.d > OUTLINE_REACH_M) {
      return undefined;
    }
    if (within) {
      return within;
    }
    const inOutline = shapes.some(({ polygon, box }) => e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY && pointInPolygon([e, n], polygon));
    return inOutline ? nearest : undefined;
  };
}

/** The lowest of the decks' triangles over a point, at its height there (and its outline's id) */
function builtDeckAt(decks: BridgeDeck[]): (p: Point) => { deck: number; osm: string } | undefined {
  const triangles = decks.flatMap((d) => {
    const found: { osm: string; corners: Point[]; heights: number[]; box: Rect }[] = [];
    for (let i = 0; i + 2 < d.triangles.length; i += 3) {
      const ks = [d.triangles[i], d.triangles[i + 1], d.triangles[i + 2]];
      const corners = ks.map((k) => d.vertices[k]);
      found.push({ osm: d.osm, corners, heights: ks.map((k) => d.heights[k]), box: bounds(corners) });
    }
    return found;
  });
  if (triangles.length === 0) {
    return () => undefined;
  }
  const near = indexBoxes(
    triangles.map((t) => t.box),
    bounds(triangles.flatMap((t) => t.corners)),
  );
  return ([e, n]) => {
    let lowest: { deck: number; osm: string } | undefined;
    for (const index of near({ minX: e, minY: n, maxX: e, maxY: n })) {
      const { corners, heights, osm } = triangles[index];
      const [[ax, ay], [bx, by], [cx, cy]] = corners;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) {
        continue;
      }
      // barycentric weights of b and c; inside where all three are at least 0
      const wb = ((e - ax) * (cy - ay) - (cx - ax) * (n - ay)) / area;
      const wc = ((bx - ax) * (n - ay) - (e - ax) * (by - ay)) / area;
      const wa = 1 - wb - wc;
      if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) {
        continue;
      }
      const deck = wa * heights[0] + wb * heights[1] + wc * heights[2];
      if (!lowest || deck < lowest.deck) {
        lowest = { deck, osm };
      }
    }
    return lowest;
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
 * the deck and ramping up to the ground, easing out of the bottom (EASE_M) into no steeper than GRADE. Ways of a kind
 * on a layer go down together where they meet, at one height there, the ramps rising from the deepest places along
 * them all, so that paths meeting under a bridge stay joined. A cut is left out where MAX_DEPTH_M would leave less
 * than LEAST_ROOM_M, where a way ends in it, and where another way meets it (of another kind or layer, a bridge or a
 * way on one, or one of `others`: a junction or a level crossing, which would be left over it); so are the bridges
 * themselves and the ways on them. An outline's deck is the one built (decks), where given (decksOver). Returns how
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
  const deckOver = decksOver(bridges, outlines, decks);
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
    return { way, along, length, ds, pointOf, sampleOf, room: ROOM_M[kind], least: LEAST_ROOM_M[kind], grade: GRADE[kind === "trams" ? "trains" : kind], group: `${kind}|${way.layer}` };
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
  const needs = new Map<string, { floor: number; osm: string; room: number }>();
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
      const underside = deck.deck - DECK_THICKNESS_M;
      // the floor the room needs, or no deeper than MAX_DEPTH_M where that leaves the least room
      const room = Math.max(underside - line.room, base - MAX_DEPTH_M);
      const floor = Math.min(room, base);
      const id = nodeId(w, i);
      if (underside - room < line.least) {
        tooDeep.add(id);
      } else if (ground - floor > (floor === room ? MIN_DEPTH_M : MIN_RISE_M) && floor < (needs.get(id)?.floor ?? Infinity)) {
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
        if ("width" in copy) {
          copy.room = piece.room;
        }
      }
      added.push(copy);
    }
    way.line = head.line;
    if (head.floor) {
      way.floor = head.floor;
      if ("width" in way) {
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
