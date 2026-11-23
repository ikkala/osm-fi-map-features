// The bare ground under bridges. The elevation model has no ground under a deck, only the gap spanned from the ground
// around, which takes in the embankments and abutments at the bridge's ends: a hump under the deck, which a way
// passing under it would lie on, and which reaches a little past the deck's sides. Under a bridge the ground is
// spanned instead from the model's ground on either side, past the bridges beside it: along a way passing under the
// deck, on and beside it, whose cut or valley runs along it however it crosses; elsewhere (and beside a way running
// along under the bridge) across the bridge, square to its way. Where the model's is lower it stays. Over a tunnel
// passing under a bridge the bridge stands on the ground the tunnel goes through, an abutment: the ground stays up to
// where the tunnel's room, roof and cover need it, its floor at most as high as the highest of its network's portals
// (the tunnels' ways meeting it, where ways out of them meet). A tunnel deep under the gap needs none of it.
//
// Along or across: the gap's shape alone cannot tell which. Spanned along a way passing under at a slant, the span is
// the deck's width over the sine of the angle between them, so a rule from the span's length is one from the angle;
// what tells them apart is where the way's cut or valley runs, and that is along the way only where it crosses the
// bridge (CROSSING_RAD), not where it runs along under the deck.
import { grownRect, indexOwnBoxes, pointInPolygon, pointKey, type Point, type Rect } from "./geometry.ts";
import type { HeightAt } from "./ground.ts";
import { bounds, type BridgeOutline } from "./osm.ts";
import { inTunnel, isBridge } from "./profile.ts";
import { COVER_M, roomHeight } from "./tunnels.ts";
import { DECK_EDGE_M, isRoad, ROOF_M, ROOM_SIDE_M, widthOf, type Way } from "./ways.ts";

/** The model's span of a bridge's gap reaches this far (m) past the deck's sides */
export const GAP_EDGE_M = 2;
/** A way crosses under a bridge, its cut or valley along it, where it turns more than this off the bridge's way (rad) */
const CROSSING_RAD = Math.PI / 6;
/** Over a tunnel passing under a bridge the ground stays up this far (m) past the sides of the tunnel's room, its walls */
const WALLS_M = 2 * GAP_EDGE_M;
/** The ground beside a bridge is looked for this far out at most (m), at these steps */
const BESIDE_M = 60;
const LOOK_STEP_M = 0.5;

interface Span {
  a: Point;
  /** Unit vector along the segment, its length, and how far across it the gap reaches */
  ue: number;
  un: number;
  length: number;
  half: number;
  /** Its way's points between segments, where the gap reaches round the joint */
  joint: boolean;
  /** Where along it the gap is: short of a span's end, where the bridge lands on the ground */
  from: number;
  to: number;
}

/**
 * The ground under the bridges (ways with `bridge`, not boardwalks, which lie on the ground) and under their outlines
 * with a bridge way in them: spanned across from the ground on either side, `below` elsewhere
 */
