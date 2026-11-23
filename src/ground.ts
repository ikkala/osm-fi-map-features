// The ground, one model of it for the whole build: the elevation model with layers laid over it in GROUND_LAYERS'
// order, each correcting what the model has wrong or adding what the map builds into the ground. A stage lays its
// layer once and asks for the ground as of the layer it needs, so that every stage after it sees the same ground,
// and the tiles' heights are the ground with all its layers.
import { bounds } from "./osm.ts";
import { distanceToSegment, indexBoxes, pushTo, simplifyLine, type Point } from "./geometry.ts";
import { REACH_M, type GroundStep } from "./retainingWalls.ts";
import { latticeProjection, tileName, type Heights, type Tile } from "./tiles.ts";

/** A point this near a step line (m) is on it: the tiles have the lines to decimeters */
const ON_LINE_M = 0.1;
/** A step line keeps the points it needs to stay within this (m) of its walls' stretches: straight along a straight wall */
const STEP_TOLERANCE_M = 0.05;
/** A tile's step lines are looked up in squares this big (m) */
const STEP_CELL_M = 8;

export type HeightAt = (e: number, n: number) => number | undefined;

/**
 * The layers, in the order they are laid: the elevation model; the ground levelled and corrected where it has changed
 * since the scanning; the bare ground under bridges, where the model has none (bareGround.ts); the steps at retaining
 * walls and flights of steps, which the model smooths (retainingWalls.ts, flights.ts); the ground raised over the
 * tunnels' ends to their portals (tunnels.ts); the steps at buildings' walls, where the model has a heap against them
 * (buildingSteps.ts); and the water's levelled surface (waterways.ts).
 */
export const GROUND_LAYERS = ["model", "levelled", "bare", "walls", "flights", "portals", "buildings", "water"] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];

export class Ground {
  /** The ground as of each layer laid, in order; a layer passed over is the one below it */
  readonly #at: HeightAt[];

  constructor(model: HeightAt) {
    this.#at = [model];
  }

  /** Lays a layer over the ground laid so far; the layers between, left out, are none */
  lay(layer: GroundLayer, over: (below: HeightAt) => HeightAt): void {
    const index = GROUND_LAYERS.indexOf(layer);
    if (index < this.#at.length) {
      throw new Error(`the ground's ${layer} layer laid after its ${GROUND_LAYERS[this.#at.length - 1]} layer`);
    }
    const below = this.top;
    while (this.#at.length < index) {
      this.#at.push(below);
    }
    this.#at.push(over(below));
  }

  /** The ground as of a layer: with it and those under it */
  at(layer: GroundLayer): HeightAt {
    const at = this.#at[GROUND_LAYERS.indexOf(layer)];
    if (!at) {
      throw new Error(`the ground's ${layer} layer is not laid yet`);
    }
    return at;
  }

  /** The ground with all the layers laid */
  get top(): HeightAt {
    return this.#at[this.#at.length - 1];
  }
}

/**
 * toTm over the map: within each square `size` a side on a grid from 0, 0 (a tile's), bilinearly interpolated from a
 * lattice about `spacing` apart (latticeProjection), made when first asked. Squares side by side share their edges'
 * points, so it is continuous across them.
 */
export function latticed(toTm: (e: number, n: number) => [number, number], size: number, spacing: number): (e: number, n: number) => [number, number] {
  const squares = new Map<string, (e: number, n: number) => [number, number]>();
  return (e, n) => {
    const x = Math.floor(e / size);
    const y = Math.floor(n / size);
    const key = `${x},${y}`;
    let at = squares.get(key);
    if (!at) {
      at = latticeProjection({ x, y }, size, spacing, toTm);
      squares.set(key, at);
    }
    return at(e, n);
  };
}

/**
 * The walls' stretches (retainingWalls.ts' and buildingSteps.ts' GroundStep) joined end to end along their wall into
 * lines, each turned to have on its left the side a point on it takes (tileGroundAt): the high side, `on` "high", as
 * at a retaining wall, on whose top what stands on its line stands; the low side, "low", as at a building's wall, the
 * outside. With `standing`, only the stretches whose middle is on one of those lines (a retaining wall's pieces left
 * once it is opened for the ways through it and left out on decks).
 */
export function stepLines(steps: readonly GroundStep[], on: "high" | "low", standing?: readonly Point[][]): Point[][] {
  const pieces = (standing ?? []).flatMap((line) => line.slice(1).map((b, i) => ({ a: line[i], b, box: bounds([line[i], b]) })));
  const near = pieces.length > 0 ? indexBoxes(pieces.map(({ box }) => box), bounds(pieces.flatMap(({ a, b }) => [a, b]))) : () => [];
  const stands = ({ a, b }: GroundStep) => {
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const box = { minX: mid[0] - ON_LINE_M, minY: mid[1] - ON_LINE_M, maxX: mid[0] + ON_LINE_M, maxY: mid[1] + ON_LINE_M };
    return near(box).some((i) => distanceToSegment(mid, pieces[i].a, pieces[i].b) <= ON_LINE_M);
  };
  const lines: { line: Point[]; low: number }[] = [];
  let last: GroundStep | undefined;
  for (const step of steps) {
    if (standing && !stands(step)) {
      last = undefined;
      continue;
    }
    const on = last && last.wall === step.wall && last.low === step.low && last.b[0] === step.a[0] && last.b[1] === step.a[1];
    if (on) {
      lines[lines.length - 1].line.push(step.b);
    } else {
      lines.push({ line: [step.a, step.b], low: step.low });
    }
    last = step;
  }
  // low 1 is on a stretch's left; the stretches of a straight wall one segment, so that no point falls between them
  return lines.map(({ line, low }) => simplifyLine((low === 1) === (on === "high") ? line.reverse() : line, STEP_TOLERANCE_M));
}

