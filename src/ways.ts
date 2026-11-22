// The ways' classes and dimensions, shared by the modules that build around roads and railways (tunnels, cuts,
// decks, track beds, barriers, trees): who uses a way, how wide it is, the room it keeps under a deck, a lid or a
// tunnel's roof, how thick those are and how far they reach past its sides, and how steeply its ramps may run.
import type { Rail, Road } from "./osm.ts";

export type Way = Road | Rail;

/** Who a way is for: people (on foot, by bicycle, on horseback), vehicles, trams or trains */
export type WayUser = "people" | "vehicles" | "trams" | "trains";

/** highway=* kinds for people only */
export const WALKWAYS: ReadonlySet<string> = new Set(["footway", "pedestrian", "cycleway", "path", "track", "bridleway", "steps", "corridor"]);
/** railway=* kinds trams run on */
export const TRAMWAYS: ReadonlySet<string> = new Set(["tram", "light_rail"]);

/** A railway's width (m): its ballast's, which its bridge's deck, its lid and its room in a tunnel are as wide as */
export const RAIL_WIDTH_M = 3;
/** A way's room in a tunnel reaches this far (m) past its sides */
export const ROOM_SIDE_M = 1;
/** A bridge's deck reaches this far (m) past its way's sides, and is this thick under its top */
export const DECK_EDGE_M = 0.5;
export const DECK_THICKNESS_M = 1;
/** A cut tunnel's lid reaches this far (m) past its way's sides, and is this thick under its top */
export const LID_EDGE_M = 2;
export const LID_THICKNESS_M = 0.5;
/** A bored tunnel's roof over its room (m) */
export const ROOF_M = 1;

/**
 * The room (m) over a way's surface that the map builds where it chooses the depth: a bored tunnel's, hung under
 * the ground. A tram's is a train's, as both run under an overhead line.
 */
export const CLEARANCE_M: Readonly<Record<WayUser, number>> = { people: 3, vehicles: 4.8, trams: 6, trains: 6 };
/**
 * The least room (m) a way keeps under a cover that the data fixes: under a bridge's deck (the way goes down into a
 * cut for it), under a cut's lid (at its rim, or fitted to the decks over it), and a tram's bed under a deck. Room
 * for the users' tallest vehicles: a lorry, a tram, a train with its overhead line.
 */
export const MIN_CLEARANCE_M: Readonly<Record<WayUser, number>> = { people: 2.7, vehicles: 4.2, trams: 4, trains: 5.5 };
/**
 * The room (m) a way keeps under a deck where its cut cannot go deep enough for MIN_CLEARANCE_M: a person's, a bus's,
 * a tram's, a train's
 */
export const LEAST_CLEARANCE_M: Readonly<Record<WayUser, number>> = { people: 2.2, vehicles: 3.5, trams: MIN_CLEARANCE_M.trams, trains: 4.8 };
/**
 * A tramway goes down into a cut under a deck where the deck leaves it less than this (m), more than its least room:
 * tracks side by side under one deck go down together only where each needs to, and with the least room one would
 * stay up beside the other's cut
 */
export const TRAM_CUT_CLEARANCE_M = 4.7;
/** A way's ramps (up to a bridge's deck, down into a cut under one) run no steeper than this (rise over run) */
export const GRADE: Readonly<Record<WayUser, number>> = { people: 0.08, vehicles: 0.06, trams: 0.03, trains: 0.03 };
/** A bored tunnel's floor, which the ways of its network share, rises or falls no steeper than this */
export const TUNNEL_GRADE = 0.07;
/** Stairs rise no steeper than this: out of a tunnel (and corridors there), and out of a cut under a bridge */
export const STAIRS_GRADE = 0.6;

/** Whether a way is a road (highway=*), not a railway */
export function isRoad(way: Way): way is Road {
  return "width" in way;
}

export function userOf(way: Way): WayUser {
  if (isRoad(way)) {
    return WALKWAYS.has(way.kind) ? "people" : "vehicles";
  }
  return TRAMWAYS.has(way.kind) ? "trams" : "trains";
}

/** A way's width (m): a road's own, a railway's ballast */
export function widthOf(way: Way): number {
  return isRoad(way) ? way.width : RAIL_WIDTH_M;
}

/** The dimensions above as data, for the programs that draw the map's ways as they were built */
export const WAY_DIMENSIONS = {
  railWidth: RAIL_WIDTH_M,
  roomSide: ROOM_SIDE_M,
  deckEdge: DECK_EDGE_M,
  deckThickness: DECK_THICKNESS_M,
  lidEdge: LID_EDGE_M,
  lidThickness: LID_THICKNESS_M,
  roof: ROOF_M,
  clearance: CLEARANCE_M,
  minClearance: MIN_CLEARANCE_M,
  grade: GRADE,
  walkways: [...WALKWAYS],
  tramways: [...TRAMWAYS],
} as const;
