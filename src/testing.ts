// Helpers for the tests.
import assert from "node:assert/strict";

/** The value, failing the test when it is missing. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== undefined && value !== null, `${what} is missing`);
  return value;
}
