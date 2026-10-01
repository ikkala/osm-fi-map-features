import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateMotorTraffic, pullFlows, type FlowCount, type FlowRoad } from "./flows.ts";
import { defined } from "./testing.ts";

const roads: FlowRoad[] = [
  { osm: "w1", kind: "secondary", name: "Teiskontie", line: [[0, 0], [100, 0], [200, 0]] },
  { osm: "w2", kind: "secondary", name: "Sivukatu", line: [[150, 0], [150, 150], [150, 300]] },
  { osm: "w3", kind: "residential", line: [[0, 1000], [100, 1000]] },
  { osm: "w4", kind: "residential", motorVehicle: "no", line: [[0, 2000], [100, 2000]] },
  { osm: "w5", kind: "footway", line: [[0, 10], [50, 10], [100, 10]], footfall: [400, 400, 400] },
  { osm: "w6", kind: "footway", line: [[100, 10], [200, 10]], footfall: [400, 400] },
  { osm: "w7", kind: "residential", line: [[0, 3000], [50, 3000]], footfall: [300, 300] },
  { osm: "w8", kind: "service", service: "parking_aisle", line: [[0, 4000], [50, 4000]] },
  { osm: "w9", kind: "secondary", tunnel: true, line: [[0, 5000], [50, 5000]] },
];
// the road goes on beyond the area of `roads`
const beyond: FlowRoad = { osm: "w1", kind: "secondary", name: "Teiskontie", line: [[200, 0], [450, 0]] };

test("roads get the map's walking and cycling and their kind's cars, none where cars may not drive", () => {
  assert.equal(estimateMotorTraffic(roads[0]), 7000);
  assert.equal(estimateMotorTraffic({ kind: "residential", motorVehicle: "destination", line: [] }), 50);
  const { flows, counted } = pullFlows(roads, roads, []);
  assert.equal(counted, false);
  const byIndex = new Map(flows.map((f) => [f.index, f]));
  assert.deepEqual(byIndex.get(0), { index: 0, motor: [7000, 7000, 7000] });
  assert.deepEqual(byIndex.get(2)?.motor, [250, 250]);
  assert.equal(byIndex.get(3), undefined);
  assert.deepEqual(byIndex.get(4), { index: 4, footfall: [400, 400, 400] });
  assert.deepEqual(byIndex.get(6), { index: 6, footfall: [300, 300], motor: [250, 250] });
  assert.deepEqual(byIndex.get(7)?.motor, [30, 30]);
  // a tunnel drawn neither on a floor nor under a lid
  assert.equal(byIndex.get(8), undefined);
});

test("counts pull their road far along it, the side streets and other ways little", () => {
  const counts: FlowCount[] = [
    // beyond the roads' area, 10 m along the road that goes on there
    { mode: "driving", point: [210, 3], daily: 21000, whole: false },
    { mode: "walking", point: [50, 11], daily: 2000, whole: false },
    { mode: "walking", point: [25, 3002], daily: 900, whole: false },
  ];
  const { flows, counted } = pullFlows(roads, [...roads, beyond], counts);
  assert.equal(counted, true);
  const at = (index: number) => defined(flows.find((f) => f.index === index));
  const teiskontie = defined(at(0).motor);
  // near the count it has about the count, and 210 m away still twice its kind's
  assert.ok(teiskontie[2] > 18000 && teiskontie[0] > 12000, `Teiskontie ${teiskontie.join(", ")}`);
  // the side street's far end is its kind's
  assert.equal(defined(at(1).motor)[2], 7000);
  // the counted footway gets about the count at the count, and the one in line with it is pulled too
  const footway = defined(at(4).footfall);
  assert.ok(Math.abs(footway[1] - 2000) / 2000 < 0.15, `footway ${footway.join(", ")}`);
  assert.ok(defined(at(5).footfall)[0] > 1000);
  // a street counted on one sidewalk has about twice the count
  const street = defined(at(6).footfall);
  assert.ok(Math.abs(street[0] - 1800) / 1800 < 0.2, `street ${street.join(", ")}`);
});

test("a street where only some may drive keeps its few cars, and its motor count is left out", () => {
  // a transit street open to deliveries, counted, and a street crossing it
  const transit: FlowRoad = { osm: "w1", kind: "residential", name: "Hämeenkatu", motorVehicle: "delivery", line: [[0, 0], [100, 0], [200, 0]] };
  const crossing: FlowRoad = { osm: "w2", kind: "tertiary", name: "Puutarhakatu", line: [[100, -100], [100, 100]] };
  const { flows, counted } = pullFlows([transit, crossing], [transit, crossing], [{ mode: "driving", point: [50, 2], daily: 2400, whole: false }]);
  assert.equal(counted, false);
  assert.deepEqual(flows[0].motor, [50, 50, 50]);
  assert.deepEqual(flows[1].motor, [3500, 3500]);
  // nor is it pulled by a count on the street crossing it
  const near = pullFlows([transit, crossing], [transit, crossing], [{ mode: "driving", point: [102, 10], daily: 9000, whole: false }]);
  assert.deepEqual(near.flows[0].motor, [50, 50, 50]);
  assert.ok(defined(near.flows[1].motor)[1] > 7000);
});
