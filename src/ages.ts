// Older buildings have taller storeys, so a height counted from storeys is raised for them.
import { pointInPolygon, ringCentroid } from "./geometry.ts";
import { bounds, LEVEL_HEIGHT_M, type Building } from "./osm.ts";

/** Storey heights (m) of buildings built before these years; later ones have LEVEL_HEIGHT_M */
const OLD_STOREYS: { before: number; storey: number }[] = [
  { before: 1920, storey: 3.6 },
  { before: 1946, storey: 3.2 },
];

/** The height of a storey in a building built in a year */
export function storeyHeight(year: number | undefined): number {
  return OLD_STOREYS.find(({ before }) => year !== undefined && year < before)?.storey ?? LEVEL_HEIGHT_M;
}

/**
 * Gives parts without a year their building's year, and makes storeys of old buildings whose height is counted
 * from storeys taller. Parts keep their height so that the parts of a building still meet. Returns how many got taller.
 */
export function applyAges(buildings: Building[]): number {
  const outlines = buildings.filter((b) => b.hasParts && b.year !== undefined).map((b) => ({ b, box: bounds(b.polygon.outer) }));
  let taller = 0;
  for (const b of buildings) {
    if (b.part && b.year === undefined) {
      const [x, y] = ringCentroid(b.polygon.outer);
      const around = outlines.find(({ b: o, box }) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && pointInPolygon([x, y], o.polygon));
      if (around) {
        b.year = around.b.year;
      }
    }
    const storey = storeyHeight(b.year);
    if (b.heightFromLevels && !b.part && !b.hasParts && storey !== LEVEL_HEIGHT_M) {
      const roof = b.roofHeight ?? 0;
      b.height = roof + ((b.height - roof) * storey) / LEVEL_HEIGHT_M;
      delete b.heightFromLevels;
      taller++;
    }
  }
  return taller;
}