/**
 * Gives each tile (Tile.groundSteps) the pieces of the step lines within REACH_M of it, so that the ground beside its
 * edges, and under its buildings reaching past them, steps where theirs do
 */
export function cutGroundSteps(tiles: Map<string, Tile>, lines: readonly Point[][], size: number): void {
  for (const line of lines) {
    const pieces = new Map<Tile, Point[][]>();
    line.slice(1).forEach((b, i) => {
      const a = line[i];
      const box = bounds([a, b]);
      for (let y = Math.floor((box.minY - REACH_M) / size); y <= Math.floor((box.maxY + REACH_M) / size); y++) {
        for (let x = Math.floor((box.minX - REACH_M) / size); x <= Math.floor((box.maxX + REACH_M) / size); x++) {
          const tile = tiles.get(tileName({ x, y }));
          if (!tile) {
            continue;
          }
          const own = pieces.get(tile) ?? [];
          const piece = own[own.length - 1];
          if (piece && piece[piece.length - 1] === a) {
            piece.push(b);
          } else {
            own.push([a, b]);
          }
          pieces.set(tile, own);
        }
      }
    });
    for (const [tile, own] of pieces) {
      (tile.groundSteps ??= []).push(...own);
    }
  }
}

/**
 * A tile's ground as read from its heights and its step lines (Tile.groundSteps): the grid's bilinear height, but in
 * a cell of the grid a step line crosses, which the grid smooths the step into a slope over, within stepReach(step) of
 * the line the grid's height that far out on the point's side of it, square to the line (on the line, within
 * ON_LINE_M, its left side's). `e` and
 * `n` are meters from the grid's south-west point, which has `columns` by `rows` points (a square of `count` a side
 * by default). Programs reading the tiles read the ground by this rule, so that they agree on it.
 */
export function tileGroundAt(heights: Heights & { columns?: number; rows?: number }, steps: readonly Point[][] = []): (e: number, n: number) => number {
  const { step, values } = heights;
  const columns = heights.columns ?? heights.count;
  const rows = heights.rows ?? heights.count;
  const reach = stepReach(step);
  const cells = new Map<string, { a: Point; ue: number; un: number; length: number }[]>();
  for (const line of steps) {
    line.slice(1).forEach((b, i) => {
      const a = line[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length <= 1e-3) {
        return;
      }
      const segment = { a, ue: (b[0] - a[0]) / length, un: (b[1] - a[1]) / length, length };
      const box = bounds([a, b]);
      for (let x = Math.floor((box.minX - reach) / STEP_CELL_M); x <= Math.floor((box.maxX + reach) / STEP_CELL_M); x++) {
        for (let y = Math.floor((box.minY - reach) / STEP_CELL_M); y <= Math.floor((box.maxY + reach) / STEP_CELL_M); y++) {
          pushTo(cells, `${x},${y}`, segment);
        }
      }
    });
  }
  // whether a corner of the grid's cell around a point is on a segment's line, or on its other side than `left`
  const crossed = (e: number, n: number, { a, ue, un }: { a: Point; ue: number; un: number }, left: boolean) => {
    const c0 = Math.floor(Math.max(0, Math.min(columns - 2, e / step)));
    const r0 = Math.floor(Math.max(0, Math.min(rows - 2, n / step)));
    return [0, 1].some((dc) =>
      [0, 1].some((dr) => {
        const across = ((r0 + dr) * step - a[1]) * ue - ((c0 + dc) * step - a[0]) * un;
        return Math.abs(across) < ON_LINE_M || across < 0 === left;
      }),
    );
  };
  return (e, n) => {
    // the nearest step within reach
    let nearest = reach;
    let best: { a: Point; ue: number; un: number; t: number; left: boolean } | undefined;
    for (const { a, ue, un, length } of cells.get(`${Math.floor(e / STEP_CELL_M)},${Math.floor(n / STEP_CELL_M)}`) ?? []) {
      const t = (e - a[0]) * ue + (n - a[1]) * un;
      const across = (n - a[1]) * ue - (e - a[0]) * un;
      if (t >= 0 && t <= length && Math.abs(across) < nearest) {
        nearest = Math.abs(across);
        // a point on the line takes its left side's
        best = { a, ue, un, t, left: across > -ON_LINE_M };
      }
    }
    // the grid smooths the step only in the cells the line crosses: there the side's, as far out as the reach
    let [pe, pn] = [e, n];
    if (best && crossed(e, n, best, best.left)) {
      const out = best.left ? reach : -reach;
      [pe, pn] = [best.a[0] + best.ue * best.t - best.un * out, best.a[1] + best.un * best.t + best.ue * out];
    }
    const fc = Math.max(0, Math.min(columns - 1, pe / step));
    const fr = Math.max(0, Math.min(rows - 1, pn / step));
    const c0 = Math.min(Math.floor(fc), columns - 2);
    const r0 = Math.min(Math.floor(fr), rows - 2);
    const [tc, tr] = [fc - c0, fr - r0];
    const i = r0 * columns + c0;
    const south = values[i] + (values[i + 1] - values[i]) * tc;
    const north = values[i + columns] + (values[i + columns + 1] - values[i + columns]) * tc;
    return (south + (north - south) * tr) / 10;
  };
}

/** How far from a step line a tile's ground takes its side's height (tileGroundAt): a cell's diagonal, so that the cell there is all on that side */
export function stepReach(step: number): number {
  return step * Math.SQRT2;
}
