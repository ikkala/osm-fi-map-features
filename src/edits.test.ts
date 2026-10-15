import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOsmEdits, parseOsmEdits } from "./edits.ts";
import type { OsmElement } from "./osm.ts";

const FILE = `<?xml version='1.0' encoding='UTF-8'?>
<osm version='0.6' generator='JOSM'>
  <node id='1' version='3' lat='61.5' lon='23.7' />
  <node id='2' version='1' lat='61.5' lon='23.701' />
  <node id='3' version='1' lat='61.501' lon='23.701' />
  <node id='4' action='modify' version='2' lat='61.502' lon='23.702'>
    <tag k='entrance' v='main' />
  </node>
  <node id='-1' lat='61.5005' lon='23.7005' />
  <node id='-2' lat='61.5005' lon='23.7006' />
  <node id='-3' lat='61.5006' lon='23.7006' />
  <way id='10' action='modify' version='5'>
    <nd ref='1' />
    <nd ref='2' />
    <nd ref='3' />
    <nd ref='1' />
    <tag k='building' v='office' />
    <tag k='building:levels' v='2' />
    <tag k='name' v='A &amp; B' />
  </way>
  <way id='11' version='1'>
    <nd ref='2' />
    <nd ref='3' />
    <tag k='highway' v='footway' />
  </way>
  <way id='12' action='delete' version='1'>
    <tag k='building' v='shed' />
  </way>
  <way id='13' version='1'>
    <nd ref='3' />
    <nd ref='4' />
    <tag k='highway' v='service' />
  </way>
  <way id='-5'>
    <nd ref='-1' />
    <nd ref='-2' />
    <nd ref='-3' />
    <nd ref='-1' />
    <tag k='building:part' v='yes' />
  </way>
  <way id='14' action='modify' version='1'>
    <nd ref='99' />
    <nd ref='98' />
    <tag k="building" v="yes" />
  </way>
</osm>`;

test("parseOsmEdits takes the changed and new elements, and the ways whose nodes moved", () => {
  const edits = parseOsmEdits(FILE);
  const summary = edits.map((edit) => `${edit.action} ${edit.element.type}/${edit.element.id}`);
  assert.deepEqual(summary, ["modify node/4", "create node/-1", "create node/-2", "create node/-3", "modify way/10", "delete way/12", "modify way/13", "create way/-5", "modify way/14"]);
  const office = edits[4].element;
  assert.equal(office.type, "way");
  assert.deepEqual(office.tags, { building: "office", "building:levels": "2", name: "A & B" });
  assert.equal(office.type === "way" ? office.geometry?.length : undefined, 4);
  // nodes not in the file: the way keeps the geometry it has
  const partial = edits[8].element;
  assert.equal(partial.type === "way" ? partial.geometry : "not a way", undefined);
});

test("parseOsmEdits rejects edited relations and new ways without their nodes", () => {
  assert.throws(() => parseOsmEdits(`<osm><relation id='-1'><tag k='type' v='multipolygon'/></relation></osm>`), /relations/);
  assert.throws(() => parseOsmEdits(`<osm><way id='-1'><nd ref='-7'/><nd ref='-8'/></way></osm>`), /lacks/);
  // unchanged relations are fine
  assert.deepEqual(parseOsmEdits(`<osm><relation id='5' version='1'><tag k='type' v='route'/></relation></osm>`), []);
});

test("applyOsmEdits changes, leaves out and adds elements", () => {
  const fetched: OsmElement[] = [
    { type: "way", id: 10, tags: { building: "office", "building:levels": "5", height: "20" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }] },
    { type: "way", id: 12, tags: { building: "shed" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }] },
    { type: "way", id: 14, tags: { building: "house" }, geometry: [{ lat: 2, lon: 2 }, { lat: 3, lon: 3 }] },
    { type: "node", id: 4, tags: {}, lat: 0, lon: 0 },
    { type: "node", id: 5, tags: { amenity: "bench" }, lat: 0, lon: 0 },
  ];
  const edits = parseOsmEdits(FILE);
  const { elements, missing } = applyOsmEdits(fetched, edits, true);
  // way 13 is not in the data
  assert.equal(missing, 1);
  const ids = elements.map((e) => `${e.type}/${e.id}`);
  assert.deepEqual(ids, ["way/10", "way/14", "node/4", "node/5", "node/-1", "node/-2", "node/-3", "way/-5"]);
  const office = elements[0];
  assert.deepEqual(office.tags, { building: "office", "building:levels": "2", name: "A & B" });
  assert.equal(office.type === "way" ? office.geometry?.[1].lon : undefined, 23.701);
  // no nodes for it in the file: its geometry stays
  const house = elements[1];
  assert.deepEqual(house.type === "way" ? house.geometry : undefined, [{ lat: 2, lon: 2 }, { lat: 3, lon: 3 }]);
  assert.deepEqual(elements[2], { type: "node", id: 4, tags: { entrance: "main" }, lat: 61.502, lon: 23.702 });
  // without addNew, only the changes
  assert.deepEqual(applyOsmEdits(fetched, edits, false).elements.map((e) => e.id), [10, 14, 4, 5]);
});

test("applyOsmEdits moves the centre of a response of centres", () => {
  const fetched: OsmElement[] = [{ type: "way", id: 10, tags: { shop: "kiosk" }, center: { lat: 0, lon: 0 } }];
  const [way] = applyOsmEdits(fetched, parseOsmEdits(FILE), false).elements;
  assert.equal(way.type, "way");
  if (way.type === "way") {
    assert.equal(way.geometry, undefined);
    assert.ok(way.center && Math.abs(way.center.lat - 61.50025) < 1e-9);
  }
});