export function bareUnderBridges(ways: readonly Way[], outlines: readonly BridgeOutline[], below: HeightAt): HeightAt {
  const spans: Span[] = [];
  const bridges = ways.filter((way) => isBridge(way) && !(isRoad(way) && way.boardwalk) && way.line.length >= 2);
  // a span's ends: its bridge ways' ends that meet no other bridge way's end
  const ends = new Map<string, number>();
  for (const way of bridges) {
    for (const p of [way.line[0], way.line[way.line.length - 1]]) {
      ends.set(pointKey(p), (ends.get(pointKey(p)) ?? 0) + 1);
    }
  }
  const spanEnd = (p: Point) => ends.get(pointKey(p)) === 1;
  for (const way of bridges) {
    const half = widthOf(way) / 2 + DECK_EDGE_M + GAP_EDGE_M;
    const last = way.line.length - 2;
    way.line.slice(1).forEach((b, i) => {
      const a = way.line[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const from = i === 0 && spanEnd(a) ? GAP_EDGE_M : 0;
      const to = i === last && spanEnd(b) ? length - GAP_EDGE_M : length;
      if (length > 1e-6 && from < to) {
        spans.push({ a, ue: (b[0] - a[0]) / length, un: (b[1] - a[1]) / length, length, half, joint: i > 0, from, to });
      }
    });
  }
  if (spans.length === 0) {
    return below;
  }
  // the ways that may pass under the decks, a segment each, as far out as the gap reaches past their sides; and the
  // tunnels, as far as their abutments reach
  const segments = (way: Way, half: number): Span[] =>
    way.line.slice(1).flatMap((b, i) => {
      const a = way.line[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return length > 1e-6 ? [{ a, ue: (b[0] - a[0]) / length, un: (b[1] - a[1]) / length, length, half, joint: false, from: 0, to: length }] : [];
    });
  const passing = ways.flatMap((way) => (isBridge(way) || inTunnel(way) ? [] : segments(way, widthOf(way) / 2 + GAP_EDGE_M)));
  const needs = tunnelTops(ways, below);
  const tunnels = ways.flatMap((way) => {
    const top = needs.get(way);
    return top === undefined ? [] : segments(way, widthOf(way) / 2 + ROOM_SIDE_M + WALLS_M).map((span) => ({ span, top }));
  });
  const boxOf = ({ a, ue, un, length, half }: Span): Rect => {
    return grownRect(bounds([a, [a[0] + ue * length, a[1] + un * length]]), half);
  };
  // an outline's gap goes across its bridge ways
  const decks = outlines
    .map((o) => ({ polygon: o.polygon, box: bounds(o.polygon.outer), spans: spans.filter(({ a }) => pointInPolygon(a, o.polygon)) }))
    .filter((deck) => deck.spans.length > 0);
  const boxes = [...spans.map(boxOf), ...decks.map(({ box }) => box)];
  const near = indexOwnBoxes(boxes);
  const nearPassing = indexOwnBoxes(passing.map(boxOf));
  const nearTunnels = indexOwnBoxes(tunnels.map(({ span }) => boxOf(span)));
  const within = (span: Span, p: Point) => {
    const { t, off } = across(span, p);
    return t >= 0 && t <= span.length && Math.abs(off) <= span.half;
  };
  const across = (span: Span, [e, n]: Point) => {
    const t = (e - span.a[0]) * span.ue + (n - span.a[1]) * span.un;
    return { t, off: (n - span.a[1]) * span.ue - (e - span.a[0]) * span.un };
  };
  const inSpan = (span: Span, p: Point) => {
    const { t, off } = across(span, p);
    return (t >= span.from && t <= span.to && Math.abs(off) <= span.half) || (span.joint && Math.hypot(p[0] - span.a[0], p[1] - span.a[1]) <= span.half);
  };
  const under = (p: Point) =>
    near({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }).some((i) =>
      i < spans.length ? inSpan(spans[i], p) : pointInPolygon(p, decks[i - spans.length].polygon),
    );
  return (e, n) => {
    const h = below(e, n);
    const p: Point = [e, n];
    if (h === undefined) {
      return h;
    }
    // the way of the nearest bridge over the point gives the gap's direction
    let nearest: Span | undefined;
    let distance = Infinity;
    let inside = false;
    const candidates = new Set<Span>();
    for (const i of near({ minX: e, minY: n, maxX: e, maxY: n })) {
      if (i < spans.length) {
        candidates.add(spans[i]);
        inside ||= inSpan(spans[i], p);
      } else if (pointInPolygon(p, decks[i - spans.length].polygon)) {
        inside = true;
        decks[i - spans.length].spans.forEach((span) => candidates.add(span));
      }
    }
    for (const span of candidates) {
      const { t, off } = across(span, p);
      const d = t >= 0 && t <= span.length ? Math.abs(off) : Math.hypot(e - span.a[0], n - span.a[1]);
      if (d < distance) {
        nearest = span;
        distance = d;
      }
    }
    if (!inside || !nearest) {
      return h;
    }
    // the ground a tunnel's room, roof and cover need over it stays
    const kept = Math.max(-Infinity, ...nearTunnels({ minX: e, minY: n, maxX: e, maxY: n }).flatMap((i) => (within(tunnels[i].span, p) ? [tunnels[i].top] : [])));
    const bare = (height: number) => Math.min(h, Math.max(height, kept));
    // along the nearest way passing under, where the point is on or beside it, else across the bridge
    let along: Span | undefined;
    let off = Infinity;
    for (const i of nearPassing({ minX: e, minY: n, maxX: e, maxY: n })) {
      const span = passing[i];
      const at = across(span, p);
      const crossing = Math.abs(span.ue * nearest.ue + span.un * nearest.un) < Math.cos(CROSSING_RAD);
      if (crossing && at.t >= 0 && at.t <= span.length && Math.abs(at.off) <= span.half && Math.abs(at.off) < off) {
        along = span;
        off = Math.abs(at.off);
      }
    }
    const [ue, un] = along ? [along.ue, along.un] : [-nearest.un, nearest.ue];
    const side = (sign: number) => {
      for (let d = LOOK_STEP_M; d <= BESIDE_M; d += LOOK_STEP_M) {
        const q: Point = [e + ue * sign * d, n + un * sign * d];
        if (!under(q)) {
          const height = below(...q);
          return height === undefined ? undefined : { d, height };
        }
      }
      return undefined;
    };
    const [left, right] = [side(1), side(-1)];
    if (!left || !right) {
      return h;
    }
    return bare(right.height + ((left.height - right.height) * right.d) / (left.d + right.d));
  };
}

/**
 * The top of the ground each tunnel's way needs over it: its network's highest portal (the model's ground where a way
 * not in a tunnel meets one), and its room, roof and cover over that; none for a network without a portal
 */
function tunnelTops(ways: readonly Way[], below: HeightAt): Map<Way, number> {
  const tunnels = ways.filter((w) => inTunnel(w) && !isBridge(w) && w.line.length >= 2);
  const open = new Set(ways.filter((w) => !inTunnel(w)).flatMap((w) => w.line.map(pointKey)));
  // the networks: tunnels' ways sharing a point
  const parent = tunnels.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const byPoint = new Map<string, number>();
  tunnels.forEach((way, i) => {
    for (const k of way.line.map(pointKey)) {
      const other = byPoint.get(k);
      if (other === undefined) {
        byPoint.set(k, i);
      } else {
        parent[root(i)] = root(other);
      }
    }
  });
  const portal = new Map<number, number>();
  tunnels.forEach((way, i) => {
    for (const p of way.line) {
      const h = open.has(pointKey(p)) ? below(...p) : undefined;
      if (h !== undefined) {
        portal.set(root(i), Math.max(portal.get(root(i)) ?? -Infinity, h));
      }
    }
  });
  const tops = new Map<Way, number>();
  tunnels.forEach((way, i) => {
    const floor = portal.get(root(i));
    if (floor !== undefined) {
      tops.set(way, floor + roomHeight(way) + ROOF_M + COVER_M);
    }
  });
  return tops;
}
