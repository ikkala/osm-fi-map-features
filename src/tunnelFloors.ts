// Tunnels' floors known from plans or surveys, which OSM does not tell: a JSON file of
// { "floors": [{ "tunnel", "latitude", "longitude", "floor", "source" }] }, each the tunnel's name (as its ways have
// it), a WGS84 point, the height of the way's surface there (m, in the elevation model's system, N2000) and the plan or
// survey it is from. They go to MapBuilder as its tunnelFloors.
import { field, items } from "./json.ts";
import type { GeoPoint } from "./projection.ts";
import { readText, type TextSource } from "./text.ts";

export interface TunnelFloor {
  /** The tunnel's name=*: the floor is held on its ways, not on another tunnel passing nearer */
  name: string;
  at: GeoPoint;
  floor: number;
  /** The plan or survey it is from */
  source: string;
}

/** The floors of a file's `floors`, each with its tunnel's name, a latitude, a longitude, a floor and a source */
export function parseTunnelFloors(text: string): TunnelFloor[] {
  const json: unknown = JSON.parse(text);
  return items(field(json, "floors")).map((entry, i) => {
    const [tunnel, latitude, longitude, floor, source] = ["tunnel", "latitude", "longitude", "floor", "source"].map((name) => field(entry, name));
    if (
      typeof tunnel !== "string" ||
      tunnel === "" ||
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      typeof floor !== "number" ||
      typeof source !== "string" ||
      source === ""
    ) {
      throw new Error(`tunnel floor ${i + 1}: needs a tunnel, a latitude, a longitude, a floor and a source`);
    }
    return { name: tunnel, at: { latitude, longitude }, floor, source };
  });
}

/** The floors of a file, a text or a stream */
export async function readTunnelFloors(source: TextSource): Promise<TunnelFloor[]> {
  return parseTunnelFloors(await readText(source));
}
