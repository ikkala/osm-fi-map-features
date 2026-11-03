// The README says what the package makes, from which sources, how to use it and which module does what; how a
// module works is in its comments. A budget of words keeps it from retelling them, change by change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const README_WORDS_MAX = 3000;

test("the README stays within its budget of words", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const words = readme.split(/\s+/).filter((word) => word !== "").length;
  assert.ok(
    words <= README_WORDS_MAX,
    `README.md has ${words} words, over ${README_WORDS_MAX}: put how a module works in its comments and the history in the commit message`,
  );
});
