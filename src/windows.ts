// Guesses the windows of ordinary buildings. Neither OSM nor the building register has windows, so they
// are drawn in rows, one per storey, spaced by the kind of building. Buildings of other kinds (churches,
// sheds, factories, halls, ...) are too varied to guess and get none, and so do buildings tagged as
// something special (a building=yes with man_made=tower, ...) and slender ones.
import { orientedBox, pointInPolygon, ringCentroid } from "./geometry.ts";
import { bounds, type Building, type WindowStyle } from "./osm.ts";

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

/** Building classes of the Finnish building register (C_RAKENNUSLUOKKA) and their windows */
const BY_USE: Record<string, WindowStyle> = {
  "0110": "house", // detached houses
  "0111": "house", // semi-detached houses
  "0112": "house", // terraced houses
  "0211": "house", // holiday homes
  "0120": "apartments", // low blocks of flats
  "0121": "apartments", // blocks of flats
  "0130": "apartments", // residential homes
  "0320": "apartments", // hotels
  "0321": "apartments", // hostels
  "0319": "office", // other shops
  "0330": "office", // restaurants
  "0400": "office", // offices
  "0810": "office", // kindergartens
  "0820": "office", // schools
  "0830": "office", // vocational schools
  "0840": "office", // universities
};

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
    GENERIC_KINDS.has(b.kind) ? (b.use === undefined ? undefined : BY_USE[b.use]) : BY_KIND[b.kind];
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
