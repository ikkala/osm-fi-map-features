// Helpers for the tests.
import assert from "node:assert/strict";
import { parseOsm, type OsmElement, type ParseResult } from "./osm.ts";
import { openBuildings, type ThroughBuildings } from "./passages.ts";
import type { GeoPoint } from "./projection.ts";

/** The value, failing the test when it is missing. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== undefined && value !== null, `${what} is missing`);
  return value;
}

/** Parses Overpass elements as the map does, with the buildings opened for the ways through them. */
export function parseWorld(elements: OsmElement[], origin: GeoPoint): ParseResult & ThroughBuildings {
  const parsed = parseOsm(elements, origin);
  return { ...parsed, ...openBuildings(parsed) };
}
