# osm-fi-map-features

Map features for a 3D map of a Finnish city, in meters around an origin point and a square tile at a time:
roads, rails, buildings (with 3D parts, roofs, windows, entrances and the businesses in them), trees, street
lamps, crossings, traffic signals, gates, fences and walls, and ground areas from
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
  const tile = await builder.tile(key); // roads, rails, buildings, areas, trees, lamps, crossings, signals, gates, barriers, heights
}
```

Coordinates are meters east (first) and north (second) of the origin. Tile `x, y` covers east `x * size ..
(x + 1) * size` and north `y * size .. (y + 1) * size`. Roads, rails and areas are cut at tile edges; a
building belongs whole to the tile its centroid is in, a tree to the tile of its trunk and a lamp to the tile of
its foot. The types are in
`src/osm.ts` (`MapFeatures`, `Building`, ...) and `src/tiles.ts` (`Tile`, `Heights`).

### Sources and the cache

Each source's responses are cached apart from the others in a `SourceCache` (`get` and `put` of text by key),
and the map is only combined from them when it is built. `fileCache(dir)` keeps a file per key and
`memoryCache()` keeps them in memory; anything else (e.g. object storage) is a `SourceCache` of your own.
`refresh: true` fetches everything again. The keys name the source and a hash of the request:
`overpass-*.json`, `mml-elevation-*.asc`, `tampere-buildings-*.json`, `tampere-trees-*.json`,
`tampere-counts-*.json`, and
`mml-roof-colours.json` (the colours worked out from the orthophoto by outline; the images are not kept).

The Overpass server is `https://overpass-api.de/api/interpreter` unless `overpassUrl` is given; mind its
[usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).

