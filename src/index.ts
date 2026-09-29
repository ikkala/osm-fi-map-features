export { MapBuilder, DEFAULT_OVERPASS_URL, OSM_ATTRIBUTION, type Logger, type MapInfo, type MapOptions } from "./builder.ts";
export { fileCache, memoryCache, type SourceCache } from "./cache.ts";
export { ELEVATION_ATTRIBUTION } from "./elevation.ts";
export { triangulate, type Point, type Polygon, type Rect, type Ring } from "./geometry.ts";
export { ORTHO_ATTRIBUTION } from "./ortho.ts";
export type {
  Area,
  AreaKind,
  Building,
  Entrance,
  GeoBox,
  LampMount,
  MapFeatures,
  Opening,
  Rail,
  Road,
  RoofShape,
  StreetLamp,
  Tree,
  TreeKind,
  WindowStyle,
} from "./osm.ts";
export { isValidGeoPoint, LocalProjection, type GeoPoint } from "./projection.ts";
export { TAMPERE_ATTRIBUTION, TAMPERE_TREES_ATTRIBUTION } from "./tampere.ts";
export { tileName, tileRect, type Heights, type Tile, type TileKey } from "./tiles.ts";
