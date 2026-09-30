// Shops, restaurants, offices and other businesses in buildings. OSM has them as points inside the
// buildings (in central Tampere about 1 270, nearly all with a name and an eighth with a brand; a twentieth
// are tagged on a building or an area instead), and seldom with their own door: there are some 25
// entrance=shop or restaurant nodes. So a business shows (its front) at a door of its kind near it, else on
// the wall nearest to it that faces a street, and nowhere when it is deep inside a large building or in a
// shopping centre (Ratina has 66, Koskikeskus 40) without a door of its own.
import { nearestOnSegment, pointInPolygon, ringArea, type Point, type Ring } from "./geometry.ts";
import {
  bounds,
  NOT_FOR_VEHICLES,
  type Building,
  type Business,
  type BusinessCategory,
  type BusinessFront,
  type GeoBox,
  type OverpassResponse,
  type Road,
} from "./osm.ts";
import { LocalProjection, type GeoPoint } from "./projection.ts";

/** The amenity=*, tourism=* and leisure=* values that are businesses; the rest (benches, parking, parks, ...) are not */
const AMENITIES = [
  "restaurant", "cafe", "fast_food", "bar", "pub", "biergarten", "ice_cream", "food_court", "nightclub", "cinema",
  "theatre", "arts_centre", "casino", "pharmacy", "bank", "bureau_de_change", "money_transfer", "dentist", "doctors",
  "clinic", "veterinary", "post_office", "library", "driving_school", "coworking_space", "internet_cafe", "car_rental",
  "car_wash", "fuel", "marketplace",
];
const TOURISM = ["hotel", "hostel", "guest_house", "motel", "apartment", "museum", "gallery"];
const LEISURE = ["fitness_centre", "sports_centre", "bowling_alley", "escape_game", "amusement_arcade", "adult_gaming_centre", "sauna", "dance"];
/**
 * The keys that make an element a business, in the order they decide its category (a pharmacy tagged with
 * both amenity=pharmacy and healthcare=pharmacy is an amenity); undefined takes any value
 */
const CATEGORIES: [BusinessCategory, string[] | undefined][] = [
  ["shop", undefined],
  ["office", undefined],
  ["craft", undefined],
  ["amenity", AMENITIES],
  ["healthcare", undefined],
  ["tourism", TOURISM],
  ["leisure", LEISURE],
];

/** A business this close (m) to a building's outline, outside it, is in the building */
const ON_WALL_M = 2;
/** A business shows at an entrance=shop or restaurant this close to it (m), else at a main door this close */
const SHOP_DOOR_REACH_M = 20;
const MAIN_DOOR_REACH_M = 8;
const SHOP_DOORS = new Set(["shop", "restaurant"]);
const MAIN_DOORS = new Set(["main", "yes"]);
/** A business farther than this (m) from any open wall of its building has no front */
const MAX_DEPTH_M = 20;
/** A wall faces a street when one is this close (m) out in front of it */
const STREET_REACH_M = 25;
/** The point this far (m) out of a wall tells whether it is open: not inside another building */
const OUTSIDE_M = 1;
/** The fronts of a building's businesses are this far apart (m), and moved ones this far from a corner */
const FRONT_SPACING_M = 6;
const CORNER_M = 1.5;
/** Buildings and streets are looked up in square cells this large (m) */
const CELL_M = 50;

export function businessQuery(box: GeoBox): string {
  const selectors = CATEGORIES.map(([key, values]) => (values ? `nwr["${key}"~"^(${values.join("|")})$"]` : `nwr["${key}"]`));
  const bbox = [box.south, box.west, box.north, box.east].join(",");
  return `[out:json][timeout:90][bbox:${bbox}];\n(\n${selectors.map((s) => `  ${s};`).join("\n")}\n);\nout tags center;`;
}

