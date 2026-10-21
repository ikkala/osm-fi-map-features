// Fences, walls and hedges are cut open where ways cross them at grade and at their gates: in OSM a fence
// often runs on over a path with no opening of its own. A wall is cut open at a tunnel's portal in it too. A parapet
// stands on a bridge's deck, over the ways passing under it, and so does a railing on a layer over the ground: they
// open at their gates alone.
import { distanceToSegment, pointKey, type Point } from "./geometry.ts";
import { deckAt } from "./bridges.ts";
import { LID_EDGE_M } from "./cuts.ts";
import { bounds, crossing, type Barrier, type Gate, type MapFeatures } from "./osm.ts";
import { ROOM_SIDE_M } from "./tunnels.ts";

/** An opening is this much (m) wider than the way through it */
const OPENING_MARGIN_M = 0.4;
/** A gate this close (m) to a barrier's line is in it */
const IN_BARRIER_M = 1;
/** A barrier is on a deck or lid this far (m) out of its edge, which is at least this much over the ground (m) */
const ON_DECK_M = 1.5;
const OVER_GROUND_M = 1;
const DECK_EDGE_M = 0.5;
/** A barrier crossing a bridge's way at this sine or more passes under it, at less runs along it */
const CROSSING_SINE = 0.5;
/** A barrier passing under a deck that is less than this (m) over its top is left out there */
const UNDER_DECK_M = 0.5;
/** A barrier is looked at this often (m) */
const SAMPLE_M = 1;
/** A barrier crossing a tunnel's line this near its end (m), in or out of it, is the wall its portal is in */
const PORTAL_M = 3;
/** Pieces of a barrier shorter than this (m) are left out */
const MIN_PIECE_M = 0.3;

/**
 * Cuts the barriers open where the roads and rails cross them and at their gates (features.gates, so after
 * streets.ts), replacing each with its pieces; a parapet only at its gates. Returns how many openings were cut.
 */
export function openBarriers(features: MapFeatures): number {
  const ways = [
    ...[...features.roads.map((r) => ({ line: r.line, width: r.width, over: r.bridge || r.tunnel })), ...features.rails.map((r) => ({ line: r.line, width: RAIL_WIDTH_M, over: r.bridge || r.tunnel }))]
      .filter((w) => !w.over && w.line.length >= 2),
    ...portals(features),
  ].map((w) => ({ ...w, box: bounds(w.line) }));
  let openings = 0;
  const pieces: Barrier[] = [];
  for (const barrier of features.barriers) {
    const box = bounds(barrier.line);
    const lengths = cumulative(barrier.line);
    // [from, to] meters along the barrier
    const cuts: [number, number][] = [];
    for (const way of barrier.parapet || bridgeRailing(barrier) ? [] : ways) {
      if (way.box.maxX < box.minX || way.box.minX > box.maxX || way.box.maxY < box.minY || way.box.minY > box.maxY) {
        continue;
      }
      for (let i = 0; i + 1 < barrier.line.length; i++) {
        for (let j = 0; j + 1 < way.line.length; j++) {
          const hit = crossing(barrier.line[i], barrier.line[i + 1], way.line[j], way.line[j + 1], way.width + OPENING_MARGIN_M);
          if (hit) {
            const at = lengths[i] + hit.at * (lengths[i + 1] - lengths[i]);
            cuts.push([at - hit.half, at + hit.half]);
          }
        }
      }
    }
    for (const gate of features.gates) {
      const at = alongIfNear(barrier.line, lengths, gate);
      if (at !== undefined) {
        cuts.push([at - gate.width / 2, at + gate.width / 2]);
      }
    }
    openings += cuts.length;
    for (const line of cutOut(barrier.line, lengths, cuts)) {
      pieces.push({ ...barrier, line });
    }
  }
  features.barriers = pieces;
  return openings;
}
/** The tunnels' lines from PORTAL_M out of their ends that no other tunnel goes on from to PORTAL_M in, as wide as their rooms */
function portals(features: MapFeatures): { line: Point[]; width: number }[] {
  const tunnels = [...features.roads, ...features.rails].filter((w) => w.tunnel && !w.lid && w.line.length >= 2);
  const points = new Map<string, number>();
  for (const way of tunnels) {
    for (const p of new Set(way.line.map(pointKey))) {
      points.set(p, (points.get(p) ?? 0) + 1);
    }
  }
  const result: { line: Point[]; width: number }[] = [];
  for (const way of tunnels) {
    const width = ("width" in way ? way.width : RAIL_WIDTH_M) + ROOM_SIDE_M * 2;
    for (const line of [way.line, [...way.line].reverse()]) {
      const lengths = cumulative(line);
      const [end, next] = [line[0], line[1]];
      const length = Math.hypot(next[0] - end[0], next[1] - end[1]);
      if ((points.get(pointKey(end)) ?? 0) < 2 && length > 0) {
        const out: Point = [end[0] - ((next[0] - end[0]) / length) * PORTAL_M, end[1] - ((next[1] - end[1]) / length) * PORTAL_M];
        result.push({ line: [out, ...between(line, lengths, 0, Math.min(PORTAL_M, lengths[lengths.length - 1]))], width });
      }
    }
  }
  return result;
}

