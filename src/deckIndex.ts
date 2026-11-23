// One index of the bridges' decks, which the stages building around them ask: the deck's height at a point, whether
// a point is under a deck or on one. A bridge way's deck runs along its line (its `deck` heights) as wide as the way
// and DECK_EDGE_M past its sides (ways.ts); an outline's deck is its pieces as built (setOutlineDecks: triangles with
// the deck's height at their corners), or, before those, the nearest bridge way's in it.
import { deckAt } from "./bridges.ts";
import { distanceToSegment, indexBoxes, nearestOnLine, pointInPolygon, type Point, type Rect } from "./geometry.ts";
import { bounds, type BridgeDeck, type BridgeOutline } from "./osm.ts";
import { DECK_EDGE_M, DECK_THICKNESS_M, LID_EDGE_M, MIN_CLEARANCE_M, TRAMWAYS, widthOf, type Way } from "./ways.ts";
import { inTunnel, isBridge } from "./profile.ts";

/** An outline's deck, before it is built, is the nearest bridge way's within this far (m) */
const OUTLINE_REACH_M = 30;
/** A point this far (m) past a deck's edge is still under it, as the bottom of a cut under it is */
export const UNDER_SIDE_M = 1;
/** A cut under a deck goes no deeper than this (m) */
export const MAX_DEPTH_M = 3;

interface Span {
  way: Way;
  osm: string;
  line: Point[];
  deck: number[];
  box: Rect;
  half: number;
  layer: number;
  /** The room under it OSM tells (min_height=*) */
  room?: number;
}

interface Piece {
  osm: string;
  corners: Point[];
  heights: number[];
}

/** A bridge's deck or a cut tunnel's lid near a point, and how near: its way's nearest segment and how far from it */
export interface CoverNear {
  kind: "deck" | "lid";
  line: Point[];
  /** Its top at every point of line */
  heights: number[];
  /** Half its way's width, and how far its deck or lid reaches past that */
  half: number;
  edge: number;
  segment: number;
  distance: number;
}

export interface DeckOver {
  /** The deck's top (m above sea level) */
  deck: number;
  /** Its bridge's OSM id */
  osm: string;
  /** The room under it OSM tells (its bridge way's min_height=*), where it does */
  room?: number;
}

export class DeckIndex {
  readonly #spans: Span[];
  readonly #nearSpans: (rect: Rect) => number[];
  readonly #outlines: { polygon: BridgeOutline["polygon"]; box: Rect; bridged: boolean }[];
  readonly #pieces: Piece[];
  readonly #nearPieces: (rect: Rect) => number[];
  readonly #built: boolean;
  /** The ways with a deck (bridges and their approaches), by box */
  readonly #decked: { way: Way; deck: number[]; half: number }[];
  readonly #nearDecked: (rect: Rect) => number[];
  /** The bridges' decks and the lids, by box */
  readonly #covers: Omit<CoverNear, "segment" | "distance">[];
  readonly #nearCovers: (rect: Rect) => number[];

