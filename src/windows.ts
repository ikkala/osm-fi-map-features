// Guesses the windows of ordinary buildings. Neither OSM nor the building register has windows, so they
// are drawn in rows, one per storey, spaced by the kind of building. Buildings of other kinds (churches,
// sheds, factories, halls, ...) are too varied to guess and get none, and so do buildings tagged as
// something special (a building=yes with man_made=tower, ...) and slender ones.
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

/**
 * The building register's main uses and their windows. A public building is mostly a shop, a restaurant, a
 * school or a kindergarten. Work is offices and factories alike (see OFFICE_LEVELS).
 */
const BY_USE: Partial<Record<BuildingUse, WindowStyle>> = {
  house: "house",
  holiday: "house",
  apartments: "apartments",
  public: "office",
};

/**
 * A work building of this many storeys or more is taken for offices: in Tampere's own register (September
 * 2026), of the work buildings with 4 or more storeys 103 are offices and 32 factories, warehouses, parking
 * garages and others, while lower ones are mostly those (880 of the 952 with 1 to 3)
 */
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
 * Sets the windows of every building: by its kind, or for a building=yes by its use in the register, and a
 * building:part=yes gets those of the building it is in. Special buildings (towers, churches, ...: see
 * isSpecial) and every part in them get none, and nor do slender ones, glass walls and open shelters.
 * Returns how many buildings got windows.
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