/** A railing on a layer over the ground: along a bridge, on its deck however little over the ground it is */
function bridgeRailing(barrier: Barrier): boolean {
  return barrier.kind === "fence" && barrier.material === "railing" && (barrier.layer ?? 0) > 0;
}

/** Railway tracks are this wide (m) where they go through a fence */
const RAIL_WIDTH_M = 3;

/** Meters along the line to each of its points */
/**
 * Leaves out the stretches of barriers on bridges' decks and tunnels' lids (a railing along a bridge): a barrier
 * stands on the ground, which is under the deck there. One crossing a bridge's way passes under it, left out only
 * where the deck is too low for it, as where the bridge lands. A retaining wall stays under a bridge: it holds up
 * the ground there. A parapet stays too: it stands on the deck. A railing's stretches on a deck stay as onDeck,
 * not on the ground, the look of the bridge's railing there. Returns how many stretches were left out.
 */
export function leaveOutOnDecks(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): number {
  // across: how far out of a bridge's way's line its deck is (m), none for a lid
  const decks = [...features.roads, ...features.rails]
    .flatMap((w): { line: Point[]; heights: number[]; reach: number; across?: number }[] => {
      const half = ("width" in w ? w.width : RAIL_WIDTH_M) / 2;
      if (w.bridge && w.deck) {
        return [{ line: w.line, heights: w.deck, reach: half + DECK_EDGE_M + ON_DECK_M, across: half + DECK_EDGE_M }];
      }
      return w.lid ? [{ line: w.line, heights: w.lid, reach: half + LID_EDGE_M + ON_DECK_M }] : [];
    })
    .filter((d) => d.line.length >= 2)
    .map((d) => ({ ...d, box: bounds(d.line) }));
  let count = 0;
  const pieces: Barrier[] = [];
  for (const barrier of features.barriers) {
    if (barrier.parapet) {
      pieces.push(barrier);
      continue;
    }
    const box = bounds(barrier.line);
    const near = decks.filter((d) => d.box.maxX + d.reach >= box.minX && d.box.minX - d.reach <= box.maxX && d.box.maxY + d.reach >= box.minY && d.box.minY - d.reach <= box.maxY);
    if (near.length === 0) {
      pieces.push(barrier);
      continue;
    }
    const lengths = cumulative(barrier.line);
    const total = lengths[lengths.length - 1];
    const cuts: [number, number][] = [];
    for (let d = 0; d <= total; d += SAMPLE_M) {
      const [p] = between(barrier.line, lengths, d, d);
      // the barrier's way there
      const [from] = between(barrier.line, lengths, Math.max(0, d - SAMPLE_M / 2), Math.max(0, d - SAMPLE_M / 2));
      const [to] = between(barrier.line, lengths, Math.min(total, d + SAMPLE_M / 2), Math.min(total, d + SAMPLE_M / 2));
      const ground = heightAt(...p);
      const on = near.some(({ line, heights, reach, across }) => {
        let distance = Infinity;
        let nearest = 0;
        for (let i = 0; i + 1 < line.length; i++) {
          const away = distanceToSegment(p, line[i], line[i + 1]);
          if (away < distance) {
            distance = away;
            nearest = i;
          }
        }
        const high = ground !== undefined && (deckAt(line, heights, p) - ground >= OVER_GROUND_M || bridgeRailing(barrier));
        if (across === undefined) {
          return distance <= reach && high;
        }
        if (barrier.kind === "retaining_wall") {
          return false;
        }
        if (sine(from, to, line[nearest], line[nearest + 1]) >= CROSSING_SINE) {
          // across the bridge's way it passes under the deck, unless the deck is too low for it
          return distance <= across && ground !== undefined && deckAt(line, heights, p) - ground < barrier.height + UNDER_DECK_M;
        }
        return distance <= reach && high;
      });
      if (on) {
        const last = cuts[cuts.length - 1];
        if (last && d - SAMPLE_M <= last[1]) {
          last[1] = Math.min(total, d + SAMPLE_M / 2);
        } else {
          cuts.push([Math.max(0, d - SAMPLE_M / 2), Math.min(total, d + SAMPLE_M / 2)]);
        }
      }
    }
    if (cuts.length === 0) {
      pieces.push(barrier);
      continue;
    }
    count += cuts.length;
    for (const line of cutOut(barrier.line, lengths, cuts)) {
      pieces.push({ ...barrier, line });
    }
    if (barrier.kind === "fence" && barrier.material === "railing") {
      for (const [from, to] of cuts) {
        const line = between(barrier.line, lengths, from, to);
        if (line.length >= 2) {
          pieces.push({ ...barrier, line, onDeck: true });
        }
      }
    }
  }
  features.barriers = pieces;
  return count;
}

