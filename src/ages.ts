// What a building's age tells: older buildings have taller storeys. A height counted from storeys at 3 m
// each comes out low for buildings from before the Second World War, e.g. the 19th-century ones with storeys
// of 3.5–4 m. The parts of a building without a year of their own get the year of the building they are in.
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
 * Gives parts without a year the year of the building they are in, and makes the storeys of old buildings
 * whose height is counted from storeys taller. Parts keep theirs: those higher up start at a building:min_level
 * also counted at LEVEL_HEIGHT_M, and the parts of a building must meet. Returns how many buildings got taller.
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
