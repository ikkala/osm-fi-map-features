// The code's repeated stretches stay under the threshold of .jscpd.json (jscpd, a copy-paste detector; the tests left
// out), so that a change adds no copies of what is there already. Lower the threshold when a change takes copies out;
// raise it only on purpose. To see the copies: npx jscpd --reporters console.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const JSCPD = createRequire(import.meta.url).resolve("jscpd/run-jscpd.js");

test("the code repeats itself no more than .jscpd.json lets it", () => {
  const run = spawnSync(process.execPath, [JSCPD, "--config", path.join(ROOT, ".jscpd.json")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}\nsee the copies: npx jscpd --reporters console`);
});
