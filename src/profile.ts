// A way's vertical profile: what its surface lies on, read once from what the stages set on it, for the programs that
// draw the ways and those asking whether a way is on the ground. OSM's bridge and tunnel say what the way is; the
// profile says where the map has built it.
import type { Way } from "./ways.ts";

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

export function profileOf(way: Way): Profile {
  if (way.tunnel) {
    return way.lid ? { kind: "lid", heights: way.lid } : { kind: "bored", ...(way.floor && { heights: way.floor }) };
  }
  if (way.floor) {
    return { kind: "cut", heights: way.floor };
  }
  if (way.bridge) {
    return { kind: "width" in way && way.boardwalk ? "boardwalk" : "deck", ...(way.deck && { heights: way.deck }) };
  }
  if (way.deck) {
    return { kind: "approach", heights: way.deck };
  }
  return "bed" in way && way.bed ? { kind: "bed", heights: way.bed } : { kind: "ground" };
}

/** Whether a way is in a tunnel as the map built it: under the ground, or in a cut under a lid */
export function inTunnel(way: Way): boolean {
  const { kind } = profileOf(way);
  return kind === "bored" || kind === "lid";
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