/** The sine of the angle between a to b and c to d, 0 where either has no length */
function sine(a: Point, b: Point, c: Point, d: Point): number {
  const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]];
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return lengths > 0 ? Math.abs(ux * vy - uy * vx) / lengths : 0;
}

function cumulative(line: Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < line.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  }
  return lengths;
}

/** Meters along the line to the gate's point, when the gate is in the line */
function alongIfNear(line: Point[], lengths: number[], gate: Gate): number | undefined {
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    if (distanceToSegment(gate.point, a, b) <= IN_BARRIER_M) {
      const length = lengths[i + 1] - lengths[i];
      const t = length > 0 ? ((gate.point[0] - a[0]) * (b[0] - a[0]) + (gate.point[1] - a[1]) * (b[1] - a[1])) / (length * length) : 0;
      return lengths[i] + Math.max(0, Math.min(1, t)) * length;
    }
  }
  return undefined;
}

/** The pieces of the line left between the cuts (meters along it), at least MIN_PIECE_M long */
export function cutOut(line: Point[], lengths: number[], cuts: [number, number][]): Point[][] {
  const total = lengths[lengths.length - 1];
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const kept: [number, number][] = [];
  let from = 0;
  for (const [a, b] of sorted) {
    if (a > from) {
      kept.push([from, Math.min(a, total)]);
    }
    from = Math.max(from, b);
  }
  if (from < total) {
    kept.push([from, total]);
  }
  return kept.filter(([a, b]) => b - a >= MIN_PIECE_M).map(([a, b]) => between(line, lengths, a, b));
}

/** The part of the line from a to b meters along it */
function between(line: Point[], lengths: number[], a: number, b: number): Point[] {
  const at = (d: number): Point => {
    let i = 0;
    while (i + 2 < lengths.length && lengths[i + 1] < d) {
      i++;
    }
    const span = lengths[i + 1] - lengths[i];
    const t = span > 0 ? (d - lengths[i]) / span : 0;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  };
  const inside = line.filter((_, i) => lengths[i] > a && lengths[i] < b);
  return [at(a), ...inside, at(b)];
}
