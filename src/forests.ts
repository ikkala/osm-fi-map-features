// Trees for the map: register and OSM trees merged, and woods and scrub areas planted sparsely and
// deterministically (each plant's place and look come from its grid cell alone).
import { bounds, type Area, type MapFeatures, type Tree } from "./osm.ts";
import { distanceToRing, distanceToSegment, pointInPolygon, polygonTest, RectGrid, type Point, type Rect } from "./geometry.ts";

/** An OSM tree this close (m) to a register tree is the same tree */
const SAME_TREE_M = 4;

interface Planting {
  /** Meters between the cells of the planting grid; one plant per cell at most */
  spacing: number;
  /** Share of cells left empty, for glades and a less even look */
  empty: number;
  /** A plant of a cell whose random number r (0 .. 1) is below the next share and above the previous */
  mix: { share: number; kind: Tree["kind"]; genus?: string; minHeight: number; maxHeight: number }[];
}

const PLANTINGS: Record<NonNullable<Area["cover"]>, Planting> = {
  // Finnish woods: mostly spruce and pine, some birch
  trees: {
    spacing: 9,
    empty: 0.15,
    mix: [
      { share: 0.35, kind: "conifer", genus: "picea", minHeight: 12, maxHeight: 24 },
      { share: 0.7, kind: "conifer", genus: "pinus", minHeight: 14, maxHeight: 26 },
      { share: 1, kind: "broadleaved", genus: "betula", minHeight: 10, maxHeight: 20 },
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
        const plant = planting.mix.find((m) => r < m.share) ?? planting.mix[planting.mix.length - 1];
        const height = plant.minHeight + (plant.maxHeight - plant.minHeight) * cellRandom(i, j, 5);
        features.trees.push({ point, kind: plant.kind, height, ...(plant.genus && { genus: plant.genus }) });
        plants.add(point);
        planted++;
      }
    }
  }
  return planted;
}
