// Local edits of OpenStreetMap's data not uploaded (yet), in OSM XML as an editor such as JOSM saves them: the
// elements changed have action="modify" or action="delete", new ones a negative id. Applied to the data fetched from
// Overpass before anything is built from it, they show in the map before they are in OpenStreetMap.
import type { OsmElement } from "./osm.ts";

export type EditAction = "modify" | "delete" | "create";

export interface OsmEdit {
  action: EditAction;
  /** A way's geometry is that of its nodes in the file, unset when some of them are not there */
  element: OsmElement;
}

export interface AppliedEdits {
  elements: OsmElement[];
  /** Edits of elements the data does not have (modified or deleted ones) */
  missing: number;
}

interface XmlElement {
  attributes: Map<string, string>;
  tags: Record<string, string>;
  refs: string[];
}

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number(lower.slice(1)));
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? entity;
  });
}

function attributes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g)) {
    result.set(match[1], unescape(match[2] ?? match[3] ?? ""));
  }
  return result;
}

function elementsOf(xml: string, name: string): XmlElement[] {
  const pattern = new RegExp(`<${name}\\s([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`, "g");
  return [...xml.matchAll(pattern)].map((match) => {
    const body = match[2] ?? "";
    const tags: Record<string, string> = {};
    for (const tag of body.matchAll(/<tag\s([^>]*?)\/?>/g)) {
      const a = attributes(tag[1]);
      const k = a.get("k");
      if (k !== undefined) {
        tags[k] = a.get("v") ?? "";
      }
    }
    const refs = [...body.matchAll(/<nd\s([^>]*?)\/?>/g)].flatMap((nd) => attributes(nd[1]).get("ref") ?? []);
    return { attributes: attributes(match[1]), tags, refs };
  });
}

function actionOf(element: XmlElement, id: number): EditAction | undefined {
  const action = element.attributes.get("action");
  if (action === "delete") {
    return "delete";
  }
  if (id < 0) {
    return "create";
  }
  return action === "modify" ? "modify" : undefined;
}

/**
 * The edits in an OSM XML file: its elements with an action and its new ones (negative ids), but untagged nodes,
 * which are vertices of ways: a way whose node was moved is edited, as its geometry changes. Relations are not supported: an edited one is an error, and so is a
 * new way without all its nodes.
 */
export function parseOsmEdits(xml: string): OsmEdit[] {
  const edits: OsmEdit[] = [];
  const positions = new Map<string, { lat: number; lon: number }>();
  const moved = new Set<string>();
  for (const node of elementsOf(xml, "node")) {
    const id = Number(node.attributes.get("id"));
    const lat = Number(node.attributes.get("lat"));
    const lon = Number(node.attributes.get("lon"));
    if (!Number.isInteger(id)) {
      continue;
    }
    const placed = Number.isFinite(lat) && Number.isFinite(lon);
    if (placed) {
      positions.set(String(id), { lat, lon });
    }
    const action = actionOf(node, id);
    if (action !== undefined && action !== "delete") {
      moved.add(String(id));
    }
    // an untagged node is a way's vertex, whose ways carry its change
    if (action !== undefined && (action === "delete" || Object.keys(node.tags).length > 0)) {
      edits.push({ action, element: { type: "node", id, tags: node.tags, ...(placed && { lat, lon }) } });
    }
  }
  for (const way of elementsOf(xml, "way")) {
    const id = Number(way.attributes.get("id"));
    if (!Number.isInteger(id)) {
      continue;
    }
    const action = actionOf(way, id) ?? (way.refs.some((ref) => moved.has(ref)) ? "modify" : undefined);
    if (action === undefined) {
      continue;
    }
    const points = way.refs.map((ref) => positions.get(ref));
    const geometry = points.every((p) => p !== undefined) && points.length >= 2 ? points.flatMap((p) => p ?? []) : undefined;
    if (action === "create" && geometry === undefined) {
      throw new Error(`new way ${id} lacks some of its nodes`);
    }
    edits.push({ action, element: { type: "way", id, tags: way.tags, ...(geometry && { geometry }) } });
  }
  for (const relation of elementsOf(xml, "relation")) {
    const id = Number(relation.attributes.get("id"));
    if (Number.isInteger(id) && actionOf(relation, id) !== undefined) {
      throw new Error(`relation ${id}: edits of relations are not supported`);
    }
  }
  return edits;
}

function centre(geometry: { lat: number; lon: number }[]): { lat: number; lon: number } {
  const lat = geometry.reduce((sum, p) => sum + p.lat, 0) / geometry.length;
  const lon = geometry.reduce((sum, p) => sum + p.lon, 0) / geometry.length;
  return { lat, lon };
}

/**
 * The elements with the edits applied: a modified element takes the edit's tags (and its position or geometry,
 * when the edit has one), a deleted one is left out, and with `addNew` the new ones are added. A response of
 * centres keeps them, moved with the geometry.
 */
export function applyOsmEdits(elements: OsmElement[], edits: OsmEdit[], addNew: boolean): AppliedEdits {
  const key = (e: OsmElement) => `${e.type}/${e.id}`;
  const changes = new Map(edits.filter((edit) => edit.action !== "create").map((edit) => [key(edit.element), edit]));
  const found = new Set<string>();
  const result: OsmElement[] = [];
  for (const element of elements) {
    const edit = changes.get(key(element));
    if (!edit) {
      result.push(element);
      continue;
    }
    found.add(key(element));
    const changed = edit.element;
    if (edit.action === "delete") {
      continue;
    }
    if (element.type === "node" && changed.type === "node") {
      result.push({ ...element, tags: changed.tags, lat: changed.lat ?? element.lat, lon: changed.lon ?? element.lon });
    } else if (element.type === "way" && changed.type === "way") {
      const geometry = changed.geometry && (element.geometry || !element.center) ? changed.geometry : element.geometry;
      const moved = changed.geometry && element.center ? centre(changed.geometry) : element.center;
      result.push({ ...element, tags: changed.tags, ...(geometry && { geometry }), ...(moved && { center: moved }) });
    } else {
      result.push(element);
    }
  }
  if (addNew) {
    result.push(...edits.filter((edit) => edit.action === "create").map((edit) => edit.element));
  }
  return { elements: result, missing: changes.size - found.size };
}
