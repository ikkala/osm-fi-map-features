// Street lamps' heights and facing where OSM does not have them. OSM has the lamps as points (in central
// Tampere about 2 100, a tenth of them with their mount and none with a height or a direction): a lamp
// next to a street is as tall as that street's lamps usually are and faces it, and a lamp with only a path
// next to it is a low park lamp facing the path. A lamp on a bridge stands on its deck.
import { deckAt } from "./bridges.ts";
import { nearestOnSegment, type Point } from "./geometry.ts";
import { bounds, NOT_FOR_VEHICLES, type Road, type StreetLamp } from "./osm.ts";

/** A lamp faces the nearest street this close to it (m to the centre line), else the nearest path this close */
const STREET_REACH_M = 15;
const PATH_REACH_M = 8;
/** Guessed heights (m) of lamps by main streets, by other streets, and by paths only or nothing */
const MAIN_STREET_LAMP_M = 10;
const STREET_LAMP_M = 8;
const PATH_LAMP_M = 5;
const MAIN_STREETS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link"]);
/** The mounts whose height the street tells; high masts, catenary masts, walls and wires keep their own */
const BY_STREET = new Set<StreetLamp["mount"]>([undefined, "straight", "angled"]);
/** A lamp this close (m) to a deck's edge, or inside it, stands on the deck */
const ON_DECK_M = 1;

interface Nearest {
  road: Road;
  distance: number;
  point: Point;
}

/**
 * Sets the facing (`toward`) of the lamps OSM has no direction for, the height of those it has no height
 * for, and the `base` of the lamps on bridge decks (and their approaches). Tunnels are left out: they are
 * under the ground the lamps stand on. Returns how many lamps got each.
 */
export function placeLamps(lamps: StreetLamp[], roads: Road[]): { facing: number; heights: number; onDecks: number } {
  const reach = Math.max(STREET_REACH_M, PATH_REACH_M);
  const candidates = roads.filter((r) => !r.tunnel && r.line.length >= 2).map((road) => ({ road, box: bounds(road.line) }));
  const counts = { facing: 0, heights: 0, onDecks: 0 };
  for (const lamp of lamps) {
    const [e, n] = lamp.point;
    let street: Nearest | undefined;
    let path: Nearest | undefined;
    let deck: Nearest | undefined;
    for (const { road, box } of candidates) {
      if (e < box.minX - reach || e > box.maxX + reach || n < box.minY - reach || n > box.maxY + reach) {
        continue;
      }
      const nearest = nearestOnLine(road, lamp.point);
      if (NOT_FOR_VEHICLES.has(road.kind)) {
        path = closer(path, nearest);
      } else {
        street = closer(street, nearest);
      }
      if (road.deck && nearest.distance <= road.width / 2 + ON_DECK_M) {
        deck = closer(deck, nearest);
      }
    }
    const facing = street && street.distance <= STREET_REACH_M ? street : path && path.distance <= PATH_REACH_M ? path : undefined;
    if (lamp.toward === undefined && facing && facing.distance > 0) {
      const degrees = (Math.atan2(facing.point[1] - n, facing.point[0] - e) * 180) / Math.PI;
      lamp.toward = ((degrees % 360) + 360) % 360;
      counts.facing++;
    }
    if (lamp.heightEstimated && BY_STREET.has(lamp.mount)) {
      const byStreet = street && street.distance <= STREET_REACH_M ? street.road : undefined;
      lamp.height = byStreet ? (MAIN_STREETS.has(byStreet.kind) ? MAIN_STREET_LAMP_M : STREET_LAMP_M) : PATH_LAMP_M;
      counts.heights++;
    }
    if (deck?.road.deck) {
      lamp.base = deckAt(deck.road.line, deck.road.deck, lamp.point);
      counts.onDecks++;
    }
  }
  return counts;
}

function nearestOnLine(road: Road, p: Point): Nearest {
  let best: Nearest = { road, distance: Infinity, point: road.line[0] };
  for (let i = 0; i + 1 < road.line.length; i++) {
    const q = nearestOnSegment(p, road.line[i], road.line[i + 1]);
    const distance = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (distance < best.distance) {
      best = { road, distance, point: q };
    }
  }
  return best;
}

function closer(a: Nearest | undefined, b: Nearest): Nearest {
  return a && a.distance <= b.distance ? a : b;
}
