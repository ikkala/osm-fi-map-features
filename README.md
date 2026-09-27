# osm-fi-map-features

Map features for a 3D map of a Finnish city, in meters around an origin point and a square tile at a time:
roads, rails, buildings (with 3D parts, roofs, windows and entrances), trees and ground areas from
[OpenStreetMap](https://www.openstreetmap.org/), combined with Finnish open data:

- the ground heights of the [National Land Survey of Finland](https://www.maanmittauslaitos.fi/en)'s
  (Maanmittauslaitos, MML) 2 m elevation model, for tile heights, bridge decks and where buildings stand, and
  roof colours from its orthophoto (needs a free API key from https://omatili.maanmittauslaitos.fi)
- in Tampere, storeys, facades and building classes from the City of Tampere's
  [building register](https://data.tampere.fi/data/dataset/tampereen-rakennukset) and street and park trees
  from its tree register.

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
  // south, west, north, east: every tile touching this box is part of the map
  area: { south: 61.488, west: 23.725, north: 61.512, east: 23.795 },
  tileSizeM: 250,
  // the sources' responses are kept here, one file each
  cache: fileCache(".cache"),
  mmlApiKey: process.env.MML_API_KEY,
});
const info = await builder.info(); // tiles, OSM timestamp, attributions
for (const key of info.tiles) {
  const tile = await builder.tile(key); // roads, rails, buildings, areas, trees, heights
}
```

Coordinates are meters east (first) and north (second) of the origin. Tile `x, y` covers east `x * size ..
(x + 1) * size` and north `y * size .. (y + 1) * size`. Roads, rails and areas are cut at tile edges; a
building belongs whole to the tile its centroid is in and a tree to the tile of its trunk. The types are in
`src/osm.ts` (`MapFeatures`, `Building`, ...) and `src/tiles.ts` (`Tile`, `Heights`).

### Sources and the cache

Each source's responses are cached apart from the others in a `SourceCache` (`get` and `put` of text by key),
and the map is only combined from them when it is built. `fileCache(dir)` keeps a file per key and
`memoryCache()` keeps them in memory; anything else (e.g. object storage) is a `SourceCache` of your own.
`refresh: true` fetches everything again. The keys name the source and a hash of the request:
`overpass-*.json`, `mml-elevation-*.asc`, `tampere-buildings-*.json`, `tampere-trees-*.json`, and
`mml-roof-colours.json` (the colours worked out from the orthophoto by outline; the images are not kept).

The Overpass server is `https://overpass-api.de/api/interpreter` unless `overpassUrl` is given; mind its
[usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).

For now the first tile asked for builds the whole area and the rest come from memory: bridge spans, tunnels in
cuts and multipolygons reach over tile edges, so they are worked out over the whole area. The API is a tile at
a time so that this can change without changing its users.

## How the map is built

A building with parts is drawn by its parts. A part that starts above the ground (`min_height`,
`building:min_level`) with no other part under it, such as the planetarium on the second floor of Särkänniemi's
building, gets its building filled in under it as the outline, unless it is a balcony, roof, canopy or the like or
a way runs under it (an arcade or a passage).

Buildings without `height` or `building:levels` in OSM get their storeys from the City of Tampere's
[building register](https://data.tampere.fi/data/dataset/tampereen-rakennukset) (a point per building, matched to
the OSM outline it is in; empty outside Tampere), which also gives most buildings their facade material (brick,
concrete, wood, ...) unless OSM has `building:material`. The rest get a guess: one storey for sheds and anything
under 40 m², two for houses and anything under 150 m², three otherwise.

How OSM and the register compare (September 2026, the 1 143 outlines drawn without parts that have both
`building:levels` and register storeys): 57 % agree, 20 % have one storey fewer in OSM and 18 % one more, 5 % differ
by two or more. The one-storey differences are mostly the attic of a pitched roof: in old buildings with one (160
wooden ones before 1940), the register counts it as a storey about half the time, and OSM then has it in
`roof:levels`; adding that leaves 2 % with fewer storeys in OSM. The import already counts `roof:levels`, as roof
height, so the register would not make such buildings taller. The large differences are mostly register points
of a tall building that fall into a low wing drawn as its own outline (Rongankatu 7: 1 vs 11), so taking the
register's storeys over OSM's would do harm; a few look like errors in OSM (Kankurinkatu 4–8: 4 vs 6), better fixed
there. Old buildings still come out low, e.g. Tampereen ensimmäinen postitalo by Finlayson (1867, one storey and a
hipped roof storey, 6 m): every storey is 3 m while 19th-century ones are more like 3.5–4 m (the register's
completion year, `C_VALMPVM`, is not imported yet).

On a slope a building stands at its highest ground, so its entrance on the uphill side is not in the hill, and its
walls reach down to its lowest ground: a plinth or a basement storey on the downhill side, with windows in it. On a
steep slope it stands at most 6 m above its lowest ground. The build takes the ground from the elevation model
along the outline (`base` in the tiles); a building's parts all stand at the building's base, so they line up.
Without an elevation model buildings stand at their lowest ground.

Roofs are flat unless OSM has a pitched `roof:shape`, drawn as gabled (also saltbox, gambrel, round), hipped (also
half-hipped, mansard), pyramidal (also cone, dome) or skillion. Houses, cabins, sheds, garages, barns, saunas and
churches, and `building=yes` / `residential` of at most 150 m² and two storeys, get a guessed gabled roof when their
outline is nearly a rectangle. The ridge runs along the outline's long side unless `roof:orientation=across`; a
skillion roof slopes down to `roof:direction`. The roof's height is `roof:height` or `roof:levels`, else a 27°
slope (10° for skillion, at most 6 m): on top of the storeys, or within a tagged `height`, taking at most half of it.

Ways through buildings (`tunnel=building_passage`) are drawn on the ground like other ways, and open the walls
they cross: as wide as the way (wider where it crosses at a slant, and on over nearly straight corners) and as
tall as its `maxheight`, else 4 m for vehicles and 3 m for people, leaving at least 0.5 m of wall under the eaves.
Passages are often tagged `tunnel=yes` or `covered=yes` instead: such a way is taken for a passage when it is at
most 60 m long and not deeper than `layer=-1`, neither end is more than 1 m inside a building, and at least half
of it is inside buildings.

Neither OSM nor the register has windows, so ordinary buildings get guessed ones: a row per storey (from
`building:levels` or the register's storeys, else about every 3 m) and spaced by the kind of building. Houses get
windows 4 m apart, blocks of flats and hotels 2.8 m, and offices, shops and schools a band of windows 1.6 m apart.
The kind comes from `building=*`; for `building=yes` the register's building class (`C_RAKENNUSLUOKKA`) decides, and
a `building:part=yes` gets the windows of the building it is in. Other buildings (churches, sheds, factories,
halls, ...) and glass walls get no windows, and neither do storeys under 2.2 m or over 6 m tall. Nor do buildings
tagged as something special whatever their `building=*` (`man_made=*` such as towers and chimneys,
`amenity=place_of_worship`, `historic=*` other than `building`, `tourism=attraction` or `museum`) and the parts in
them, or buildings over five times taller than their longest side (towers that are not tagged so); Näsinneula is
`building=yes` with `man_made=tower`.

Street and park trees come from the City of Tampere's tree register (WFS layer `locus:locus_t_RpaVegetation_gsview`
at `geodata.tampere.fi`, a point per tree with its species, height class and trunk circumference; about 12 500
around the centre, nearly all trees, few shrubs). The height is the middle of the height class, else a guess from
the trunk (3 m + 0.35 × its diameter in cm, at most 25 m). OSM's `natural=tree` and `natural=shrub` nodes and
`natural=tree_row` ways (a tree every 8 m or less) are added where the register has no tree within 4 m. Woods
(`natural=wood`, `landuse=forest`) and scrub (`natural=scrub`) are only areas in OSM, so the import plants them,
far sparser than real woods since every tree costs something to draw: a tree in each 9 m cell of a grid (spruce, pine
or birch, 10–26 m), leaving 15 % of the cells empty, and in scrub mostly shrubs in 5 m cells. A plant keeps 2.5 m
from others and clear of buildings, roads, rails, water, parking and pitches. Where it stands and what it is come
from its grid cell alone, so every build plants the same trees. Around the centre of Tampere that is some 20 000
trees, at most about 530 in a 250 m tile.

## Licences

The code is under the [MIT licence](LICENSE).

The data it builds is not:

- OpenStreetMap data is © OpenStreetMap contributors, under the
  [Open Database License](https://www.openstreetmap.org/copyright) (ODbL). The features built here are OSM data
  altered and combined with other data, a Derivative Database in ODbL terms: when you make it, or something
  produced from it such as a rendered map, public, you must credit OpenStreetMap and offer the database, or the way it
  was made, under the ODbL. This package is that way for maps built with it; say which commit you used.
- Elevation model and orthophoto © Maanmittauslaitos, building and tree registers © City of Tampere, all under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit them.

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
