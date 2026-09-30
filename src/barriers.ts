// Fences, walls and hedges open where ways go through them. In OSM a path through a fence often has no
// gate or opening of its own, and the fence runs on over it; drawn so, it would close the path. So each
// barrier is cut open as wide as every way (not a tunnel or a bridge, which pass under or over) that
// crosses it, a little more, and as wide as each gate in it (a gate is drawn in the opening).
import { distanceToSegment, type Point } from "./geometry.ts";
import { bounds, crossing, type Barrier, type Gate, type MapFeatures } from "./osm.ts";

/** An opening is this much (m) wider than the way through it */
const OPENING_MARGIN_M = 0.4;
/** A gate this close (m) to a barrier's line is in it */
const IN_BARRIER_M = 1;
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
