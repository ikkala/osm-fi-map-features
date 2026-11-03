import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { parseTunnelFloors, readTunnelFloors } from "./tunnelFloors.ts";

test("a known tunnel floor has its tunnel's name, a latitude, a longitude, a floor and a source", () => {
  const text = JSON.stringify({ floors: [{ tunnel: "Tunneli", latitude: 61.5, longitude: 23.76, floor: 70.5, source: "plan 1" }] });
  assert.deepEqual(parseTunnelFloors(text), [{ name: "Tunneli", at: { latitude: 61.5, longitude: 23.76 }, floor: 70.5, source: "plan 1" }]);
  assert.deepEqual(parseTunnelFloors(JSON.stringify({ floors: [] })), []);
  assert.throws(() => parseTunnelFloors(JSON.stringify({ floors: [{ tunnel: "Tunneli", latitude: 61.5, longitude: 23.76, floor: 70.5 }] })), /tunnel floor 1/);
  assert.throws(() => parseTunnelFloors(JSON.stringify({ floors: [{ tunnel: "Tunneli", latitude: "61.5", longitude: 23.76, floor: 70.5, source: "x" }] })), /tunnel floor 1/);
  assert.throws(() => parseTunnelFloors(JSON.stringify({ floors: [{ latitude: 61.5, longitude: 23.76, floor: 70.5, source: "x" }] })), /tunnel floor 1/);
});

test("the floors read from a stream", async () => {
  const text = JSON.stringify({ floors: [{ tunnel: "Tunneli", latitude: 61.5, longitude: 23.76, floor: 70.5, source: "plan 1" }] });
  assert.equal((await readTunnelFloors(Readable.from([text.slice(0, 20), text.slice(20)])))[0].floor, 70.5);
});
