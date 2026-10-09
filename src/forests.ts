// Trees for the map: register and OSM trees merged, and woods and scrub areas planted sparsely and
// deterministically (each plant's place comes from its grid cell alone, and what it is from the cell and the
// area's leaf type).
import { bounds, type Area, type MapFeatures, type Rail, type Road, type Tree } from "./osm.ts";
import { distanceToRing, distanceToSegment, pointInPolygon, polygonTest, RectGrid, type Point, type Rect } from "./geometry.ts";

/** An OSM tree this close (m) to a register tree is the same tree */
const SAME_TREE_M = 4;

interface Plant {
  kind: Tree["kind"];
  genus?: string;
  minHeight: number;
  maxHeight: number;
}

/** A plant of a cell whose random number r (0 .. 1) is below its share and above the previous one's */
type Mix = (Plant & { share: number })[];

interface Planting {
  /** Meters between the cells of the planting grid; one plant per cell at most */
  spacing: number;
  /** Share of cells left empty, for glades and a less even look */
  empty: number;
  mix: Mix;
}

const SPRUCE: Plant = { kind: "conifer", genus: "picea", minHeight: 12, maxHeight: 24 };
const PINE: Plant = { kind: "conifer", genus: "pinus", minHeight: 14, maxHeight: 26 };
const BIRCH: Plant = { kind: "broadleaved", genus: "betula", minHeight: 10, maxHeight: 20 };

const PLANTINGS: Record<NonNullable<Area["cover"]>, Planting> = {
  // Finnish woods: mostly spruce and pine, some birch
  trees: {
    spacing: 9,
    empty: 0.15,
    mix: [
      { share: 0.35, ...SPRUCE },
      { share: 0.7, ...PINE },
      { share: 1, ...BIRCH },
    ],
  },
  shrubs: {
    spacing: 5,
    empty: 0.3,
    mix: [
      { share: 0.8, kind: "shrub", minHeight: 1, maxHeight: 3 },
      { share: 1, kind: "broadleaved", genus: "betula", minHeight: 3, maxHeight: 8 },
    ],
  },
};

/** The mix of woods of one leaf type, in place of the mixed woods' */
const WOODS_MIXES: Record<NonNullable<Area["leafType"]>, Mix> = {
  needleleaved: [
    { share: 0.5, ...SPRUCE },
    { share: 1, ...PINE },
  ],
  // mostly birch, the rest aspen, alder, rowan and the like
  broadleaved: [
    { share: 0.75, ...BIRCH },
    { share: 1, kind: "broadleaved", minHeight: 8, maxHeight: 18 },
  ],
};

/** Plants keep this far (m) from other plants, and from the edges of roads and rails */
const PLANT_GAP_M = 2.5;
const ROAD_CLEARANCE_M = 1.5;
const BUILDING_CLEARANCE_M = 2;
const RAIL_WIDTH_M = 3;
/** Areas where nothing is planted even inside woods */
const BARE_AREAS = new Set<Area["kind"]>(["water", "paved", "pitch"]);

/** Points in square cells, to find the ones near a point quickly */
class PointGrid {
  readonly #cell: number;
  readonly #cells = new Map<string, Point[]>();

  constructor(cell: number) {
    this.#cell = cell;
  }

  add(point: Point): void {
    const key = `${Math.floor(point[0] / this.#cell)},${Math.floor(point[1] / this.#cell)}`;
    const list = this.#cells.get(key);
    if (list) {
      list.push(point);
    } else {
      this.#cells.set(key, [point]);
    }
  }

