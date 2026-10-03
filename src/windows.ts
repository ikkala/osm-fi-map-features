// Guesses window rows (one per storey) for ordinary buildings by their kind; other kinds are too varied to
// guess and get none.
import { orientedBox, pointInPolygon, ringCentroid } from "./geometry.ts";
import { bounds, type Building, type BuildingUse, type WindowStyle } from "./osm.ts";

/** building=* values and their windows */
const BY_KIND: Record<string, WindowStyle> = {
  apartments: "apartments",
  residential: "apartments",
  dormitory: "apartments",
  hotel: "apartments",
  house: "house",
  detached: "house",
  semidetached_house: "house",
  terrace: "house",
  bungalow: "house",
  allotment_house: "house",
  cabin: "house",
  office: "office",
  commercial: "office",
  retail: "office",
  mixed_use: "office",
  school: "office",
  college: "office",
  university: "office",
  kindergarten: "office",
};

/** The building register's main uses and their windows; work is offices and factories alike (see OFFICE_LEVELS) */
const BY_USE: Partial<Record<BuildingUse, WindowStyle>> = {
  house: "house",
  holiday: "house",
  apartments: "apartments",
  public: "office",
};

/** A work building of this many storeys or more is taken for offices; lower ones are mostly factories and warehouses */
const OFFICE_LEVELS = 4;

function byUse(b: Building): WindowStyle | undefined {
  if (b.use === "work") {
    return (b.levels ?? 0) >= OFFICE_LEVELS ? "office" : undefined;
  }
  return b.use === undefined ? undefined : BY_USE[b.use];
}

/** Kinds that say nothing of what a building is: its use in the register, or the outline around a part, decides */
const GENERIC_KINDS = new Set(["yes", "building"]);

/** A building (or part) this many times taller than its longest side is a tower, a chimney or a mast: no windows */
const SLENDER = 5;

/**
 * Sets the windows of every building by its kind, or for a building=yes by its register use; a generic part
 * takes after its building. Special, slender, glass and open buildings get none. Returns how many got windows.
 */
export function assignWindows(buildings: Building[]): number {
  // a whole building so slender is a tower; the parts of a building (bays, stairwells) may well be slender
  const tower = (b: Building) => b.special === true || b.height - b.minHeight > SLENDER * orientedBox(b.polygon.outer).length;
  const unusual = (b: Building) => b.special === true || b.shelter !== undefined || b.material === "glass";
  const own = (b: Building): WindowStyle | undefined =>
    GENERIC_KINDS.has(b.kind) ? byUse(b) : BY_KIND[b.kind];
  const outlines = buildings
    .filter((b) => b.hasParts)
    .map((b) => ({ polygon: b.polygon, box: bounds(b.polygon.outer), tower: tower(b), windows: unusual(b) ? undefined : own(b) }));
  const around = (part: Building) => {
    const [x, y] = ringCentroid(part.polygon.outer);
    return outlines.find(({ box, polygon }) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && pointInPolygon([x, y], polygon));
  };
  let count = 0;
  for (const b of buildings) {
    const outline = b.part ? around(b) : undefined;
    let windows: WindowStyle | undefined;
    if (!b.hasParts && !unusual(b) && !(outline ? outline.tower : tower(b))) {
      // a part that says nothing of itself takes after its building
      windows = b.part && GENERIC_KINDS.has(b.kind) && b.use === undefined ? outline?.windows : own(b);
    }
    if (windows !== undefined) {
      b.windows = windows;
      count++;
    } else {
      delete b.windows;
    }
  }
  return count;
}