/** The businesses of an Overpass response ("out center"), in meters around origin */
export function parseBusinesses(elements: OverpassResponse["elements"], origin: GeoPoint): Business[] {
  const projection = new LocalProjection(origin);
  const result: Business[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const category = CATEGORIES.find(([key, values]) => tags[key] !== undefined && tags[key] !== "no" && (!values || values.includes(tags[key])));
    const at = element.type === "node" ? (element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : undefined) : element.center;
    if (!category || !at) {
      continue;
    }
    const [key] = category;
    const level = lowestLevel(tags.level);
    result.push({
      osm: `${element.type[0]}${element.id}`,
      category: key,
      kind: tags[key],
      ...(tags.name && { name: tags.name }),
      ...(tags.brand && { brand: tags.brand }),
      ...(tags.cuisine && { cuisine: tags.cuisine }),
      ...(level !== undefined && { level }),
      point: projection.toMeters({ latitude: at.lat, longitude: at.lon }),
    });
  }
  return result;
}

/** The lowest storey of a level=* value such as "0", "-1", "0;1" or "1-2" */
export function lowestLevel(value: string | undefined): number | undefined {
  const levels = (value ?? "").split(";").flatMap((part) => {
    const match = /^\s*(-?\d+(?:\.\d+)?)(?:\s*-\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(part);
    return match ? [Number(match[1]), ...(match[2] !== undefined ? [Number(match[2])] : [])] : [];
  });
  return levels.length > 0 ? Math.min(...levels) : undefined;
}

/**
 * Puts the businesses into the drawn buildings (outlines without parts, and parts) they are in, and gives
 * them their fronts. Run after the entrances are assigned. Returns how many are in a building, how many of
 * those got a front, and how many fronts are at a door.
 */
export function placeBusinesses(buildings: Building[], businesses: Business[], roads: Road[]): { placed: number; fronts: number; atDoors: number } {
  const drawn = buildings.filter((b) => !b.hasParts && b.shelter === undefined);
  const buildingCells = new Cells<Building>();
  for (const b of drawn) {
    buildingCells.add(b, bounds(b.polygon.outer));
  }
  const streetCells = new Cells<Road>();
  for (const road of roads) {
    if (!road.tunnel && road.line.length >= 2 && (road.kind === "pedestrian" || !NOT_FOR_VEHICLES.has(road.kind))) {
      streetCells.add(road, bounds(road.line));
    }
  }
  // the buildings tagged shop=mall: the shops inside them show outside only at their own doors
  const mallIds = new Set(businesses.filter((b) => b.category === "shop" && b.kind === "mall").map((b) => b.osm));
  const malls = buildings.filter((b) => mallIds.has(b.osm));
  const counts = { placed: 0, fronts: 0, atDoors: 0 };
  const placed = new Set<Building>();
  for (const business of businesses) {
    const building = buildingOf(business, buildingCells);
    if (!building) {
      continue;
    }
    (building.businesses ??= []).push(business);
    placed.add(building);
    counts.placed++;
    const inMall = !mallIds.has(business.osm) && malls.some((mall) => pointInPolygon(business.point, mall.polygon));
    const front = doorFront(business, building) ?? (inMall ? undefined : wallFront(business, building, buildingCells, streetCells));
    if (front) {
      business.front = front;
    }
  }
  for (const building of placed) {
    spreadFronts(building);
    for (const { front } of building.businesses ?? []) {
      if (front) {
        counts.fronts++;
        if (front.entrance) {
          counts.atDoors++;
        }
      }
    }
  }
  return counts;
}

/**
 * Moves the fronts of a building's businesses apart along their walls, FRONT_SPACING_M from each other: several
 * businesses often share a door or the nearest spot of a wall. Those at doors stay first; a front that finds no
 * room on its edge of the outline is dropped.
 */
function spreadFronts(building: Building): void {
  const rings = [building.polygon.outer, ...building.polygon.holes];
  const taken: Point[] = [];
  const free = (p: Point) => taken.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= FRONT_SPACING_M - 1e-6);
  const businesses = (building.businesses ?? []).filter((b) => b.front);
  // doors first, keeping the order otherwise
  businesses.sort((a, b) => Number(b.front?.entrance ?? false) - Number(a.front?.entrance ?? false));
  for (const business of businesses) {
    const front = business.front;
    const edge = front && nearestEdge(front.at, rings);
    if (!front || !edge) {
      continue;
    }
    const [a, c] = edge;
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const at = Math.hypot(front.at[0] - a[0], front.at[1] - a[1]);
    // along the edge, nearest first, keeping clear of its corners
    const tries = [0];
    for (let step = 1; step * FRONT_SPACING_M <= length; step++) {
      tries.push(step * FRONT_SPACING_M, -step * FRONT_SPACING_M);
    }
    const along = (k: number): Point => [a[0] + ((c[0] - a[0]) * k) / length, a[1] + ((c[1] - a[1]) * k) / length];
    const offset = tries.find((o) => (o === 0 ? free(front.at) : at + o >= CORNER_M && at + o <= length - CORNER_M && free(along(at + o))));
    if (offset === 0) {
      taken.push(front.at);
    } else if (offset !== undefined) {
      business.front = { at: along(at + offset), toward: front.toward };
      taken.push(business.front.at);
    } else {
      delete business.front;
    }
  }
}

