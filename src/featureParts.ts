// Where on a long street or a wide lake a point is, in words a person can find: a street's ends and a lake's
// shores, each by its compass direction ("the east end", "the southwest shore"). A user's place matched to the
// map's streets and waters this way is a Derivative Database under the ODbL (see the README's Licences).
import { distanceToRing, nearestOnLine, pointInRing, type Point } from "./geometry.ts";
import type { Area, Road } from "./osm.ts";

export type Compass = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** A part of a street or a lake: an end of the street, or a stretch of the lake's shore, and its point */
export interface FeaturePart {
  kind: "end" | "shore";
  direction: Compass;
  point: Point;
}

/** The feature matched: its pieces among those given, and its parts (none for a short street or a small lake) */
export interface FeatureMatch<T> {
  pieces: T[];
  parts: FeaturePart[];
}

/** The parts of a map Road a street's parts use */
export type PartRoad = Pick<Road, "line"> & Partial<Pick<Road, "name">>;
/** The parts of a map Area a lake's parts use; the pieces of a large one, cut apart, share osm */
export type PartArea = Pick<Area, "kind" | "polygon"> & Partial<Pick<Area, "osm" | "flowing">>;

/** A street passes this near (m) the point it is matched at */
const STREET_MATCH_M = 50;
/** Pieces of a street with an end this near (m) another are one street: across a roundabout, between carriageways */
const STREET_JOIN_M = 60;
/** A street with its ends nearer (m) is a spot of its own: it has no parts */
const MIN_STREET_M = 200;
/** A point this near (m) a lake's shore, outside it, is at the lake */
const LAKE_MATCH_M = 50;
/** A lake narrower (m) than this is a spot of its own: it has no parts */
const MIN_LAKE_M = 150;
/** A shore this near (m) one kept before it is the same stretch: left out */
const SHORES_APART_M = 100;

/** The main directions first, so that a lake's north tip is its north shore rather than its northeast one */
const SHORE_ORDER: Compass[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
/** Counter-clockwise from east, by eighths of a turn */
const COMPASS: Compass[] = ["e", "ne", "n", "nw", "w", "sw", "s", "se"];

/** The compass direction of a vector east and north */
export function compassOf(east: number, north: number): Compass {
  const eighths = Math.round(Math.atan2(north, east) / (Math.PI / 4));
  return COMPASS[((eighths % 8) + 8) % 8];
}

/** A street's name as compared: letter case, the kind of dash and spaces aside */
export function streetNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

/**
 * The street named `name` that passes within STREET_MATCH_M of `near`: its roads (those of the name joined to it,
 * end to line, within STREET_JOIN_M) and its two ends, the points of its roads farthest apart; undefined when no road
 * of the name passes near.
 */
export function streetParts<T extends PartRoad>(roads: T[], name: string, near: Point): FeatureMatch<T> | undefined {
  const key = streetNameKey(name);
  const named = roads.filter((road) => road.name !== undefined && road.line.length > 1 && streetNameKey(road.name) === key);
  const pieces = named.filter((road) => nearestOnLine(road.line, near).distance <= STREET_MATCH_M);
  if (pieces.length === 0) {
    return undefined;
  }
  const joined = (a: PartRoad, b: PartRoad) =>
    [a.line[0], a.line[a.line.length - 1]].some((p) => nearestOnLine(b.line, p).distance <= STREET_JOIN_M) ||
    [b.line[0], b.line[b.line.length - 1]].some((p) => nearestOnLine(a.line, p).distance <= STREET_JOIN_M);
  const left = new Set(named.filter((road) => !pieces.includes(road)));
  for (let i = 0; i < pieces.length; i++) {
    for (const road of left) {
      if (joined(pieces[i], road)) {
        pieces.push(road);
        left.delete(road);
      }
    }
  }
  const [a, b] = farthestApart(pieces.flatMap((road) => road.line));
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_STREET_M) {
    return { pieces, parts: [] };
  }
  return {
    pieces,
    parts: [
      { kind: "end", direction: compassOf(a[0] - b[0], a[1] - b[1]), point: a },
      { kind: "end", direction: compassOf(b[0] - a[0], b[1] - a[1]), point: b },
    ],
  };
}

/**
 * The lake or pond (still water) `near` is in, or the nearest within LAKE_MATCH_M: its pieces (those sharing its osm)
 * and its shores, for each direction its outline's farthest point that way, one within SHORES_APART_M of a shore kept
 * before it left out; undefined when there is none.
 */
export function lakeParts<T extends PartArea>(areas: T[], near: Point): FeatureMatch<T> | undefined {
  const still = areas.filter((area) => area.kind === "water" && area.flowing !== true && area.polygon.outer.length > 2);
  const inside = still.find((area) => pointInRing(near, area.polygon.outer));
  let found = inside;
  if (!found) {
    let best = LAKE_MATCH_M;
    for (const area of still) {
      const distance = distanceToRing(near, area.polygon.outer);
      if (distance <= best) {
        best = distance;
        found = area;
      }
    }
  }
  if (!found) {
    return undefined;
  }
  const lake = found;
  const pieces = lake.osm === undefined ? [lake] : still.filter((area) => area.osm === lake.osm);
  const points = pieces.flatMap((area) => area.polygon.outer);
  const farthest = (direction: Compass): Point => {
    const angle = (COMPASS.indexOf(direction) * Math.PI) / 4;
    const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
    return points.reduce((best, p) => (p[0] * dx + p[1] * dy > best[0] * dx + best[1] * dy ? p : best));
  };
  const shores: FeaturePart[] = [];
  for (const direction of SHORE_ORDER) {
    const point = farthest(direction);
    if (!shores.some((shore) => Math.hypot(shore.point[0] - point[0], shore.point[1] - point[1]) < SHORES_APART_M)) {
      shores.push({ kind: "shore", direction, point });
    }
  }
  const [a, b] = farthestApart(shores.map((shore) => shore.point));
  return { pieces, parts: Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_LAKE_M ? [] : shores };
}

/** The two points farthest apart */
function farthestApart(points: Point[]): [Point, Point] {
  let best: [Point, Point] = [points[0], points[0]];
  let most = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = (points[i][0] - points[j][0]) ** 2 + (points[i][1] - points[j][1]) ** 2;
      if (d > most) {
        most = d;
        best = [points[i], points[j]];
      }
    }
  }
  return best;
}
