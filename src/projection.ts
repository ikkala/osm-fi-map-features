// Maps WGS84 coordinates to meters east and north of an origin and back, on a local tangent plane
// (accurate to well under a meter within a few kilometres).
import type { Point } from "./geometry.ts";
import type { GeoBox } from "./osm.ts";

/** WGS84 ellipsoid */
const SEMI_MAJOR_AXIS_M = 6378137;
const ECCENTRICITY_SQUARED = 6.69437999014e-3;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function isValidGeoPoint(point: GeoPoint): boolean {
  const { latitude, longitude } = point;
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/** The points inside the box */
export function inGeoBox<T extends GeoPoint>(points: T[], box: GeoBox): T[] {
  return points.filter(
    (p) => p.latitude >= box.south && p.latitude <= box.north && p.longitude >= box.west && p.longitude <= box.east,
  );
}

export class LocalProjection {
  readonly origin: GeoPoint;
  readonly #metersPerDegreeLat: number;
  readonly #metersPerDegreeLon: number;

  constructor(origin: GeoPoint) {
    if (!isValidGeoPoint(origin)) {
      throw new Error(`invalid origin: ${JSON.stringify(origin)}`);
    }
    this.origin = origin;
    // Radii of curvature at the origin latitude
    const phi = toRadians(origin.latitude);
    const w = 1 - ECCENTRICITY_SQUARED * Math.sin(phi) ** 2;
    const meridional = (SEMI_MAJOR_AXIS_M * (1 - ECCENTRICITY_SQUARED)) / w ** 1.5;
    const primeVertical = SEMI_MAJOR_AXIS_M / Math.sqrt(w);
    this.#metersPerDegreeLat = toRadians(meridional);
    this.#metersPerDegreeLon = toRadians(primeVertical * Math.cos(phi));
  }

  /** [east, north] meters from the origin */
  toMeters(point: GeoPoint): Point {
    return [
      wrapDegrees(point.longitude - this.origin.longitude) * this.#metersPerDegreeLon,
      (point.latitude - this.origin.latitude) * this.#metersPerDegreeLat,
    ];
  }

  toGeo([east, north]: Point): GeoPoint {
    return {
      latitude: this.origin.latitude + north / this.#metersPerDegreeLat,
      longitude: wrapDegrees(this.origin.longitude + east / this.#metersPerDegreeLon),
    };
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Wraps a longitude or longitude difference into [-180, 180). */
function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}
