// Street lamps along the ways OSM tags lit (lit=*) where it maps no lamp near: a lamp beside the way, on its right
// going along it, every LIT_SPACING_M where none stands within LAMP_NEAR_M, so that a lit street is lit even where its
// lamps are not mapped. Tunnels, steps and indoor ways are left out, and so is a lamp that would stand in another
// way's room (its width and ROOM_SIDE_M past its sides) at its way's layer or above: a tram's track beside the
// street, on the ground or on the bridge they share, a carriageway beside a lit path, a railway's or a road's bridge
// over the lit way, which the pole would stand through. The lamps get their heights and facing as OSM's do (lamps.ts).
import { distancesAlong, distanceToSegment, grownRect, pointAt, RectGrid, type Point } from "./geometry.ts";
import { bounds, DEFAULT_LAMP_HEIGHTS, type Rail, type Road, type StreetLamp } from "./osm.ts";
import { inTunnel } from "./profile.ts";
import { ROOM_SIDE_M, widthOf } from "./ways.ts";

/** Meters along a lit way between two lamps put by it, and how near a lamp (m) to a point of it already lights it */
const LIT_SPACING_M = 30;
const LAMP_NEAR_M = 20;
/** Meters past the way's edge a lamp stands */
const KERB_M = 0.5;
/** Meters a side of the grid the ways' segments are looked up in */
const GRID_M = 50;
/** Ways no lamp is put by */
const UNLIT_KINDS = new Set(["steps", "corridor", "elevator", "platform", "proposed", "via_ferrata", "bus_stop"]);

/** Puts lamps along the lit ways where OSM has none near, out of the other ways' and the rails' rooms; returns how many */
export function fillLitWays(lamps: StreetLamp[], roads: Road[], rails: Rail[] = []): number {
  const lit = roads.filter((road) => road.lit && !inTunnel(road) && !UNLIT_KINDS.has(road.kind) && road.line.length >= 2);
  if (lit.length === 0) {
    return 0;
  }
  // the ways' and tracks' rooms a lamp could stand in: their segments in a grid, each with its way
  const over = bounds(lit.flatMap((road) => road.line));
  const ways = new RectGrid<{ a: Point; b: Point; room: number; layer: number; way: Road | Rail }>(GRID_M, grownRect(over, GRID_M));
  for (const way of [...roads.filter((road) => !inTunnel(road)), ...rails.filter((rail) => !rail.tunnel)]) {
    const room = widthOf(way) / 2 + ROOM_SIDE_M;
    for (let i = 0; i + 1 < way.line.length; i++) {
      const [a, b] = [way.line[i], way.line[i + 1]];
      ways.add(grownRect(bounds([a, b]), room), { a, b, room, layer: way.layer, way });
    }
  }
  // another way's room at the lamp's way's layer (on the ground, or on the same bridge) or over it
  const inAnother = (p: Point, own: Road) =>
    ways.at(p).some(({ a, b, room, layer, way }) => way !== own && layer >= own.layer && distanceToSegment(p, a, b) < room);
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
      if (inAnother(point, road)) {
        continue;
      }
      lamps.push({ point, height: DEFAULT_LAMP_HEIGHTS.unknown, heightEstimated: true, implied: true });
      add(middle);
      count++;
    }
  }
  return count;
}
