// Older buildings have taller storeys, so a height counted from storeys is raised for them.
import { LEVEL_HEIGHT_M, type Building } from "./osm.ts";

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
 * Makes storeys of old buildings whose height is counted from storeys taller. Parts keep their height so that
 * the parts of a building still meet. Returns how many got taller.
 */
export function applyAges(buildings: Building[]): number {
  let taller = 0;
  for (const b of buildings) {
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
