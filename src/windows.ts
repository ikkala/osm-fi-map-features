// Guesses window rows (one per storey) for ordinary buildings by their kind; other kinds are too varied to
// guess and get none, and neither do walls tagged without windows.
import { FINNISH_DEFAULTS_MEASURED_IN_TAMPERE } from "./measuredDefaults.ts";
import { orientedBox, pointInPolygon, ringArea, ringCentroid } from "./geometry.ts";
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
  farm: "house",
  office: "office",
  commercial: "office",
  retail: "office",
  mixed_use: "office",
  school: "office",
  college: "office",
  university: "office",
  kindergarten: "office",
  // public and civic buildings, hospitals and stations of the emergency services: storeys of offices and wards
  public: "office",
  civic: "office",
  government: "office",
  townhall: "office",
  hospital: "office",
  clinic: "office",
  fire_station: "office",
  police: "office",
};

/** The building register's main uses and their windows; work is offices and factories alike (see byUse) */
const BY_USE: Partial<Record<BuildingUse, WindowStyle>> = {
  house: "house",
  holiday: "house",
  apartments: "apartments",
  public: "office",
};

/** The register's uses of homes: a place of worship that is one (a parish's flats with its hall) is windowed as one */
const HOMES: ReadonlySet<BuildingUse | undefined> = new Set(["house", "holiday", "apartments"]);

/** A low work building of wood larger than this (m²) is a hall (a warehouse, a shop on glued beams), not a house */
const MAX_WOODEN_HOUSE_M2 = 500;

function byUse(b: Building): WindowStyle | undefined {
  if (b.use === "work") {
    if ((b.levels ?? 0) >= FINNISH_DEFAULTS_MEASURED_IN_TAMPERE.officeLevels) {
      return "office";
    }
    return woodenHouse(b) ? "house" : undefined;
  }
  return b.use === undefined ? undefined : BY_USE[b.use];
}

/**
 * Walls of wood (the facade's, else the frame's) around a house's floor: a low work building so is a house put to
 * work rather than a factory, few of which are of wood
 */
function woodenHouse(b: Building): boolean {
  const wooden = b.material === undefined ? b.frameMaterial === "wood" : b.material === "wood";
  return wooden && Math.abs(ringArea(b.polygon.outer)) <= MAX_WOODEN_HOUSE_M2;
}

/** Kinds that say nothing of what a building is: its use in the register, or the outline around a part, decides */
const GENERIC_KINDS = new Set(["yes", "building"]);

/** A building (or part) this many times taller than its longest side is a tower, a chimney or a mast: no windows */
const SLENDER = 5;

/**
 * Sets the windows of every building by its kind, or for a building=yes by its register use; a generic part
 * takes after its building. Special (unless a place of worship the register has as homes), windowless, slender, glass
 * and open buildings get none.
 * Returns how many got windows.
 */
export function assignWindows(buildings: Building[]): number {
  const special = (b: Building) => b.special === true && !(b.worship === true && HOMES.has(b.use));
  // a whole building so slender is a tower; the parts of a building (bays, stairwells) may well be slender
  const tower = (b: Building) => special(b) || b.height - b.minHeight > SLENDER * orientedBox(b.polygon.outer).length;
  const unusual = (b: Building) => special(b) || b.windowless === true || b.shelter !== undefined || b.material === "glass";
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
