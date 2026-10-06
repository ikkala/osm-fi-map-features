// Fences, walls and hedges are cut open where ways cross them at grade and at their gates: in OSM a fence
// often runs on over a path with no opening of its own.
import { distanceToSegment, type Point } from "./geometry.ts";
import { deckAt } from "./bridges.ts";
import { LID_EDGE_M } from "./cuts.ts";
import { bounds, crossing, type Barrier, type Gate, type MapFeatures } from "./osm.ts";

/** An opening is this much (m) wider than the way through it */
const OPENING_MARGIN_M = 0.4;
/** A gate this close (m) to a barrier's line is in it */
const IN_BARRIER_M = 1;
/** A barrier is on a deck or lid this far (m) out of its edge, which is at least this much over the ground (m) */
const ON_DECK_M = 1.5;
const OVER_GROUND_M = 1;
const DECK_EDGE_M = 0.5;
/** A barrier is looked at this often (m) */
const SAMPLE_M = 1;
/** Pieces of a barrier shorter than this (m) are left out */
const MIN_PIECE_M = 0.3;

/**
 * Cuts the barriers open where the roads and rails cross them and at their gates (features.gates, so after
 * streets.ts), replacing each with its pieces. Returns how many openings were cut.
 */
export function openBarriers(features: MapFeatures): number {
  const ways = [...features.roads.map((r) => ({ line: r.line, width: r.width, over: r.bridge || r.tunnel })), ...features.rails.map((r) => ({ line: r.line, width: RAIL_WIDTH_M, over: r.bridge || r.tunnel }))]
    .filter((w) => !w.over && w.line.length >= 2)
    .map((w) => ({ ...w, box: bounds(w.line) }));
  let openings = 0;
  const pieces: Barrier[] = [];
  for (const barrier of features.barriers) {
    const box = bounds(barrier.line);
    const lengths = cumulative(barrier.line);
    // [from, to] meters along the barrier
    const cuts: [number, number][] = [];
    for (const way of ways) {
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
/** Railway tracks are this wide (m) where they go through a fence */
const RAIL_WIDTH_M = 3;

/** Meters along the line to each of its points */
/**
 * Leaves out the stretches of barriers on bridges' decks and tunnels' lids (a railing along a bridge): a barrier
 * stands on the ground, which is under the deck there. Returns how many stretches were left out.
 */
export function leaveOutOnDecks(features: MapFeatures, heightAt: (e: number, n: number) => number | undefined): number {
  const decks = [...features.roads, ...features.rails]
    .flatMap((w) => {
      const half = ("width" in w ? w.width : RAIL_WIDTH_M) / 2;
      if (w.bridge && w.deck) {
        return [{ line: w.line, heights: w.deck, reach: half + DECK_EDGE_M + ON_DECK_M }];
      }
      return w.lid ? [{ line: w.line, heights: w.lid, reach: half + LID_EDGE_M + ON_DECK_M }] : [];
    })
    .filter((d) => d.line.length >= 2)
    .map((d) => ({ ...d, box: bounds(d.line) }));
  let count = 0;
  const pieces: Barrier[] = [];
  for (const barrier of features.barriers) {
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
      const ground = heightAt(...p);
      const on = near.some(({ line, heights, reach }) => {
        let close = false;
        for (let i = 0; i + 1 < line.length && !close; i++) {
          close = distanceToSegment(p, line[i], line[i + 1]) <= reach;
        }
        return close && ground !== undefined && deckAt(line, heights, p) - ground >= OVER_GROUND_M;
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
  }
  features.barriers = pieces;
  return count;
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
