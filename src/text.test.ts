import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { readText } from "./text.ts";

test("a text reads whole from a string, bytes or a stream, its characters whole across the stream's pieces", async () => {
  const text = "Hämeensilta – Näsijärvi";
  const bytes = new TextEncoder().encode(text);
  assert.equal(await readText(text), text);
  assert.equal(await readText(bytes), text);
  // a piece ends inside ä's two bytes
  assert.equal(await readText(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)])), text);
  assert.equal(await readText(Readable.from(["Häme", "ensilta – Näsijärvi"])), text);
  assert.equal(await readText(new Blob([bytes]).stream()), text);
});
