export { MapBuilder, DEFAULT_OVERPASS_URL, OSM_ATTRIBUTION, type Logger, type MapInfo, type MapOptions } from "./builder.ts";
export { fileCache, memoryCache, type SourceCache } from "./cache.ts";
export { ELEVATION_ATTRIBUTION } from "./elevation.ts";
export { FOOTFALL_HOURS, FOOTFALL_MONTHS, FOOTFALL_WEEKDAYS } from "./footfall.ts";
export { triangulate, type Point, type Polygon, type Rect, type Ring } from "./geometry.ts";
export { ORTHO_ATTRIBUTION } from "./ortho.ts";
export type {
  Area,
  AreaKind,
  Barrier,
  BarrierKind,
  Building,
  Business,
  BusinessCategory,
  BusinessFront,
  Crossing,
  Entrance,
  Gate,
  GeoBox,
  LampMount,
  MapFeatures,
  Opening,
  PassageRoom,
  Rail,
  Road,
  RoofShape,
  Sidewalks,
  StreetLamp,
  TrafficSignal,
  Tree,
  TreeKind,
  WayPoint,
  WindowStyle,
} from "./osm.ts";
export { isValidGeoPoint, LocalProjection, type GeoPoint } from "./projection.ts";
export { TAMPERE_ATTRIBUTION, TAMPERE_COUNTS_ATTRIBUTION, TAMPERE_TREES_ATTRIBUTION } from "./tampere.ts";
export { tileName, tileRect, type Heights, type Tile, type TileKey } from "./tiles.ts";