  /** The decks of `ways` with `bridge` and `deck`, the outlines, and the outlines' decks as built, where they are */
  constructor(ways: readonly Way[], outlines: readonly BridgeOutline[] = [], built?: readonly BridgeDeck[]) {
    this.#spans = ways
      .filter((b) => isBridge(b) && b.line.length >= 2)
      .map((b) => ({ way: b, osm: b.osm, line: b.line, deck: b.deck ?? [], box: bounds(b.line), half: widthOf(b) / 2 + DECK_EDGE_M, layer: Math.max(b.layer, 1), ...(b.roomUnder !== undefined && { room: b.roomUnder }) }));
    const reaches = this.#spans.map(({ box }) => grow(box, OUTLINE_REACH_M));
    this.#nearSpans = reaches.length > 0 ? indexBoxes(reaches, around(reaches)) : () => [];
    this.#outlines = outlines.map((o) => ({
      polygon: o.polygon,
      box: bounds(o.polygon.outer),
      bridged: this.#spans.some(({ line }) => line.some((p) => pointInPolygon(p, o.polygon))),
    }));
    this.#built = built !== undefined;
    this.#pieces = (built ?? []).flatMap((d) => {
      const found: Piece[] = [];
      for (let i = 0; i + 2 < d.triangles.length; i += 3) {
        const ks = [d.triangles[i], d.triangles[i + 1], d.triangles[i + 2]];
        found.push({ osm: d.osm, corners: ks.map((k) => d.vertices[k]), heights: ks.map((k) => d.heights[k]) });
      }
      return found;
    });
    const boxes = this.#pieces.map((piece) => bounds(piece.corners));
    this.#nearPieces = boxes.length > 0 ? indexBoxes(boxes, around(boxes)) : () => [];
    this.#decked = ways.flatMap((way) => (way.deck && way.line.length >= 2 && !inTunnel(way) ? [{ way, deck: way.deck, half: widthOf(way) / 2 }] : []));
    const deckedBoxes = this.#decked.map(({ way, half }) => grow(bounds(way.line), half));
    this.#nearDecked = deckedBoxes.length > 0 ? indexBoxes(deckedBoxes, around(deckedBoxes)) : () => [];
    this.#covers = ways.flatMap((w): Omit<CoverNear, "segment" | "distance">[] => {
      const half = widthOf(w) / 2;
      if (w.line.length < 2) {
        return [];
      }
      if (isBridge(w) && w.deck) {
        return [{ kind: "deck", line: w.line, heights: w.deck, half, edge: DECK_EDGE_M }];
      }
      return w.lid ? [{ kind: "lid", line: w.line, heights: w.lid, half, edge: LID_EDGE_M }] : [];
    });
    const coverBoxes = this.#covers.map(({ line, half, edge }) => grow(bounds(line), half + edge));
    this.#nearCovers = coverBoxes.length > 0 ? indexBoxes(coverBoxes, around(coverBoxes)) : () => [];
  }

  /**
   * The bridges' decks and the cut tunnels' lids reaching within `reach` (m) of a point: each with its way's nearest
   * segment to the point and how far that is
   */
  coversNear(p: Point, reach: number): CoverNear[] {
    const found: CoverNear[] = [];
    for (const index of this.#nearCovers(grow({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, reach))) {
      const cover = this.#covers[index];
      let distance = Infinity;
      let segment = 0;
      for (let i = 0; i + 1 < cover.line.length; i++) {
        const away = distanceToSegment(p, cover.line[i], cover.line[i + 1]);
        if (away < distance) {
          distance = away;
          segment = i;
        }
      }
      if (distance <= cover.half + cover.edge + reach) {
        found.push({ ...cover, segment, distance });
      }
    }
    return found;
  }

  /**
   * The way with a deck (a bridge or an approach) a point is on, within its half width and `margin` (m) more, the
   * nearest, and its deck's height there
   */
  on(p: Point, margin: number): { way: Way; deck: number } | undefined {
    let found: { way: Way; deck: number; distance: number } | undefined;
    for (const index of this.#nearDecked(grow({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, margin))) {
      const { way, deck, half } = this.#decked[index];
      const near = nearestOnLine(way.line, p);
      if (near.distance <= half + margin && (!found || near.distance < found.distance)) {
        found = { way, deck: deckAt(way.line, deck, near.point), distance: near.distance };
      }
    }
    return found && { way: found.way, deck: found.deck };
  }

  /**
   * The deck over a point of a way on a layer, and its bridge: a bridge way's with a deck within its deck's width and
   * `margin` (m) more (UNDER_SIDE_M by default), on a higher layer; or an outline's: its built pieces' where they are over the point (the lower
   * of it and a bridge way's there), none where they leave the outline open; before they are built, the nearest bridge
   * way's in the outline
   */
  over(p: Point, layer: number, margin = UNDER_SIDE_M): DeckOver | undefined {
    const near = this.#nearest(p, layer, margin, true);
    const nearest = near && { d: near.d, deck: deckAt(near.span.line, near.span.deck, p), osm: near.span.osm, past: near.past, room: near.span.room };
    const room = nearest?.room !== undefined ? { room: nearest.room } : {};
    const within = nearest && nearest.d <= 0 && !nearest.past ? { deck: nearest.deck, osm: nearest.osm, ...room } : undefined;
    if (this.#built) {
      // an outline's deck is over ways under its layer, as a bridge's is, with the room its bridge way's tag tells
      const piece = layer < 1 ? this.built(p) : undefined;
      return piece && (!within || piece.deck < within.deck) ? { ...piece, ...(within && room) } : within;
    }
    if (!nearest || nearest.d > OUTLINE_REACH_M) {
      return undefined;
    }
    return within ?? (this.#outlines.some(({ polygon, box }) => inside(box, p) && pointInPolygon(p, polygon)) ? { deck: nearest.deck, osm: nearest.osm } : undefined);
  }

  /**
   * The bridge way whose deck is over a point of a way on a layer, as `over` finds it before the outlines are built,
   * whether its heights are set or not (in an outline only where `outlined`): its line's nearest segment and how far
   * along it the point is (0 to 1)
   */
  spanOver(p: Point, layer: number, margin = UNDER_SIDE_M, outlined = false): { way: Way; segment: number; t: number } | undefined {
    const near = this.#nearest(p, layer, margin, false);
    const inOutline = outlined && near !== undefined && near.d <= OUTLINE_REACH_M && this.#outlines.some(({ polygon, box }) => inside(box, p) && pointInPolygon(p, polygon));
    return near && ((near.d <= 0 && !near.past) || inOutline) ? { way: near.span.way, segment: near.segment, t: near.t } : undefined;
  }

  /** The bridge way's segment nearest a point, on a higher layer and (`decked`) with heights, and how far past its deck's edge (and margin) the point is */
  #nearest(p: Point, layer: number, margin: number, decked: boolean): { span: Span; segment: number; t: number; d: number; past: boolean } | undefined {
    let nearest: { span: Span; segment: number; t: number; d: number; past: boolean } | undefined;
    for (const index of this.#nearSpans({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] })) {
      const span = this.#spans[index];
      if (span.layer <= layer || (decked && span.deck.length === 0) || !inside(grow(span.box, OUTLINE_REACH_M), p)) {
        continue;
      }
      const last = span.line.length - 2;
      for (let i = 0; i <= last; i++) {
        const [a, b] = [span.line[i], span.line[i + 1]];
        const d = distanceToSegment(p, a, b) - span.half - margin;
        // past the deck's ends a point is in front of it, not under it
        const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / Math.max(1e-12, (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
        if (!nearest || d < nearest.d) {
          nearest = { span, segment: i, t: Math.min(Math.max(t, 0), 1), d, past: (i === 0 && t < 0) || (i === last && t > 1) };
        }
      }
    }
    return nearest;
  }

  /** Whether a point is under a bridge: within a bridge way's deck, or in an outline with a bridge way in it */
  under(p: Point): boolean {
    const [e, n] = p;
    return (
      this.#nearSpans({ minX: e, minY: n, maxX: e, maxY: n }).some((index) => {
        const { line, box, half } = this.#spans[index];
        return inside(grow(box, half), p) && line.some((a, i) => i + 1 < line.length && distanceToSegment(p, a, line[i + 1]) <= half);
      }) || this.#outlines.some(({ polygon, box, bridged }) => bridged && inside(box, p) && pointInPolygon(p, polygon))
    );
  }

  /** The lowest of the outlines' built deck pieces over a point, at its height there, and its outline */
  built(p: Point): DeckOver | undefined {
    const [e, n] = p;
    let lowest: DeckOver | undefined;
    for (const index of this.#nearPieces({ minX: e, minY: n, maxX: e, maxY: n })) {
      const { corners, heights, osm } = this.#pieces[index];
      const [[ax, ay], [bx, by], [cx, cy]] = corners;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) {
        continue;
      }
      // barycentric weights of b and c; inside where all three are at least 0
      const wb = ((e - ax) * (cy - ay) - (cx - ax) * (n - ay)) / area;
      const wc = ((bx - ax) * (n - ay) - (e - ax) * (by - ay)) / area;
      const wa = 1 - wb - wc;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) {
        continue;
      }
      const deck = wa * heights[0] + wb * heights[1] + wc * heights[2];
      if (!lowest || deck < lowest.deck) {
        lowest = { deck, osm };
      }
    }
    return lowest;
  }
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

function grow(box: Rect, by: number): Rect {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

function inside(box: Rect, [e, n]: Point): boolean {
  return e >= box.minX && e <= box.maxX && n >= box.minY && n <= box.maxY;
}

function around(boxes: Rect[]): Rect {
  return bounds(boxes.flatMap((r): Point[] => [[r.minX, r.minY], [r.maxX, r.maxY]]));
}
