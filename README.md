# osm-fi-map-features

Map features for a 3D map of a Finnish city, in meters around an origin point and a square tile at a time:
roads, rails, buildings (with 3D parts, roofs, windows, entrances and the businesses in them), trees, street
lamps, crossings, traffic signals, gates, fences and walls, playground equipment, bicycle parking, landmarks (lighthouses and other
seamarks with their lights, masts, flagpoles, boulders, fountains, artworks, memorials, piers, dams, amusement
rides, power lines and ski tracks), and ground areas from
[OpenStreetMap](https://www.openstreetmap.org/), combined with Finnish open data:

- the ground heights of the [National Land Survey of Finland](https://www.maanmittauslaitos.fi/en)'s
  (Maanmittauslaitos, MML) 2 m elevation model, for tile heights, bridge decks and where buildings stand, roof
  colours from its orthophoto and roofs from its laser scanning (needs a free API key from
  https://omatili.maanmittauslaitos.fi)
- storeys, facades, frames, uses and completion years from the Finnish building register, which the Finnish
  Environment Institute (Syke) publishes for the whole country in
  [Ryhti](https://ryhti.syke.fi/palvelut/palvelut-tiedon-hyodyntajille/)
- street and park trees from the tree registers of the cities that publish theirs (for now Tampere)
- the measured heights of roofs from the 3D building parts of the cities that publish theirs (for now Tampere).

It is published so that how a map is made from OpenStreetMap with it is available to everyone, as the ODbL asks
of a map that is made public (see [Licences](#licences)).

## Use

Node.js 24 or newer. Not in the npm registry: install it from GitHub at a commit,

```sh
npm install github:ikkala/osm-fi-map-features#<commit>
```

which builds `dist/` on install.

```ts
import { fileCache, MapBuilder } from "osm-fi-map-features";

const builder = new MapBuilder({
  origin: { latitude: 61.4981, longitude: 23.7610 },
  // south, west, north, east: every tile touching this box is part of the map; or a list of boxes, overlapping or not,
  // for a map of another shape: every tile touching one of them
  area: { south: 61.488, west: 23.725, north: 61.512, east: 23.795 },
  tileSizeM: 250,
  // optional: fetch the sources in pieces of up to this many tiles a side (see below)
  // fetchPieceTiles: 20,
  // the sources' responses are kept here, one file each
  cache: fileCache(".cache"),
  mmlApiKey: process.env.MML_API_KEY,
  // optional: the tree registers to use, of those whose area the map reaches into (TREE_REGISTERS by default)
  // treeRegisters: [TAMPERE_TREE_REGISTER],
  // and the 3D building parts to take roof heights from (ROOF_TOP_SOURCES by default)
  // roofTops: [TAMPERE_ROOF_TOPS],
  // and a correction of the elevation model's heights where the ground has changed since it was scanned (a building
  // site's heap levelled): everything that takes heights from the model takes the corrected ones
  // groundCorrection: await readLevelledGround(createReadStream("ground.osm"), origin),
  // and tunnels' floors known at points, from plans or surveys (the way's surface, m in N2000)
  // tunnelFloors: await readTunnelFloors(createReadStream("tunnels.json")),
  // and local edits of the OSM data not uploaded yet, OSM XML as an editor such as JOSM saves it (see below)
  // edits: await readOsmEdits([createReadStream("a.osm"), createReadStream("b.osm")]),
  // and only some of the tiles, with the features near them (see below)
  // part: { tiles: [{ x: 1, y: -4 }, { x: 1, y: -3 }], marginM: 1000 },
});
const info = await builder.info(); // tiles, OSM timestamp, attributions
for (const key of info.tiles) {
  const tile = await builder.tile(key); // roads, rails, buildings, areas, trees, lamps, crossings, signals, gates, barriers, playEquipment, bridgeDecks,
  // seamarks, landmarks, piers, dams, rides, powerLines, pistes, bicycleParkings, pitches, waterways, heights

}
```

Coordinates are meters east (first) and north (second) of the origin. Tile `x, y` covers east `x * size ..
(x + 1) * size` and north `y * size .. (y + 1) * size`. Roads, rails and areas are cut at tile edges; a
building belongs whole to the tile its centroid is in, a tree to the tile of its trunk, a lamp to the tile of
its foot and a piece of playground equipment, a bicycle parking, a landmark or a pitch's box to the tile of its middle; landmarks drawn as lines
(piers, dams, rides' courses, power lines, pistes) are cut at tile edges. The types are in
`src/osm.ts` (`MapFeatures`, `Building`, ...), `src/landmarks.ts`, `src/seamarks.ts`, `src/rides.ts`, `src/pitches.ts` and
`src/tiles.ts` (`Tile`, `Heights`).

### Sources and the cache

Each source's responses are cached apart from the others in a `SourceCache` (`get` and `put` of text by key),
and the map is only combined from them when it is built. `fileCache(dir)` keeps a file per key and
`memoryCache()` keeps them in memory; anything else (e.g. object storage) is a `SourceCache` of your own.
`refresh: true` fetches everything again. The keys name the source and a hash of the request:
`overpass-*.json`, `mml-elevation-*.asc`, `ryhti-buildings-*.json` (a page each), `tampere-trees-*.json` (a tree
register's `name`), `tampere-roof-tops-*.json` (a layer of 3D building parts by its `name`), and
`mml-roof-colours-<e>_<n>.json` (the colours worked out from the orthophoto by outline, a file per square of the
photo, so maps of different places keep theirs; the images are not kept), and `mml-laser-roofs-<sheet>.json` (the
roofs worked out from the laser scanning by outline, a file per map sheet; the point clouds are not kept).

`edits` (`parseOsmEdits` of an OSM XML file) shows edits of the OSM data in the map before they are uploaded: the
elements the file marks `action="modify"` take its tags (and its geometry when the file has a way's nodes; a way whose
node moved is edited too), those marked `action="delete"` are left out, and new ones (negative ids) are added to the
map's features and landmarks (not to its entrances or businesses), and so is a node the file tags that the fetched data lacks
(a way's vertex that had no tags). A relation's edit changes only its tags (its members
are kept) or leaves it out; new relations are not supported. Once uploaded,
the edits are in the fetched data anyway and the file can go.

The sources are asked for a box around all the map's tiles, unless `fetchPieceTiles` is given: then for each piece of
the map, a square of that many tiles a side on a grid from tile `0, 0`, a box around the map's tiles in it. No request
then grows with the map, nor asks for what lies between its parts, and a piece's responses stay cached while the map
changes elsewhere. The pieces' responses are put together as one: an Overpass element in several of them (a way
across a piece's edge) once, in Overpass' order, so that the map comes out as from one request; a register's entries
alike once; and the elevation model's heights from a piece's grid, where it has the cells all around the point.

The Overpass server is `https://overpass-api.de/api/interpreter` unless `overpassUrl` is given; mind its
[usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).

For now the first tile asked for builds the whole area and the rest come from memory: bridge spans, tunnels
and multipolygons reach over tile edges, so they are worked out over the whole area. The API is a tile at
a time so that this can change without changing its users.

`part` builds only some of the tiles, much faster, to try a change on a few of them: the sources are asked for the
whole area as without it (so the cached responses serve), and of what they give only the elements and register
entries reaching within `marginM` of those tiles are kept, each whole, and the tunnels' ways wherever they are,
since a network's floors are worked out from end to end. The tiles come out as in the whole map unless something
else they depend on reaches farther than that, such as a river levelled along its course. `info().tiles` still
lists the whole map's tiles; `tile()` gives only those built.

## How the map is built

How each feature is made from its tags, the registers and the elevation model is in its module's comments in `src/`,
and what a tile's fields hold in the types (`src/osm.ts` and the modules it names). Where to look:

- Buildings (`src/osm.ts`): which are left out under the ground, the filling under parts raised off it, heights from
  `height`, storeys or the kind of building, guessed roofs, passages through buildings and their rooms, materials,
  colours and surfaces. With them `src/buildingRegister.ts` (storeys, materials, uses and years from Ryhti),
  `src/startDates.ts` and `src/ages.ts` (when a building was built, and its storeys' height then), `src/bases.ts`
  (where a building stands on a slope), `src/roofRidges.ts` (roofs drawn by their ridge lines), `src/roofTops.ts`
  and `src/laserScanning.ts` (measured roof tops, brought down to the laser-scanned roof), `src/laserRoofShapes.ts` and `src/roofWings.ts`
  (roof shapes from the laser scanning's points), `src/gambrelRoofs.ts` (gambrel roofs among them), `src/measuredParts.ts`
  (an outline split into the measured parts' heights), `src/ortho.ts` (roof
  colours), `src/windows.ts`, `src/entrances.ts` and `src/businesses.ts` (the businesses in a building and where
  each shows), `src/raisedPassages.ts` (passages on a bridge's deck).
- The ground where the elevation model's 2 m grid smooths a step: `src/retainingWalls.ts`, `src/flights.ts` (steps
  up an edge) and `src/buildingSteps.ts` (a building cut into a slope).
- Tunnels: `src/tunnels.ts` (floors, rooms, ramps at the portals, floors known at points: `tunnelFloors`) and
  `src/cuts.ts` (a shallow tunnel the model has as an open cut, under a lid).
- Bridges: `src/bridges.ts` (decks of spans and boardwalks, and steps telling a deck's height), `src/decks.ts`
  (bridge outlines as decks), `src/underbridges.ts` (ways under a deck), `src/stairs.ts` (staircases' landings).
- Railways and tramways: `src/trackbeds.ts`; platforms `src/platforms.ts`; pitches and level paved areas
  `src/pitches.ts`.
- Trees `src/forests.ts` and `src/treeRegister.ts`, street lamps `src/lamps.ts`, crossings, traffic signals and
  gates `src/streets.ts`, fences and walls `src/barriers.ts`, playground equipment `src/playgrounds.ts`, bicycle
  parking `src/bicycleParking.ts`, landmarks `src/landmarks.ts`, `src/seamarks.ts` and `src/rides.ts`.
- People walking and cycling along each way (`footfall`, `cycling`): `src/footfall.ts`, with its constants in
  [Measured in Tampere](#measured-in-tampere).

### Water

Water areas still or flowing, their level, and the tiles' `waterways`: `src/waterways.ts`. The elevation model has
the water's surface, uneven where an area takes in its banks, so a still water is set level and a flowing one falls
along the OSM waterways in it, never rising downstream.

### Flows

`pullFlows(roads, others, counts)` (`src/flows.ts`) gives how many walk, cycle and drive along roads on an average
day of the year: the map's footfall and cycling, and motor vehicles by the kind of road (`estimateMotorTraffic`),
each pulled towards counts at points. It is for a user that has counts, such as a city's traffic counts, and
combines them with the map when it uses it instead of building them into the map, so the counts stay a database of
their own and can be updated without building the map again.

### Seen from afar

`farTile(tile, tileSize)` (`src/far.ts`) sums a tile up for drawing it from afar, where its full features would be far
too many: a coarse picture of what covers the ground (`cover`, by `FAR_CLASSES`), coarse heights, and every building
as a box.

### Parts of streets and lakes

`streetParts(roads, name, near)` and `lakeParts(areas, near)` (`src/featureParts.ts`) tell where on a long street or a
wide lake a point is (a street's ends, a lake's shores, by compass direction), for a user with places of their own
(a name and a point each) to match to the map when it uses them. Each gives the pieces it matched, so that a user
reading the map a tile at a time can tell whether the feature goes on into tiles not read yet.

### Districts

A city's districts are not in the tiles: they are large, and cities map them differently. `fetchDistricts(box,
origin, options)` (`src/districts.ts`, cached as the map's other sources are) reads its administrative divisions
below the municipality and its places of a district's kinds (`DISTRICT_KINDS`); `districtOf` gives the district a
point is in, and `districtKindOf` the kind a city's districts are mapped as.

## Measured in Tampere

Some constants could only be measured from one city's open data, Tampere's. They are kept together in
`FINNISH_DEFAULTS_MEASURED_IN_TAMPERE` (`src/measuredDefaults.ts`, exported) and used on purpose for every Finnish
city, until there is data of another city's own to measure them from:

- `footfallModels`: the base and scale of people walking and cycling, fitted to the city's pedestrian and cycling counts
- `vehiclesByRoadKind`: motor vehicles a day by `highway=*`, from the city's motor traffic counts
- `stairSpacingM`: 18 m between the staircases of a block of flats, from the staircases mapped in OSM
- `officeLevels`: 4 storeys, from which a building of the register's offices-and-factories class is offices, from the
  city's own building register
- `pitchedRoofsBefore` and `flatRoofRiseM`: buildings built before 1960 mostly have pitched roofs, and a top at most
  3 m over the eaves is a flat roof's, from the city's 3D building parts (`src/roofTops.ts`): of the buildings without
  `roof:shape` whose storeys are known, those of the 1920s to the 1950s rise a median 2.1–3.0 m over their storeys
  and about half of them more than 3 m, those of the 1960s to the 2010s 0.6–1.8 m and 12–22 % of them more than 3 m
  (machine rooms on flat roofs)
- `chimneyHeight` and `chimneyMaterial`: an untagged chimney 12 times as tall as its base is wide (at most 100 m)
  and brick, from the city's chimneys
- `oldStoreys`: 3.5 m storeys before 1946, 3 m since, from the city's building register and 3D building parts:
  `npm run measure-storeys -- <cache dir> [<year> ...]` (`scripts/measureStoreys.ts`, `src/storeyHeights.ts`) reads
  a map's cached sources and fits, for the buildings whose storeys (OSM's, else the register's), year (OSM's, else the
  register's) and roof top over the ground are known (houses, halls, sheds and churches left out, one register point
  in the outline), the median height of each storey count from 2 up to a line: the rise of the roof and the plinth
  plus the storeys times the storey's height, with a 90 % interval by resampling the buildings. Measured on Tampere's
  sources of October 2026 (6,100 buildings): 3.46 m (90 %: 3.13–3.72) from 1920 to 1945 (490 buildings), 3.06 m
  (2.97–3.16) from 1946 to 1959 and 2.95 m (2.92–2.98) since 1960; from before 1920 only 67 buildings, too few
  (2.92–7.29), so they take the next era's

## Licences

The code is under the [MIT licence](LICENSE).

The data it builds is not:

- OpenStreetMap data is © OpenStreetMap contributors, under the
  [Open Database License](https://www.openstreetmap.org/copyright) (ODbL). The features built here are OSM data
  altered and combined with other data, a Derivative Database in ODbL terms: when you make it, or something
  produced from it such as a rendered map, public, you must credit OpenStreetMap and offer the database, or the way it
  was made, under the ODbL. This package is that way for maps built with it; say which commit you used.
- Elevation model, orthophoto and laser scanning © Maanmittauslaitos, the building register © Finnish Environment Institute Syke
  (Ryhti), and a tree register and 3D building parts © their city (Tampere), all under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit them.
- Flows pulled towards counts (`pullFlows`) are OSM roads combined with the counts: a Derivative Database under the
  ODbL however briefly they exist, whether they are stored or worked out when they are used, and `flows.ts` is the
  way they are made. Credit the counts' source too. The counts themselves are not changed by it and stay under
  their own terms.
- Places matched to the map's streets and lakes (`streetParts`, `lakeParts`), and the parts found for them, are
  likewise a Derivative Database under the ODbL, stored or not, and `featureParts.ts` is the way they are made. The
  places themselves stay under their own terms.
- Points matched to the districts (`districtOf`, `districtKindOf`) are a Derivative Database under the ODbL too,
  stored or not, and `districts.ts` is the way they are made. The points themselves stay under their own terms.

`MapInfo.attributions` lists the credits for the data a build used.

## Development

```sh
npm install
npm test          # unit tests, Node's test runner on the .ts sources
npm run typecheck
npm run build     # dist/
```

Node runs the `.ts` sources directly by stripping the types, so only erasable TypeScript syntax is used; the
build is only for installing it as a dependency, since Node does not strip types under `node_modules`.
