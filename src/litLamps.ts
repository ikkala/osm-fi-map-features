// Street lamps along the ways OSM tags lit (lit=*) where it maps no lamp near: a lamp beside the way, on its right
// going along it, every LIT_SPACING_M where none stands within LAMP_NEAR_M, so that a lit street is lit even where its
// lamps are not mapped. Tunnels, steps and indoor ways are left out, and so is a lamp that would stand on another
// way, within its width and CLEAR_M (a tram's track beside the street, a carriageway beside a lit path). The lamps get
// their heights and facing as OSM's do (lamps.ts).
import { distancesAlong, distanceToSegment, grownRect, pointAt, RectGrid, type Point } from "./geometry.ts";
import { bounds, DEFAULT_LAMP_HEIGHTS, type Rail, type Road, type StreetLamp } from "./osm.ts";
import { inTunnel } from "./profile.ts";

/** Meters along a lit way between two lamps put by it, and how near a lamp (m) to a point of it already lights it */
const LIT_SPACING_M = 30;
const LAMP_NEAR_M = 20;
/** Meters past the way's edge a lamp stands */
const KERB_M = 0.5;
/** Meters a lamp keeps clear of another way's edge, and a rail's track's half width */
const CLEAR_M = 1;
const TRACK_HALF_M = 1.5;
/** Meters a side of the grid the ways' segments are looked up in */
const GRID_M = 50;
/** Ways no lamp is put by */
const UNLIT_KINDS = new Set(["steps", "corridor", "elevator", "platform", "proposed", "via_ferrata", "bus_stop"]);

/** Puts lamps along the lit ways where OSM has none near, off the other ways and the rails; returns how many */
export function fillLitWays(lamps: StreetLamp[], roads: Road[], rails: Rail[] = []): number {
  const lit = roads.filter((road) => road.lit && !inTunnel(road) && !UNLIT_KINDS.has(road.kind) && road.line.length >= 2);
  if (lit.length === 0) {
    return 0;
  }
  // the ways and tracks on the ground a lamp would stand on: their segments in a grid, each with its way
  const over = bounds(lit.flatMap((road) => road.line));
  const ways = new RectGrid<{ a: Point; b: Point; half: number; road?: Road }>(GRID_M, grownRect(over, GRID_M));
  const others = [
    ...roads.filter((road) => !inTunnel(road) && !road.bridge).map((road) => ({ line: road.line, half: road.width / 2, road })),
    ...rails.filter((rail) => !rail.tunnel && !rail.bridge).map((rail) => ({ line: rail.line, half: TRACK_HALF_M, road: undefined })),
  ];
  for (const { line, half, road } of others) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [a, b] = [line[i], line[i + 1]];
      ways.add(grownRect(bounds([a, b]), half + CLEAR_M), { a, b, half, ...(road && { road }) });
    }
  }
  const onAnother = (p: Point, own: Road) => ways.at(p).some(({ a, b, half, road }) => road !== own && distanceToSegment(p, a, b) < half + CLEAR_M);
  const cells = new Map<string, Point[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  const add = (p: Point) => {
    const k = key(Math.floor(p[0] / LAMP_NEAR_M), Math.floor(p[1] / LAMP_NEAR_M));
    const list = cells.get(k);
    if (list) {
      list.push(p);
    } else {
      cells.set(k, [p]);
    }
  };
  const near = (p: Point) => {
    const [cx, cy] = [Math.floor(p[0] / LAMP_NEAR_M), Math.floor(p[1] / LAMP_NEAR_M)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((cells.get(key(cx + dx, cy + dy)) ?? []).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < LAMP_NEAR_M)) {
          return true;
        }
      }
    }
    return false;
  };
  for (const lamp of lamps) {
    add(lamp.point);
  }
  let count = 0;
  for (const road of lit) {
    const along = distancesAlong(road.line);
    const length = along[along.length - 1];
    for (let d = LIT_SPACING_M / 2; d < length; d += LIT_SPACING_M) {
      const middle = pointAt(road.line, along, d);
      if (near(middle)) {
        continue;
      }
      const ahead = pointAt(road.line, along, Math.min(length, d + 1));
      const behind = pointAt(road.line, along, Math.max(0, d - 1));
      const [ex, ey] = [ahead[0] - behind[0], ahead[1] - behind[1]];
      const step = Math.hypot(ex, ey);
      if (step < 1e-6) {
        continue;
      }
      const out = road.width / 2 + KERB_M;
      const point: Point = [middle[0] + (ey / step) * out, middle[1] - (ex / step) * out];
      if (onAnother(point, road)) {
        continue;
      }
      lamps.push({ point, height: DEFAULT_LAMP_HEIGHTS.unknown, heightEstimated: true, implied: true });
      add(middle);
      count++;
    }
  }
  return count;
}
