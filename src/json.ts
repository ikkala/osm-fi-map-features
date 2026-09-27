// Reading JSON of an unknown shape (the sources' responses) without type casts: every value is
// checked before it is used, and anything unexpected reads as missing.

export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a path of object keys, or undefined when any step is not an object. */
export function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** An array's items, or none. */
export function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A finite number, or undefined. */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