  /** Whether a point lies within distance of the point */
  near(point: Point, distance: number): boolean {
    const [x, y] = point;
    for (let i = Math.floor((x - distance) / this.#cell); i <= Math.floor((x + distance) / this.#cell); i++) {
      for (let j = Math.floor((y - distance) / this.#cell); j <= Math.floor((y + distance) / this.#cell); j++) {
        for (const p of this.#cells.get(`${i},${j}`) ?? []) {
          if (Math.hypot(p[0] - x, p[1] - y) < distance) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

/** The register's trees, and OSM's trees except those at a register tree */
export function mergeTrees(register: Tree[], osm: Tree[]): Tree[] {
  const grid = new PointGrid(SAME_TREE_M);
  for (const tree of register) {
    grid.add(tree.point);
  }
  return [...register, ...osm.filter((tree) => !grid.near(tree.point, SAME_TREE_M))];
}

/** A tree on a way is moved this far (m) beyond the way's edge */
const OFF_WAY_M = 0.5;
/** A tree this close (m) beyond a way's edge stands on it too: its trunk reaches over the edge */
const TRUNK_M = 0.3;

/**
 * The trees, those standing on a way (within its width, or a trunk's half beyond its edge; not on a bridge or over a
 * tunnel) moved off it to beside its edge: OSM draws a path as a line, which may pass a tree that the path really
 * goes round. A tree with no room beside the way, on another way there too, is left out.
 */
export function moveTreesOffWays(trees: Tree[], roads: Road[], rails: Rail[]): Tree[] {
  const lines = [
    ...roads.filter((r) => !r.tunnel && !r.bridge).map((r) => ({ line: r.line, half: r.width / 2 })),
    ...rails.filter((r) => !r.tunnel && !r.bridge).map((r) => ({ line: r.line, half: RAIL_WIDTH_M / 2 })),
  ];
  if (trees.length === 0 || lines.length === 0) {
    return trees;
  }
  const over = bounds(trees.map((t) => t.point));
  const reach = 20;
  const grid = new RectGrid<{ a: Point; b: Point; half: number }>(25, { minX: over.minX - reach, minY: over.minY - reach, maxX: over.maxX + reach, maxY: over.maxY + reach });
  for (const { line, half } of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [a, b] = [line[i], line[i + 1]];
      const r = half + TRUNK_M;
      grid.add({ minX: Math.min(a[0], b[0]) - r, minY: Math.min(a[1], b[1]) - r, maxX: Math.max(a[0], b[0]) + r, maxY: Math.max(a[1], b[1]) + r }, { a, b, half });
    }
  }
  // the segment the point is on (within its half width), the nearest such
  const on = (p: Point) => {
    let best: { a: Point; b: Point; half: number; d: number } | undefined;
    for (const s of grid.at(p)) {
      const d = distanceToSegment(p, s.a, s.b);
      if (d < s.half + TRUNK_M && (!best || d - s.half < best.d - best.half)) {
        best = { ...s, d };
      }
    }
    return best;
  };
  const kept: Tree[] = [];
  for (const tree of trees) {
    const s = tree.base === undefined ? on(tree.point) : undefined;
    if (!s) {
      kept.push(tree);
      continue;
    }
    const [dx, dy] = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(Math.max(((tree.point[0] - s.a[0]) * dx + (tree.point[1] - s.a[1]) * dy) / (length * length), 0), 1);
    const foot: Point = [s.a[0] + dx * t, s.a[1] + dy * t];
    // away from the line, on the side the tree is on (left of it when on it)
    let [nx, ny] = [tree.point[0] - foot[0], tree.point[1] - foot[1]];
    const off = Math.hypot(nx, ny);
    [nx, ny] = off > 1e-6 ? [nx / off, ny / off] : [-dy / length, dx / length];
    const moved: Point = [foot[0] + nx * (s.half + OFF_WAY_M), foot[1] + ny * (s.half + OFF_WAY_M)];
    if (!on(moved)) {
      kept.push({ ...tree, point: moved });
    }
  }
  return kept;
}

/** A random number 0 .. 1 from a grid cell and a salt, the same on every run */
export function cellRandom(i: number, j: number, salt: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Plants woods and scrub inside `within` into features.trees, clear of buildings, roads, rails, water and
 * existing trees. Returns how many were planted.
 */
export function plantForests(features: MapFeatures, within: Rect): number {
  const plants = new PointGrid(10);
  for (const tree of features.trees) {
    plants.add(tree.point);
  }
  // a plant lands anywhere in its cell, so up to a cell outside `within`
  const widestCell = Math.max(...Object.values(PLANTINGS).map((planting) => planting.spacing));
  const blockers = new RectGrid<(p: Point) => boolean>(25, {
    minX: within.minX - widestCell,
    minY: within.minY - widestCell,
    maxX: within.maxX + widestCell,
    maxY: within.maxY + widestCell,
  });
  for (const building of features.buildings) {
    const { outer } = building.polygon;
    const box = bounds(outer);
    const rect = { minX: box.minX - BUILDING_CLEARANCE_M, minY: box.minY - BUILDING_CLEARANCE_M, maxX: box.maxX + BUILDING_CLEARANCE_M, maxY: box.maxY + BUILDING_CLEARANCE_M };
    blockers.add(rect, (p) => pointInPolygon(p, building.polygon) || distanceToRing(p, outer) < BUILDING_CLEARANCE_M);
  }
  for (const area of features.areas) {
    if (BARE_AREAS.has(area.kind)) {
      blockers.add(bounds(area.polygon.outer), polygonTest(area.polygon));
    }
  }
  const lines = [
    ...features.roads.filter((road) => !road.tunnel).map((road) => ({ line: road.line, clearance: road.width / 2 + ROAD_CLEARANCE_M })),
    ...features.rails.filter((rail) => !rail.tunnel).map((rail) => ({ line: rail.line, clearance: RAIL_WIDTH_M / 2 + ROAD_CLEARANCE_M })),
  ];
  for (const { line, clearance } of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const box = bounds([a, b]);
      const rect = { minX: box.minX - clearance, minY: box.minY - clearance, maxX: box.maxX + clearance, maxY: box.maxY + clearance };
      blockers.add(rect, (p) => distanceToSegment(p, a, b) < clearance);
    }
  }

  let planted = 0;
  // woods first, so scrub inside woods does not crowd out the trees
  const covered = features.areas.filter((area) => area.cover !== undefined);
  covered.sort((a, b) => (a.cover === b.cover ? 0 : a.cover === "trees" ? -1 : 1));
  for (const area of covered) {
    const planting = PLANTINGS[area.cover ?? "trees"];
    const { spacing } = planting;
    const mix = area.leafType ? WOODS_MIXES[area.leafType] : planting.mix;
    const inArea = polygonTest(area.polygon);
    // woods reach far outside the map
    const box = bounds(area.polygon.outer);
    const minX = Math.max(box.minX, within.minX);
    const minY = Math.max(box.minY, within.minY);
    const maxX = Math.min(box.maxX, within.maxX);
    const maxY = Math.min(box.maxY, within.maxY);
    for (let i = Math.floor(minX / spacing); i <= Math.floor(maxX / spacing); i++) {
      for (let j = Math.floor(minY / spacing); j <= Math.floor(maxY / spacing); j++) {
        if (cellRandom(i, j, 1) < planting.empty) {
          continue;
        }
        // somewhere in the cell, not too close to the neighbouring cells' plants
        const point: Point = [(i + 0.15 + 0.7 * cellRandom(i, j, 2)) * spacing, (j + 0.15 + 0.7 * cellRandom(i, j, 3)) * spacing];
        if (
          !inArea(point) ||
          plants.near(point, PLANT_GAP_M) ||
          blockers.at(point).some((blocks) => blocks(point))
        ) {
          continue;
        }
        const r = cellRandom(i, j, 4);
        const plant = mix.find((m) => r < m.share) ?? mix[mix.length - 1];
        const height = plant.minHeight + (plant.maxHeight - plant.minHeight) * cellRandom(i, j, 5);
        features.trees.push({ point, kind: plant.kind, height, ...(plant.genus && { genus: plant.genus }) });
        plants.add(point);
        planted++;
      }
    }
  }
  return planted;
}