For now the first tile asked for builds the whole area and the rest come from memory: bridge spans, tunnels
and multipolygons reach over tile edges, so they are worked out over the whole area. The API is a tile at
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
Without an elevation model buildings stand at their lowest ground. A building over a tunnel in a cut (see below)
stands at least at the top of the tunnel's lid, since it really stands on the deck over the cut, and so does an open
roof over a lid (a platform's roof), which otherwise stands on its lowest ground.

Roofs are flat unless OSM has a pitched `roof:shape`, drawn as gabled (also saltbox, gambrel, round), hipped (also
half-hipped, mansard), pyramidal (also cone, dome) or skillion. Houses, cabins, sheds, garages, barns, saunas and
churches, and `building=yes` / `residential` of at most 150 m² and two storeys, get a guessed gabled roof when their
outline is nearly a rectangle. The ridge runs along the outline's long side unless `roof:orientation=across`; a
skillion roof slopes down to `roof:direction`. The roof's height is `roof:height` or `roof:levels`, else a 27°
slope (10° for skillion, at most 6 m): on top of the storeys, or within a tagged `height`, taking at most half of it.

Ways through buildings (`tunnel=building_passage`) are drawn on the ground like other ways, and open the walls
they cross: as wide as the way (wider where it crosses at a slant, and on over nearly straight corners) and as
tall as its `maxheight`, else 4 m for vehicles and 3 m for people, leaving at least 0.5 m of wall under the eaves.
A building is only its walls and roof, so the way also gets a room through it (`passageRooms`): walls along its
sides from opening to opening (mitred at its corners, and across its end where it ends inside) and a ceiling at
the opening's height. Where ways beside or across each other meet inside, their rooms are one space.
Passages are often tagged `tunnel=yes` or `covered=yes` instead: such a way is taken for a passage when it is at
most 60 m long and not deeper than `layer=-1`, neither end is more than 1 m inside a building, and at least half
of it is inside buildings.

Other tunnels get heights from the elevation model, which has the bare ground over them. A tunnel (`layer` -1 or above)
whose ground rises nowhere more than 3 m over its ends runs at the ground under something built over it, which the
model leaves out: a railway anywhere (the tracks under Tampere's Kansi and its arena), a road or path when at least
half of it is under buildings (not open roofs; under a street or a railway the model has their level, not the
tunnel's). It becomes a way on the ground, the walls of buildings over it open for it (as tall as a tunnel's room,
below), an open roof over it is raised over that room, and so is the underside of a building raised off the ground
(`min_height`), its top where it was. Over a railway every building starts over the room (it stands on a deck over
the tracks), and an open roof becomes a deck 1 m thick over it, without posts. A building is over a way where the
way's room, 1 m wider than the way on both sides, is under it. A shallow tunnel
(`layer` -1 or above) that the model has as an open cut, the ground beside it at least 3 m higher on both sides
along most of it (an underpass under a deck), gets the top of a lid over it at the rim of the cut (`lid`, at
least 3.5 m and the lid's 1 m over the floor), and the ways over it become bridges. A tunnel beside it (within 2 m of
the lid along most of it, such as a pavement beside a tramway) is in the same cut, under the same lid. Any other tunnel, under a
hill or a lake, gets its floor (`floor`, with a point every 10 m): straight between its portals' ground (the
lowest within 4 m outside, since at the portal the model has the top of its wall), a junction underground
hanging between its branches' ends by distance, but at least room and a 1 m roof under the ground (3 m of
room for people, 4.8 m for vehicles, 6 m for trains; reached 30 m in from a portal; under water areas 3 m more, since the model has the water's surface) and no
steeper than 7 %.
Where the ground at a portal (the top of its wall) is over the floor, a ramp is split off each way leading on, with
a `floor` of its own: straight from the portal's floor to where a 7 % slope from it meets the ground, at most 40 m
on.

Railways (not tramways) that are not bridges or tunnels get a track bed (`bed`): the elevation model has
platform edges, underpass roofs and the like under the tracks, a metre up and down every few metres, so the bed is
the ground averaged over 30 m along the line, never more than 0.5 m under the ground right under it. Where lines
meet, their beds end at the same height: the ground averaged within 10 m, or the deck of a bridge ending there.

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

Street lamps are OSM's `highway=street_lamp` nodes (about 2 100 around the centre of Tampere). Their mount comes
from `lamp_mount` or `support`, or is a catenary mast (`power=catenary_mast`, such as a tram's); in Tampere a tenth
have one, and none a `height` or a `direction`. A lamp without them faces the nearest street within 15 m, else the
nearest path within 8 m, and is 10 m tall by a main street (secondary and up), 8 m by another street and 5 m by a
path or nothing (high masts 20 m, catenary masts 8 m). A lamp on a bridge stands on its deck.

Crossings, traffic signals and gates are nodes of the ways they are on (`src/streets.ts`): a crossing
(`highway=crossing`) is on the street and on the footway across it, so it and a traffic signal
(`highway=traffic_signals`) are put on the nearest street (not a footway or a path) within 1 m, with the street's
direction there, kind, width and deck height; a gate (`barrier=gate`) spans the way it is on, or else lies in its
fence or wall, 1.2 m wide unless tagged. Only crossings with markings are kept: not `crossing=unmarked` or
`crossing:markings=no`, and of the markings only stripes (`zebra`, `yes`, ...). A traffic signal's
`traffic_signals:direction` (forward or backward along the way) tells which traffic it is for. Around the centre of
Tampere there are about 1 100 painted crossings, 200 signals and 200 gates on their ways.

Fences, walls, retaining walls and hedges (`barrier=*` ways, about 1 000 around the centre) get OSM's `height`, or
1.2 m for fences and hedges, 1.5 m for walls (3 m for noise barriers) and 1 m for retaining walls, and their
`fence_type`, `material` or `wall` as a material. A path through a fence often has no gate or opening in OSM, so
each barrier is cut open where a way (not a bridge or a tunnel) crosses it, 0.4 m wider than the way, and at its
gates (`src/barriers.ts`).

Businesses (`Building.businesses`) are the OSM elements with `shop`, `office`, `craft` or `healthcare`, or with an
`amenity`, `tourism` or `leisure` value that is a business (restaurants, cafes, pharmacies, banks, cinemas, hotels,
museums, gyms, ...; not benches, parking or parks), with their `name`, `brand`, `cuisine` and lowest `level`.
Around the centre of Tampere there are about 1 400, nearly all named. They are mostly points inside a building, so
each goes to the building (or the part on the ground) its point is in, or it is tagged on, or whose wall is within
2 m; the rest are left out. OSM seldom has their doors, so where a business shows (`front`: a point on the outline
and the direction out of the wall) is a guess: an `entrance=shop` or `restaurant` within 20 m of it, else a
`main` or `yes` entrance within 8 m, else the nearest wall within 20 m that faces a street (one within 25 m out in
front) and is not against another building, else the nearest such wall facing no street. The shops inside a
building tagged `shop=mall` show only at their own doors. Businesses often share a door or a spot, so the fronts of a
building are then moved apart along their wall, 6 m from each other (those at doors stay), and a front that finds
no room on its wall is dropped. Around the centre of Tampere 77 % of the businesses in buildings get a front, a
tenth of them at a door.

Every way people walk on gets `footfall`: how many walk along it on an average day of the year, both directions
together (on both sidewalks of a street), at each point of its line. Streets have `sidewalks` from `sidewalk=*`,
`sidewalk:both`, `sidewalk:left` and `sidewalk:right` (both, left, right, none or separate), and walkways their
`footway=*` (sidewalk, crossing, ...). No one walks on a street whose sidewalks are `none` or `separate` or run
beside it as `footway=sidewalk` ways for half its length (in central Tampere about 600 streets), on motorways, trunk
roads and links unless they have a sidewalk tagged, or on roads in tunnels. Elsewhere footfall is estimated as
`kind × (base + scale × draw)`: `draw` adds up the businesses near the point (restaurants and cafes 1.5, shops 1,
offices 0.5, others 0.7; falling off to nothing at 200 m) and the other doors (0.15 each, to nothing at 120 m), and
`kind` is 1.6 on pedestrian streets, 1 on footways, cycleways and main streets, 0.8 on residential streets, 0.6 on
steps and unclassified roads, 0.35 on paths, 0.3 on service roads and 0.2 on tracks.

Where there are counts, `base` and `scale` are fitted to them and the estimate around each count is pulled towards
it, fading out 80 m away: at a count its way gets about the count (the counts near each other averaged), and so do
the ways of its name and the walkways of its kind in line with it (OSM cuts a sidewalk into many unnamed pieces);
other ways get a third of the pull. Tampere's are the city's
[pedestrian and cycling counts](https://data.tampere.fi/data/dataset/tampereen-jalankulun-ja-pyorailyn-liikennemaaria)
(WFS layer `liikenneverkot:liikennemaarat_jalankulku_pyoraily_counter_point_TM35`): the current results
(`tulos_vanhentunut=ei`) along ways (`JKPP`, `Koko poikkileikkaus`), a day's count or the afternoon peak hour's
(taken as 10.5 % of the day), each on the nearest way within 25 m. A count on one sidewalk of a street is doubled
for the street. A count is of one day, so it is divided by `FOOTFALL_MONTHS` and `FOOTFALL_WEEKDAYS` for its date
(a guess at how Nordic cities walk: winter months 0.85, summer 1.1, Sunday 0.75), and multiplying by them turns
footfall into a given day; `FOOTFALL_HOURS` spreads a weekday's or a weekend day's walking over its hours. Around
the centre of Tampere (September 2026) 432 counts fit `330 + 21 × draw`, which is also the default without counts,
and the estimate alone is within a factor of two of 54 % of them; pulled towards the counts, the counted ways are
within a factor of 1.5 of 84 %. Centre sidewalks get 2 000–9 500 a day, suburban footways a few hundred, paths
and service roads less.

## Licences

The code is under the [MIT licence](LICENSE).

The data it builds is not:

- OpenStreetMap data is © OpenStreetMap contributors, under the
  [Open Database License](https://www.openstreetmap.org/copyright) (ODbL). The features built here are OSM data
  altered and combined with other data, a Derivative Database in ODbL terms: when you make it, or something
  produced from it such as a rendered map, public, you must credit OpenStreetMap and offer the database, or the way it
  was made, under the ODbL. This package is that way for maps built with it; say which commit you used.
- Elevation model and orthophoto © Maanmittauslaitos, building and tree registers and pedestrian counts © City of
  Tampere, all under
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