/** The edge of the rings that p is on (or nearest to) */
function nearestEdge(p: Point, rings: Ring[]): [Point, Point] | undefined {
  let best: [Point, Point] | undefined;
  let bestDistance = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const q = nearestOnSegment(p, a, c);
      const distance = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (distance < bestDistance && (a[0] !== c[0] || a[1] !== c[1])) {
        best = [a, c];
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * The building a business is in: the one it is tagged on, else the one around its point (the lowest, then
 * the smallest: a part on the ground rather than one over it), else one whose wall it is on
 */
function buildingOf(business: Business, cells: Cells<Building>): Building | undefined {
  const near = cells.near(business.point, ON_WALL_M);
  const tagged = near.filter((b) => b.osm === business.osm);
  const around = (tagged.length > 0 ? tagged : near).filter((b) => pointInPolygon(business.point, b.polygon));
  if (around.length > 0) {
    return around.reduce((best, b) =>
      b.minHeight < best.minHeight || (b.minHeight === best.minHeight && Math.abs(ringArea(b.polygon.outer)) < Math.abs(ringArea(best.polygon.outer))) ? b : best,
    );
  }
  if (tagged.length > 0) {
    return tagged[0];
  }
  let best: Building | undefined;
  let bestDistance = ON_WALL_M;
  for (const b of near) {
    const wall = nearestWall(business.point, [b.polygon.outer, ...b.polygon.holes]);
    if (wall && wall.distance <= bestDistance) {
      best = b;
      bestDistance = wall.distance;
    }
  }
  return best;
}

/** At the nearest shop or restaurant door of the building near the business, else at a main door near it */
function doorFront(business: Business, building: Building): BusinessFront | undefined {
  const door = nearestDoor(business.point, building, SHOP_DOORS, SHOP_DOOR_REACH_M) ?? nearestDoor(business.point, building, MAIN_DOORS, MAIN_DOOR_REACH_M);
  const wall = door && nearestWall(door, [building.polygon.outer, ...building.polygon.holes]);
  return door && wall && { at: door, toward: wall.toward, entrance: true };
}

/** The building's OSM entrance of one of these kinds nearest to p within reach */
function nearestDoor(p: Point, building: Building, kinds: Set<string>, reach: number): Point | undefined {
  let best: Point | undefined;
  let bestDistance = reach;
  for (const e of building.entrances ?? []) {
    const distance = Math.hypot(e.at[0] - p[0], e.at[1] - p[1]);
    if (!e.guessed && kinds.has(e.kind) && distance <= bestDistance) {
      best = e.at;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * On the open wall (not against another building) nearest to the business that faces a street, else on the
 * nearest open wall; none when they are all farther than MAX_DEPTH_M
 */
function wallFront(business: Business, building: Building, buildings: Cells<Building>, streets: Cells<Road>): BusinessFront | undefined {
  let facing: { at: Point; toward: number; distance: number } | undefined;
  let open: typeof facing;
  for (const ring of [building.polygon.outer, ...building.polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (length === 0) {
        continue;
      }
      const at = nearestOnSegment(business.point, a, c);
      const distance = Math.hypot(at[0] - business.point[0], at[1] - business.point[1]);
      if (distance > MAX_DEPTH_M || (facing && distance >= facing.distance)) {
        continue;
      }
      // outer rings run counter-clockwise and holes clockwise, so the building is on the left of every edge
      const out: Point = [(c[1] - a[1]) / length, -(c[0] - a[0]) / length];
      const outside: Point = [at[0] + out[0] * OUTSIDE_M, at[1] + out[1] * OUTSIDE_M];
      if (buildings.near(outside, 0).some((b) => b !== building && pointInPolygon(outside, b.polygon))) {
        continue;
      }
      const front = { at, toward: degrees(out), distance };
      if (facesStreet(outside, out, streets)) {
        facing = front;
      } else if (!open || distance < open.distance) {
        open = front;
      }
    }
  }
  const best = facing ?? open;
  return best && { at: best.at, toward: best.toward };
}

/** Whether a street runs within STREET_REACH_M of a point in front of a wall facing out */
function facesStreet(from: Point, out: Point, streets: Cells<Road>): boolean {
  for (const street of streets.near(from, STREET_REACH_M)) {
    for (let i = 0; i + 1 < street.line.length; i++) {
      const q = nearestOnSegment(from, street.line[i], street.line[i + 1]);
      const dx = q[0] - from[0];
      const dy = q[1] - from[1];
      if (Math.hypot(dx, dy) <= STREET_REACH_M && dx * out[0] + dy * out[1] > 0) {
        return true;
      }
    }
  }
  return false;
}

/** The nearest point on the rings' edges, its distance and the direction straight out of that edge */
function nearestWall(p: Point, rings: Ring[]): { at: Point; distance: number; toward: number } | undefined {
  let best: { at: Point; distance: number; toward: number } | undefined;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const at = nearestOnSegment(p, a, c);
      const distance = Math.hypot(at[0] - p[0], at[1] - p[1]);
      if (!best || distance < best.distance) {
        best = { at, distance, toward: degrees([c[1] - a[1], -(c[0] - a[0])]) };
      }
    }
  }
  return best;
}

/** Degrees counter-clockwise from east, 0 .. 360 */
function degrees([x, y]: Point): number {
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  return ((angle % 360) + 360) % 360;
}

/** Items by the square cells their boxes touch, to look up the ones near a point */
class Cells<T> {
  readonly #cells = new Map<string, T[]>();

  add(item: T, box: ReturnType<typeof bounds>): void {
    for (let y = Math.floor(box.minY / CELL_M); y <= Math.floor(box.maxY / CELL_M); y++) {
      for (let x = Math.floor(box.minX / CELL_M); x <= Math.floor(box.maxX / CELL_M); x++) {
        const key = `${x},${y}`;
        const cell = this.#cells.get(key);
        if (cell) {
          cell.push(item);
        } else {
          this.#cells.set(key, [item]);
        }
      }
    }
  }

  /** The items whose cells are within reach of p, each once */
  near([px, py]: Point, reach: number): T[] {
    const found = new Set<T>();
    for (let y = Math.floor((py - reach) / CELL_M); y <= Math.floor((py + reach) / CELL_M); y++) {
      for (let x = Math.floor((px - reach) / CELL_M); x <= Math.floor((px + reach) / CELL_M); x++) {
        for (const item of this.#cells.get(`${x},${y}`) ?? []) {
          found.add(item);
        }
      }
    }
    return [...found];
  }
}
