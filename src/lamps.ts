// Guesses street lamps' heights and facing, which OSM rarely has: a lamp faces the nearest street (or else
// path) and is as tall as lamps by such a way usually are.
import { deckAt } from "./bridges.ts";
import { nearestOnLine, type Point } from "./geometry.ts";
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
 * Sets the missing facing (`toward`) and height of lamps, and the `base` of lamps on bridge decks; tunnels
 * are ignored. Returns how many lamps got each.
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
      const nearest = { road, ...nearestOnLine(road.line, lamp.point) };
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

function closer(a: Nearest | undefined, b: Nearest): Nearest {
  return a && a.distance <= b.distance ? a : b;
}
