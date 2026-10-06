export { MapBuilder, DEFAULT_OVERPASS_URL, OSM_ATTRIBUTION, type Logger, type MapInfo, type MapOptions } from "./builder.ts";
export { BUILDING_REGISTER_ATTRIBUTION } from "./buildingRegister.ts";
export { fileCache, memoryCache, type SourceCache } from "./cache.ts";
export { ELEVATION_ATTRIBUTION } from "./elevation.ts";
export { FINNISH_DEFAULTS_MEASURED_IN_TAMPERE, type MeasuredDefaults } from "./measuredDefaults.ts";
export { FAR_CLASSES, farTile, type FarBox, type FarClass, type FarOptions, type FarTile } from "./far.ts";
export {
  estimateMotorTraffic,
  FLOW_REACH_M,
  pullFlows,
  type FlowCount,
  type FlowMode,
  type FlowRoad,
  type RoadFlows,
} from "./flows.ts";
export { triangulate, type Point, type Polygon, type Rect, type Ring } from "./geometry.ts";
export { ORTHO_ATTRIBUTION } from "./ortho.ts";
export type {
  Area,
  AreaKind,
  Barrier,
  BarrierKind,
  BridgeDeck,
  Building,
  BuildingUse,
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
  PlayEquipment,
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
export { ROOF_TOP_SOURCES, TAMPERE_ROOF_TOPS, type RoofTopSource } from "./roofTops.ts";
export { TAMPERE_TREE_REGISTER, TREE_REGISTERS, type TreeRegisterSource } from "./treeRegister.ts";
export { tileName, tileRect, type Heights, type Tile, type TileKey } from "./tiles.ts";
export type { Waterway, WaterwayKind } from "./waterways.ts";
