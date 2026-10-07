# osm-fi-map-features

Map features for a 3D map of a Finnish city, in meters around an origin point and a square tile at a time:
roads, rails, buildings (with 3D parts, roofs, windows, entrances and the businesses in them), trees, street
lamps, crossings, traffic signals, gates, fences and walls, playground equipment, and ground areas from
[OpenStreetMap](https://www.openstreetmap.org/), combined with Finnish open data:

- the ground heights of the [National Land Survey of Finland](https://www.maanmittauslaitos.fi/en)'s
  (Maanmittauslaitos, MML) 2 m elevation model, for tile heights, bridge decks and where buildings stand, and
  roof colours from its orthophoto (needs a free API key from https://omatili.maanmittauslaitos.fi)
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
  // south, west, north, east: every tile touching this box is part of the map
  area: { south: 61.488, west: 23.725, north: 61.512, east: 23.795 },
  tileSizeM: 250,
  // the sources' responses are kept here, one file each
  cache: fileCache(".cache"),
  mmlApiKey: process.env.MML_API_KEY,
  // optional: the tree registers to use, of those whose area the map reaches into (TREE_REGISTERS by default)
  // treeRegisters: [TAMPERE_TREE_REGISTER],
  // and the 3D building parts to take roof heights from (ROOF_TOP_SOURCES by default)
  // roofTops: [TAMPERE_ROOF_TOPS],
});
const info = await builder.info(); // tiles, OSM timestamp, attributions
for (const key of info.tiles) {
  const tile = await builder.tile(key); // roads, rails, buildings, areas, trees, lamps, crossings, signals, gates, barriers, playEquipment, bridgeDecks, waterways, heights
}
```

Coordinates are meters east (first) and north (second) of the origin. Tile `x, y` covers east `x * size ..
(x + 1) * size` and north `y * size .. (y + 1) * size`. Roads, rails and areas are cut at tile edges; a
building belongs whole to the tile its centroid is in, a tree to the tile of its trunk, a lamp to the tile of
its foot and a piece of playground equipment to the tile of its middle. The types are in
`src/osm.ts` (`MapFeatures`, `Building`, ...) and `src/tiles.ts` (`Tile`, `Heights`).

### Sources and the cache

Each source's responses are cached apart from the others in a `SourceCache` (`get` and `put` of text by key),
and the map is only combined from them when it is built. `fileCache(dir)` keeps a file per key and
`memoryCache()` keeps them in memory; anything else (e.g. object storage) is a `SourceCache` of your own.
`refresh: true` fetches everything again. The keys name the source and a hash of the request:
`overpass-*.json`, `mml-elevation-*.asc`, `ryhti-buildings-*.json` (a page each), `tampere-trees-*.json` (a tree
register's `name`), `tampere-roof-tops-*.json` (a layer of 3D building parts by its `name`), and
`mml-roof-colours-<e>_<n>.json` (the colours worked out from the orthophoto by outline, a file per square of the
photo, so maps of different places keep theirs; the images are not kept).

The Overpass server is `https://overpass-api.de/api/interpreter` unless `overpassUrl` is given; mind its
[usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).

For now the first tile asked for builds the whole area and the rest come from memory: bridge spans, tunnels
and multipolygons reach over tile edges, so they are worked out over the whole area. The API is a tile at
a time so that this can change without changing its users.

## How the map is built

A building with parts is drawn by its parts. A part that starts above the ground (`min_height`,
`building:min_level`) with no other part under it, such as the planetarium on the second floor of Särkänniemi's
building, gets its building filled in under it as the outline, unless it is a balcony, roof, canopy or the like or
a way runs under it (an arcade or a passage). A building without parts that starts above the ground with nothing
under it (a ground floor left out, `building:min_level=1` over shops on a street) comes down to the ground with its
storeys, unless it is a bridge, roof, canopy or the like, a way runs under it, or at least half of it is over lower
buildings (volumes mapped on top of each other).

Buildings without `height` or `building:levels` in OSM get their storeys from the Finnish building register
(`kerrosluku`), as Ryhti publishes it in the OGC API Features collection `avoimet_rakennukset` at
`paikkatiedot.ymparisto.fi` (a point per building, matched to the OSM outline it is in; demolished ones left out),
which also gives most buildings their facade material (brick, concrete, wood, ...; `julkisivumateriaali`) unless OSM
has `building:material` or `material`, the material of their load-bearing frame (`frameMaterial`: wood, brick, concrete
or steel; `kantavien_rakenteiden_rakennusaine`), also where the facade is not known, and their main use (`use`, see windows below). The rest get a guess: one storey for sheds
and anything under 40 m², two for houses and anything under 150 m², three otherwise. Chimneys, towers, water towers,
silos, tanks, gasometers and ventilation shafts (`man_made=*`) are buildings even without `building`. These and
churches, whose storeys say little about their height, are guessed by type from the base's longest side instead
(a chimney 12 times as tall, a water tower 1.3 times, a church 0.45 times, ..., see `HEIGHTS_BY_TYPE`), and the
register's storeys do not replace that. A chimney with no material in OSM or the register is taken for brick,
as Tampere's old factory chimneys are (see [Measured in Tampere](#measured-in-tampere)). The walls' colour is
`building:colour`, else `colour`, which towers and other `man_made=*` structures are tagged with. A tower of
`tower:construction=lattice` or `guyed_lattice` is a framework of bars (`lattice`), not a closed body, such as
Pispalan haulitorni, and so is the filler under a part on top of one. A roof's material is `roof:material`
(`roofMaterial`: roof_tiles, metal, copper, glass, grass, ...). A carport (`building=carport`) is an open roof on posts
as a canopy is (`shelter`), but stands at its highest ground as a building does, so a car fits under all of it on a
slope, and is not lifted over vehicles on a road under it. Parts without a frame or roof material take their outline's. Ways and ground areas
carry their `surface` (asphalt, paving_stones, fine_gravel, artificial_turf, clay, ...) when OSM has one.

The register used to come from the City of Tampere's own
[building register](https://data.tampere.fi/data/dataset/tampereen-rakennukset), which is the same national register.
Of its 21 932 buildings in and around Tampere (October 2026), Ryhti has 21 542 by the permanent building identifier,
with the same storeys in 99 % of those both have them and the same facade in nearly all; it has more completion
years (a real year where the city has 29 February 1904) and also has the neighbouring municipalities. Its use is
coarser: seven classes instead of some hundred.

How OSM and the register compare (September 2026, with the city's register, the 1 143 outlines drawn without parts that have both
`building:levels` and register storeys): 57 % agree, 20 % have one storey fewer in OSM and 18 % one more, 5 % differ
by two or more. The one-storey differences are mostly the attic of a pitched roof: in old buildings with one (160
wooden ones before 1940), the register counts it as a storey about half the time, and OSM then has it in
`roof:levels`; adding that leaves 2 % with fewer storeys in OSM. The import already counts `roof:levels`, as roof
height, so the register would not make such buildings taller. The large differences are mostly register points
of a tall building that fall into a low wing drawn as its own outline (Rongankatu 7: 1 vs 11), so taking the
register's storeys over OSM's would do harm; a few look like errors in OSM (Kankurinkatu 4–8: 4 vs 6), better fixed
there. Storeys are 3 m, but old buildings have taller ones: a building whose height is counted from its storeys
(`building:levels` or the register's) gets 3.6 m storeys when built before 1920 and 3.2 m before 1946, e.g. the
walls of Tampereen ensimmäinen postitalo by Finlayson (1867, one storey under a hipped roof) are 3.6 m tall, not 3.
The year (`year`) is `start_date` in OSM, else the register's completion date (`valmistumispaivamaara`; the
earliest of the points in an outline). The register has 29 February 1904 on outbuildings and holiday homes and 1
January 1900 on some others whose date is not known, both left out as unknown, and a few dates before 1700 are errors. A
`building:part` without a year gets the year of the building it is in, but keeps 3 m storeys, so that the parts
meet (a part higher up starts at a `building:min_level` counted at 3 m). It likewise gets the building's wall
material and colour, which mappers often tag on the outline only (Jyväskylä's Vesilinna: a brick outline, its
tower part untagged). A register point in a part goes to the outline around it, as the register describes the
whole building, and so reaches every part; a part in no outline still gets the points inside it.

On a slope a building stands at its highest ground, so its entrance on the uphill side is not in the hill, and its
walls reach down to its lowest ground: a plinth or a basement storey on the downhill side, with windows in it. On a
steep slope it stands at most 6 m above its lowest ground. The build takes the ground from the elevation model
along the outline (`base` in the tiles); a building's parts all stand at the building's base, so they line up.
Without an elevation model buildings stand at their lowest ground. A building over a tunnel in a cut (see below)
stands at least at the top of the tunnel's lid, since it really stands on the deck over the cut, and so does an open
roof over a lid (a platform's roof), which otherwise stands on its lowest ground; an open roof over a railway
platform stands on the platform's top (see below), though it reaches out over the tracks. A building or part raised off
the ground (`min_height`) with nothing under it, such as a canopy on a building that stands at its door down the
slope, counts its `min_height` from its own highest ground, so the rising ground does not come up to it; its top
stays, unless that would leave it thinner than a storey (or than it was).

Roofs are flat unless OSM has a pitched `roof:shape`, drawn as gabled (also saltbox, gambrel, round), hipped (also
half-hipped, mansard), pyramidal (also cone, dome) or skillion. Houses, cabins, sheds, garages, barns, saunas and
churches, and `building=yes` / `residential` of at most 150 m² and two storeys, get a guessed gabled roof when their
outline is nearly a rectangle. The ridge runs along the outline's long side unless `roof:orientation=across`; a
skillion roof slopes down to `roof:direction`. The roof's height is `roof:height` or `roof:levels`, else a 27°
slope (10° for skillion, at most 6 m): on top of the storeys, or within a tagged `height`, taking at most half of it.
Outlines under 1 m wide get no roof, except steps (`building:part=steps`), whose skillion roof is the slope they climb;
they also tell how many steps they have (`step_count`). Such a part shows the steps themselves, so a way of steps
(`highway=steps`) inside it (`src/stairs.ts`), up to 0.3 m out of its outline, is left out of the map.

Where a city publishes its buildings in 3D, the measured tops of their roofs replace these guesses (`src/roofTops.ts`).
`ROOF_TOP_SOURCES` lists the open layers known, each with the area it covers, and a map takes those it reaches into
(`roofTops` chooses others): for now only the City of Tampere's 3D building parts
(`julkinen:mml_rakennusten_osat_3d_polygon_kaytossa` at `geodata.tampere.fi`, about 35 000 from Lielahti to Hervanta), each
part an outline with the height above sea level of its roof's highest point (`kattokorkeus`, to half a meter): the
ridge of a pitched roof, the top of a flat one's parapets and machine rooms. Once the buildings stand at their base,
an ordinary building (not a part, an outline with parts, or a special, open or raised one) that the parts cover for at
least half of its outline, sampled every meter, takes its height from the tops over it: their median, of the tops that
fit its storeys (at least 2.7 m a storey), which must cover a tenth of it, so that a tower drawn in one outline with
its podium keeps its tower and a low wing does not take the top of a tall building over it. This replaces OSM's
`height` too, which in Tampere is mostly a rule of thumb from the storeys (4 storeys 16 m on 158 buildings, 5
storeys 20 m on 208, 6 storeys 25 m on 244, ...). With storeys, the top also tells the roof between the eaves (the
storeys, as tall as of their age) and itself:

- a guessed pitched roof's height rises up to the top, at most half of the height and no steeper than 50°, but it
  is not made lower than guessed: the storeys tell the eaves too roughly for that (an attic counted as a storey, a
  plot sloping under the base, a shed's low walls);
- a building without `roof:shape` in OSM whose top is more than 3 m over its eaves gets a hipped roof up to it
  (along the outline's long side, no steeper than 50°) if it was built before 1960 and its outline is nearly a
  rectangle (as for a guessed roof): until then most roofs were pitched, and on later, flat roofs such a top is a
  machine room (see [Measured in Tampere](#measured-in-tampere));
- other tops more than 3 m over the eaves, and tops more than 3 m over the steepest roof the building could have,
  are left out: a roof that cannot be told or drawn, or another building's top.

From Lielahti to Hervanta about 18 000 buildings get a measured height (half of them from 1.4 m lower to 1.2 m
higher than before) and 126 of them a hipped roof, such as the main building of Juhannuskylän koulu (1907,
`height=16` in OSM), 16 m tall with a flat roof before and now 14.4 m of walls under an 11.3 m hipped roof, and the
wooden villas of the 1920s in Pyynikki, 6.4 m tall before and now under roofs 5–7 m tall.

Ways through buildings (`tunnel=building_passage`) are drawn on the ground like other ways, and open the walls
they cross: as wide as the way (wider where it crosses at a slant, and on over nearly straight corners) and as
tall as its `maxheight`, else 4 m for vehicles and 3 m for people, leaving at least 0.5 m of wall under the eaves.
A building is only its walls and roof, so the way also gets a room through it (`passageRooms`): walls along its
sides from opening to opening (mitred at its corners, and across its end where it ends inside) and a ceiling at
the opening's height. Where ways beside or across each other meet inside, their rooms are one space.
Passages are often tagged `tunnel=yes` or `covered=yes` instead: such a way is taken for a passage when it is at
most 60 m long and not deeper than `layer=-1`, neither end is more than 1 m inside a building, and at least half
of it is inside buildings.
A railway (not in a tunnel or on a bridge) running into a building, such as a depot whose doors OSM does not map,
opens its walls 4.5 m wide, and a building lower than 6 m becomes 6 m tall, without a room.

Other tunnels get heights from the elevation model, which has the bare ground over them. A tunnel (`layer` -1 or above)
whose ground rises nowhere more than 3 m over its ends runs at the ground under something built over it, which the
model leaves out: a railway anywhere (the tracks under Tampere's Kansi and its arena), a road or path when at least
half of it is under buildings (not open roofs; under a street or a railway the model has their level, not the
tunnel's). Tunnels joined at a point are one network, which runs at the ground only as a whole: a short branch of a
tunnel under the ground, ending under a building, stays in it. It becomes a way on the ground, the walls of buildings over it open for it (as tall as a tunnel's room,
below), an open roof over it is raised over that room, and so is the underside of a building raised off the ground
(`min_height`), its top where it was. Over a railway every building starts over the room (it stands on a deck over
the tracks), and an open roof becomes a deck 1 m thick over it, without posts. A building is over a way where the
way's room, 1 m wider than the way on both sides, is under it. A shallow tunnel
(`layer` -1 or above) that the model has as an open cut, the ground beside it at least 3 m higher on both sides
along most of it (an underpass under a deck), gets the top of a lid over it at the rim of the cut (`lid`, at
least 3.5 m and the lid's 1 m over the floor), and the ways over it become bridges. Its `floor` is the ground at its
ends, where it leads on, and between them the lowest ground across the cut within 4 m of the way's edges: the model
rounds the cut's sides off, and a way mapped on them would rise and fall with them. A tunnel beside it (within 2 m of
the lid along most of it, such as a pavement beside a tramway) is in the same cut, under the same lid and on its floor. Once the bridges have their decks, a lid is lowered to the decks over it (they run from the ground at their ends),
leaving at least 2.5 m of room over the floor for people, 3.5 m for vehicles and 4 m for trains. Any other tunnel, under a
hill or a lake, gets its floor (`floor`, with a point every 10 m): straight between its portals' ground (the
lowest within 4 m outside, since at the portal the model has the top of its wall), a junction underground
hanging between its branches' ends by distance, but at least room and a 1 m roof under the ground (3 m of
room for people, 4.8 m for vehicles, 6 m for trains; reached 30 m in from a portal; under water areas 3 m more, since the model has the water's surface) and no
steeper than 7 %. Under a way over it (where the way's width and the tunnel's room overlap, but not at the tunnel's
free ends) it is that deep from the start, and rises from there no steeper than 7 %, to the portals too. Where it
would follow the ground's humps it is smoothed, lowered only: no point is more than 0.1 m over the line between its
neighbours (portals and junctions stay).
Where the ground at a portal (the top of its wall) is over the floor, a ramp is split off each way leading on, with
a `floor` of its own: straight from the portal's floor to where a 7 % slope from it meets the ground, at most 40 m
on. A way leads on from a tunnel's end only on the tunnel's storey (`level`, when both have one): one on another
goes on from a lift. Ways indoors (`indoor=yes`, and corridors, `highway=corridor`, tagged so or not) are left out,
except up to 30 m on from a tunnel's end. Stairs leading on (`highway=steps`, also indoors), and corridors (on at the tunnel's level into a building), go up out of the
tunnel, such as from an underpass to the platforms over it: they rise from its floor to the ground at 60 %, and
their foot is no portal the floor hangs from, unless the tunnel has no other way out (then it is as deep as the
room and the roof need). Lines are simplified to 0.3 m, but not where other ways join them, so a tunnel's branches
stay joined to it.

A bridge's ways (the road, its sidewalks, a cycleway) each get a `deck` (`src/bridges.ts`): ways meeting end to end
are one span, straight from the ground at one end to the other, also over the model's hump under it (the ground
under a bridge is the gap spanned from the ground around; the terrain is to be kept under the deck). An end that no
way leads on from but ways indoors do (`indoor=yes`, left out) goes into a building at some floor, such as a lift
tower's top: it takes no height from the ground, and the deck runs level from the span's other end. Steps up to a
point of a span with a count and a way they climb (`step_count`, `incline`) tell its height, 0.16 m a step over the
ground at their foot; the deck then runs straight between the ends and these heights on their upper hull, so it
may rise to a crest and fall again but never dips. Such steps also lift a way above the ground that is no bridge
(`layer` over 0: stairs on a structure, a landing) where they tell an end of it more than 0.5 m over the ground, no
way on the ground meets them there, and its other end is a dead end (a landing at a door, level) or meets a way on
the ground no lower (stairs down from a street to where a spiral goes on down). A bridge's outline follows the upper hull of its ways' decks, its crests rounded
as a bridge's, along the way its ways run where they run mostly one way (a bridge may be wider than long), else along
its longer side. A tunnel or covered way through a building
from one bridge's end to another's (a footbridge through a building's upper floor) carries the span on through it,
with a deck as the bridges have; the building's openings and the way's room through it then start at the deck
(`Opening.ground`, `PassageRoom.ground`), and `parseOsm` tells the roads through buildings (`throughBuildings`). The model smooths the cut under a bridge into a
wider hollow, so an end's ground is taken up the ways leading on as far as it rises steeply (0.2 m every 2 m), past
at most 6 m of the hollow's level bottom and at most 24 m on, and those ways get a deck up to there. A deck stays straight: where a way
under a bridge (at a lower layer, not in a tunnel) has less room under the deck than 2.7 m for people, 4.2 m for
vehicles, 4.7 m for trams and 5.5 m for trains, and the deck's 1 m, the way goes down into a cut there (a stretch
split off with a `floor`), ramping down no steeper than 8 % (people), 6 % (vehicles) or 3 % (trains); one that
would go deeper than 3 m, or ends in the cut, is left as it is. The bridges over cuts are logged: their ends may
be too low in the model, as a footbridge's ramps and steps are not in it. Many bridges are also drawn as an outline
(`man_made=bridge`, a way or a multipolygon): the whole deck, with what is between the ways, such as planted strips
(`src/decks.ts`). The bridge ways at least half inside an outline get one deck: along the bridge straight from
the highest of their decks at its one end to that at the other, also at their free ends; a way reaching on more
than 5 m past the outline goes straight from its edge to its own end. They get a point every 5 m for that. The
ways leading on from them meet the deck: an approach's deck is tilted to it, and a way on the ground gets a ramp
split off it, up to the deck (a deck) or down to it (a floor, in a cut), no steeper than 8 % for people, 6 % for
vehicles and 3 % for trains. The outline is then cut across the bridge into
pieces 4 m long, as triangles with the height of the nearest way's deck at each corner (`bridgeDecks`), so the
deck can be drawn between the ways too. The outline's triangles are cut rather than the outline itself, and each
piece's cuts joined again, since a cut ring would run back over a gap in the outline (Näsinsillat in Tampere is two
decks side by side, joined in the middle); a triangle steeper than 45° (a sliver whose corners are at different
heights) is left out. Trees and street lamps on the deck stand on it (`base`).

Railways (not tramways) that are not bridges or tunnels get a track bed (`bed`): the elevation model has
platform edges, underpass roofs and the like under the tracks, a metre up and down every few metres, so the bed is
the ground averaged over 30 m along the line, never more than 0.5 m under the ground right under it. Where lines
meet, their beds end at the same height: the ground averaged within 10 m, or the deck of a bridge ending there.

Railway platforms (`railway=platform`, ways and multipolygons, their holes kept) are areas of kind `platform`
with a `top`: a platform is level, while the elevation model has it as a ridge smoothed at its edges, so its top is
the ground's median inside its outline, sampled every 2 m.

Neither OSM nor the register has windows, so ordinary buildings get guessed ones: a row per storey (from
`building:levels` or the register's storeys, else about every 3 m) and spaced by the kind of building. Houses get
windows 4 m apart, blocks of flats and hotels 2.8 m, and offices, shops and schools a band of windows 1.6 m apart.
The kind comes from `building=*`; for `building=yes` the register's main use (`paaasiallinen_kayttotarkoitus`)
decides: houses and holiday homes, blocks of flats, and public buildings (shops, restaurants, hotels, schools, ...)
with offices' windows. Offices and factories are one class there, so of those only buildings of 4 storeys or more
get offices' windows (in Tampere 103 of 135 such are offices, and 880 of the 952 lower ones not). A
`building:part=yes` gets the windows of the building it is in. Other buildings (churches, sheds, factories,
halls, ...) and glass walls get no windows, and neither do storeys under 2.2 m or over 6 m tall. Nor do buildings
tagged as something special whatever their `building=*` (`man_made=*` such as towers and chimneys,
`amenity=place_of_worship`, `historic=*` other than `building`, `tourism=attraction` or `museum`) and the parts in
them, or buildings over five times taller than their longest side (towers that are not tagged so); Näsinneula is
`building=yes` with `man_made=tower`. The style says nothing of the windows' age: a building's `year` (see above) does.

Street and park trees come from a city's tree register, in the format of the parks register software many
Finnish cities use: a WFS layer of a point per tree with its species, height class and trunk circumference.
`TREE_REGISTERS` lists the open ones known, each with the area it covers, and a map takes those it reaches into
(`treeRegisters` chooses others): for now only the City of Tampere's (`locus:locus_t_RpaVegetation_gsview` at
`geodata.tampere.fi`, about 12 500 around the centre, nearly all trees, few shrubs). Elsewhere the trees are OSM's.
Only a register's trees inside the map's box are taken, as its server also sends ones with broken coordinates. The height is the middle of the height class, else a guess from
the trunk (3 m + 0.35 × its diameter in cm, at most 25 m). OSM's `natural=tree` and `natural=shrub` nodes and
`natural=tree_row` ways (a tree every 8 m or less) are added where the register has no tree within 4 m. Woods
(`natural=wood`, `landuse=forest`) and scrub (`natural=scrub`) are only areas in OSM, so the import plants them,
far sparser than real woods since every tree costs something to draw: a tree in each 9 m cell of a grid (spruce, pine
or birch, 10–26 m), leaving 15 % of the cells empty, and in scrub mostly shrubs in 5 m cells. Woods tagged
`leaf_type=needleleaved` get only spruce and pine, and `leaf_type=broadleaved` ones birch and other broadleaved trees
(8–20 m); mixed and untagged woods get all three. A plant keeps 2.5 m from others and clear of buildings, roads,
rails, water, parking and pitches. Where it stands comes from its grid cell alone, and what it is from the cell and
the woods' leaf type, so every build plants the same trees, and retagging woods changes their trees but moves none.
Around the centre of Tampere that is some 20 000
trees, at most about 530 in a 250 m tile.

Street lamps are OSM's `highway=street_lamp` nodes (about 2 100 around the centre of Tampere). Their mount comes
from `lamp_mount` or `support`, or is a catenary mast (`power=catenary_mast`, such as a tram's); in Tampere a tenth
have one, and none a `height` or a `direction`. A lamp without them faces the nearest street within 15 m, else the
nearest path within 8 m, and is 10 m tall by a main street (secondary and up), 8 m by another street and 5 m by a
path or nothing (high masts 20 m, catenary masts 8 m). A lamp on a bridge stands on its deck: the deck of the way next to it, or of the bridge outline it is on.

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
gates (`src/barriers.ts`). A barrier's stretches on a bridge's deck or a tunnel's lid, at least 1 m over the ground,
are left out (a railing along a bridge): a barrier stands on the ground, which is under the deck there.

Playground equipment (`playground=*` nodes and ways: swings, basket swings, slides, sandpits, climbing frames,
spring riders, ...) comes from a query of its own (`src/playgrounds.ts`), with its `capacity`, `baby` (a swing's
baby seat), `material`, `height` and `playground:theme`. OSM seldom tells which way a piece faces or how big it is:
a way tells both (`along` and `length`; a closed way also `width` and its `outline`, as a sandpit's edge), a swing
node lines up with the nearest swing within 6 m (frames in a row), and other nodes with the nearest edge (at least
2 m long) of the playground (`leisure=playground`) they stand in; nodes of one kind within 1.5 m of each other are
one piece mapped twice. Around Tampere there are about 1 200 pieces in 560 playgrounds, half of them swings and a
third sandpits; 130 swings stand in a row, and 370 other pieces line up with their playground's edge.

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
roads and links unless they have a sidewalk tagged, on roads in tunnels, or where `foot=no`, `use_sidepath` or
`private`. Elsewhere footfall is estimated as `kind × (base + scale × draw)`: `draw` adds up the businesses near
the point (restaurants and cafes 1.5, shops 1, offices 0.5, others 0.7; falling off to nothing at 200 m) and the
other doors (0.15 each, to nothing at 120 m), and `kind` is 1.6 on pedestrian streets, 1 on footways, main
streets and cycleways shared with people walking (`foot=designated`, `yes` or `permissive`, as most in Finland),
0.8 on residential streets, 0.6 on steps and unclassified roads, 0.35 on paths, 0.3 on service roads and other
cycleways, and 0.2 on tracks.

Every way people cycle on gets `cycling` the same way, people cycling along it a day, with `kind` for cycling: 1 on
cycleways, 0.7 on footways and pedestrian streets shared with bicycles (`bicycle=yes`, `designated` or
`permissive`), 0.1 and 0.2 on other footways and pedestrian streets (in Finland only children may cycle there), 0.4
on paths, 0.3 on tracks, and on streets, in their carriageway, 0.7 on tertiary, 0.6 on secondary and residential,
0.5 on primary, unclassified and living streets and 0.3 on service roads; a street with its sidewalks drawn apart
gets 30 % of that and one with `bicycle=use_sidepath` (in Tampere most main streets) 15 %, as a cycleway beside it
takes most of its cyclists. No one cycles on steps, motorways, trunk roads and their links, roads in tunnels, or
where `bicycle=no` or `private`. Ways have their `foot`, `bicycle` and
`segregated` (`segregated=yes`: people walking and cycling each have a side of their own; OSM does not tell which).

`base` and `scale` (`footfallModels` in [`FINNISH_DEFAULTS_MEASURED_IN_TAMPERE`](#measured-in-tampere)) were fitted, in September 2026, to the City of Tampere's
[pedestrian and cycling counts](https://data.tampere.fi/data/dataset/tampereen-jalankulun-ja-pyorailyn-liikennemaaria)
around the centre: 432 walking counts fit `330 + 19.2 × draw` and 445 cycling counts `330 + 0.5 × draw` (cycling
hardly depends on the businesses around), within a factor of two of 55 % of the walking counts and 43 % of the
cycling ones. The counts themselves are not in the map; a user with counts can pull the estimates towards them
when it uses the map (see [Flows](#flows)). Centre sidewalks get 2 000–9 500 people
walking a day, suburban footways a few hundred, paths and service roads less; the cycleways and streets a few
hundred to a few thousand people cycling.

Roads for vehicles have `motorVehicle`, the most specific of `motorcar=*`, `motor_vehicle=*`, `vehicle=*` and
`access=*` (who may drive on it: no, private, destination, ...), `bus`, from `bus=*` or else `psv=*` (whether buses may:
designated on a bus lane or a bus station's way closed to others), and service roads their `service=*` (parking_aisle,
driveway, ...).

### Water

Water areas are `natural=water`, `waterway=riverbank` and `landuse=reservoir` or `basin`; those of a river, canal or
stream (`water=river`, `canal`, `stream`, `rapids`, ..., or `waterway=*` on the area) are `flowing`. The elevation
model has the water's surface, but where an area takes in its banks the surface rises up them, and it wavers by a
few decimetres here and there. So the tiles' heights in water are the water's level instead (with an elevation
model):

- A still water, a lake or pond, is level at the median of the elevation model inside it, unless the middle half
  of those heights spreads over 0.5 m: then it is on a slope and keeps the model's heights.
- A flowing water falls along the waterways in it (OSM `waterway=river`, `canal` and `stream` lines, which are drawn
  the way they flow, fetched with a query of their own): every 2 m along a waterway in the water the model's
  height (a still water's level in one) is taken, and these are made never to rise downstream, a run that would
  rise pooled at its median, so a dam's crest or a bank does not lift the water. A waterway flowing on from
  another starts no higher than that one ends, also through a culvert. Each point of the water is as high as the
  nearest point of its waterways, so it is level across and steps down where the river does: Tammerkoski falls
  from Näsijärvi's 95.4 m to 88.2, 81.3, 77.4 and Pyhäjärvi's 77.1 m at its dams. A flowing water with no waterway
  in it is set level, or left on its slope, as a still one.

The tiles' `waterways` are the waterways' stretches in the water, cut at the tiles' edges: each with its `kind`,
`name`, the way it flows (`line`), the water's surface (`levels`, m) and how wide the water is across it (`widths`, m,
measured to where the water ends on each side, up to 150 m), simplified to within 0.5 m across, 5 cm of level and
2 m of width, and its `network`: the lowest id of the waterways joined to it at a point, rivers and canals together
and streams apart, so a river keeps its network through culverts and power plants and a stream joining it does not
take it.

### Flows

`pullFlows(roads, others, counts)` (`flows.ts`) gives how many walk, cycle and drive along roads on an average day
of the year, at each point of their lines: the map's footfall and cycling, and motor vehicles by the kind of road
(`estimateMotorTraffic`: motorway 30 000, primary 12 000, secondary 7 000, tertiary 3 500, unclassified 800,
residential 250, a service road 60, a parking aisle 30; a fifth of it where `motorVehicle` lets only some drive,
such as `destination` or `delivery`, and none where it is `no`, `private`, `psv`, ..., on walkways and in tunnels
drawn neither on a floor nor under a lid), each pulled towards counts at points. It is for a user that has counts,
such as a city's traffic counts, and combines them with the map when it uses it instead of building them into the
map, so the counts stay a database of their own and can be updated without building the map again.

Each count is on the nearest road of its mode within 25 m among `others` (the roads and those around them, so a
count beside the edge of an area still counts); a count of walking or cycling on one sidewalk of a street is
doubled for the street. Around it the ratio of count to estimate spreads, fading out, along the counted road (its
OSM id or name, and for walking and cycling the walkways of its kind in line with it) within 80 m for walking and
cycling and 250 m for motor traffic, and onto other roads within 80 m (a third of the pull) or 60 m (a fifth). The
counts are given as the year's average day, people or vehicles both ways. A road where only some may drive
(`motorVehicle` `destination`, `delivery`, ..., such as a street for buses, trams and taxis open to deliveries) keeps
its few cars: a motor count on it is of the buses, taxis and deliveries and is left out, and the counts around do not
pull it.

### Seen from afar

`farTile(tile, tileSize)` (`far.ts`) sums a tile up for drawing it from afar, such as dozens of tiles around a
viewer high up, where their full features would be far too many:

- `cover`: what covers the ground as a coarse picture, 128 × 128 cells by default, row by row from the north-west
  corner, one character each (the index in `FAR_CLASSES` as a base-36 digit): ground, grass, forest, sand, rock,
  pitch, paved, water, road, path, rail. Areas are painted in that order (platforms as paved), and roads, paths (footways, cycleways,
  steps, ...) and railways over them at their width; tunnels are left out.
- `heights`: the ground's heights resampled to 17 × 17 points over the tile, in the tile's `Heights` format.
- `boxes`: each building as the smallest box around its outline with a side along one of its edges (its centre,
  the long side's direction, length and width) with the building's base, heights and colours. Outlines with parts
  and buildings smaller than 40 m² are left out; a block with a courtyard is a full box.

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
  3 m over the eaves is a flat roof's, from the city's 3D building parts (see above): of the buildings without
  `roof:shape` whose storeys are known, those of the 1920s to the 1950s rise a median 2.1–3.0 m over their storeys
  and about half of them more than 3 m, those of the 1960s to the 2010s 0.6–1.8 m and 12–22 % of them more than 3 m
  (machine rooms on flat roofs)
- `chimneyHeight` and `chimneyMaterial`: an untagged chimney 12 times as tall as its base is wide (at most 100 m)
  and brick, from the city's chimneys

## Licences

The code is under the [MIT licence](LICENSE).

The data it builds is not:

- OpenStreetMap data is © OpenStreetMap contributors, under the
  [Open Database License](https://www.openstreetmap.org/copyright) (ODbL). The features built here are OSM data
  altered and combined with other data, a Derivative Database in ODbL terms: when you make it, or something
  produced from it such as a rendered map, public, you must credit OpenStreetMap and offer the database, or the way it
  was made, under the ODbL. This package is that way for maps built with it; say which commit you used.
- Elevation model and orthophoto © Maanmittauslaitos, the building register © Finnish Environment Institute Syke
  (Ryhti), and a tree register and 3D building parts © their city (Tampere), all under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit them.
- Flows pulled towards counts (`pullFlows`) are OSM roads combined with the counts: a Derivative Database under the
  ODbL however briefly they exist, whether they are stored or worked out when they are used, and `flows.ts` is the
  way they are made. Credit the counts' source too. The counts themselves are not changed by it and stay under
  their own terms.

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
