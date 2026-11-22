// A way's vertical profile: what its surface lies on, read once from what the stages set on it, for the programs that
// draw the ways and those asking whether a way is on the ground. OSM's bridge and tunnel say what the way is, and stay
// as OSM tags them; the profile says where the map has built it, from them and the facts the stages add (AsBuilt).
import type { Way } from "./ways.ts";

/** Where the stages build a way otherwise than OSM's bridge and tunnel say */
export interface AsBuilt {
  /** A stretch crossing a cut tunnel's lid, built as a bridge on it (cuts.ts) */
  overLid?: true;
  /** A tunnel run at the ground under buildings (tunnels.ts) */
  atGrade?: true;
  /** A tunnel or a covered way run through buildings in a passage (passages.ts) */
  passage?: true;
}

/**
 * - ground: on the ground
 * - bed: a railway on its track bed, the ground smoothed along it (heights: bed)
 * - lid: a tunnel in a cut at the ground, under a lid (heights: the lid's top)
 * - bored: a tunnel under the ground (heights: floor, where known)
 * - cut: down into the ground out of a tunnel's portal or under a bridge (heights: floor)
 * - approach: raised to a bridge's deck, not a bridge (heights: deck)
 * - deck: a bridge's span (heights: deck, where known)
 * - boardwalk: planks on the ground (heights: deck, where known)
 */
export type ProfileKind = "ground" | "bed" | "lid" | "bored" | "cut" | "approach" | "deck" | "boardwalk";

export interface Profile {
  kind: ProfileKind;
  /** At every point of the way's line (m above sea level), as the kind says; none on the ground */
  heights?: number[];
}

/** Whether the map builds a way as a bridge: OSM's, or a stretch on a lid */
export function isBridge(way: { bridge: boolean } & AsBuilt): boolean {
  return way.bridge || way.overLid === true;
}

/** Whether the map builds a way in a tunnel, under the ground or in a cut under a lid: OSM's, unless at the ground or in a passage */
export function inTunnel(way: { tunnel?: boolean } & AsBuilt): boolean {
  return way.tunnel === true && way.atGrade === undefined && way.passage === undefined;
}

export function profileOf(way: Way): Profile {
  if (inTunnel(way)) {
    return way.lid ? { kind: "lid", heights: way.lid } : { kind: "bored", ...(way.floor && { heights: way.floor }) };
  }
  if (way.floor) {
    return { kind: "cut", heights: way.floor };
  }
  if (isBridge(way)) {
    return { kind: "width" in way && way.boardwalk ? "boardwalk" : "deck", ...(way.deck && { heights: way.deck }) };
  }
  if (way.deck) {
    return { kind: "approach", heights: way.deck };
  }
  return "bed" in way && way.bed ? { kind: "bed", heights: way.bed } : { kind: "ground" };
}

/** Whether a way lies on the ground or a track bed: in no tunnel or cut, and on no deck or approach */
export function offStructures(way: Way): boolean {
  const { kind } = profileOf(way);
  return kind === "ground" || kind === "bed";
}

/** Whether a way is out of the tunnels and off the bridges' spans (on the ground, a bed, a cut or an approach) */
export function outOfTunnelsAndSpans(way: Way): boolean {
  const { kind } = profileOf(way);
  return kind !== "bored" && kind !== "lid" && kind !== "deck" && kind !== "boardwalk";
}

/** Whether a way's surface is the ground's: on it, on a track bed smoothing it, or in a cut at it under a lid */
export function onGround(kind: ProfileKind): boolean {
  return kind === "ground" || kind === "bed" || kind === "lid";
}
