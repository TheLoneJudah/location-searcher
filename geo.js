// Pure geography and text helpers. No browser APIs, so everything here is unit tested.

const EARTH_RADIUS_FT = 20902231;
const FT_PER_MILE = 5280;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const HEADINGS = {
  N: "north", NE: "northeast", E: "east", SE: "southeast",
  S: "south", SW: "southwest", W: "west", NW: "northwest",
};
const rad = (deg) => (deg * Math.PI) / 180;

/** Reads "29.76, -95.36" or "29.76 -95.36". Returns null when the text isn't coordinates. */
export function parseCoords(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function distanceFeet(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function bearingDegrees(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat))
    - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const compass = (degrees) => COMPASS[Math.round(degrees / 45) % 8];
export const headingWord = (degrees) => HEADINGS[compass(degrees)];

export function formatDistance(feet) {
  const miles = feet / FT_PER_MILE;
  return miles < 0.1 ? `${Math.round(feet).toLocaleString("en-US")} ft` : `${miles.toFixed(1)} mi`;
}

/** Closest point on a polyline of {lat, lon}, using a flat-earth approximation that holds at road scale. */
export function nearestPointOnLine(point, line) {
  const kx = Math.cos(rad(point.lat));
  let best = null;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ax = (line[i].lon - point.lon) * kx;
    const ay = line[i].lat - point.lat;
    const dx = (line[i + 1].lon - point.lon) * kx - ax;
    const dy = line[i + 1].lat - point.lat - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const candidate = { lat: point.lat + ay + t * dy, lon: point.lon + (ax + t * dx) / kx };
    const feet = distanceFeet(point, candidate);
    if (!best || feet < best.feet) best = { ...candidate, feet };
  }
  return best;
}

/** "US 59 (Main Street)", or just the ref when the name only spells it out. */
export function roadLabel(name, ref) {
  const cleanName = (name || "").trim();
  const cleanRef = (ref || "").trim().replaceAll(";", " / ");
  if (cleanRef && cleanName) {
    const nameNumbers = cleanName.match(/\d+/g) || [];
    const refNumbers = cleanRef.match(/\d+/g) || [];
    const sameRoad = refNumbers.length > 0 && refNumbers.every((n) => nameNumbers.includes(n));
    return sameRoad ? cleanRef : `${cleanRef} (${cleanName})`;
  }
  return cleanRef || cleanName;
}

/** Up to `limit` distinct roads from Overpass ways, closest first. */
export function closestRoads(point, ways, limit = 4) {
  const byLabel = new Map();
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const line = way.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    const nearest = nearestPointOnLine(point, line);
    const label = roadLabel(way.tags?.name, way.tags?.ref) || "Unnamed highway";
    if (!byLabel.has(label) || nearest.feet < byLabel.get(label).feet) {
      byLabel.set(label, { label, line, lat: nearest.lat, lon: nearest.lon, feet: nearest.feet });
    }
  }
  return [...byLabel.values()].sort((a, b) => a.feet - b.feet).slice(0, limit);
}

const STRAIGHT_ON = new Set(["straight", "slight left", "slight right", ""]);

/** Turns OSRM route steps into plain sentences that name every road. */
export function directionsFromSteps(steps) {
  const merged = [];
  for (const step of steps) {
    const { type, modifier = "", bearing_after: bearing = 0, exit } = step.maneuver;
    if (type === "arrive") continue;
    const label = roadLabel(step.name, step.ref) || "an unnamed road";
    const feet = step.distance * 3.28084;
    const last = merged[merged.length - 1];
    if (last && last.label === label && ["new name", "continue", "turn"].includes(type)
      && STRAIGHT_ON.has(modifier)) {
      last.feet += feet;
    } else {
      merged.push({ type, modifier, label, feet, heading: headingWord(bearing), exit });
    }
  }

  // A tiny opening step just means the start point sits at a junction
  if (merged.length > 0 && merged[0].feet < 50) merged.shift();

  return merged.map((m, index) => {
    const distance = formatDistance(m.feet);
    if (index === 0 || m.type === "depart") return `Head ${m.heading} on ${m.label} for ${distance}.`;
    if (["roundabout", "rotary", "exit roundabout"].includes(m.type)) {
      const exit = m.exit ? `take exit ${m.exit} ` : "";
      return `At the roundabout, ${exit}onto ${m.label} and go ${distance}.`;
    }
    if (m.type === "off ramp") return `Take the exit toward ${m.label} and go ${distance}.`;
    if (["new name", "continue"].includes(m.type) || m.modifier === "straight") {
      return `Continue ${m.heading} on ${m.label} for ${distance}.`;
    }
    const turn = m.modifier === "uturn" ? "Make a U-turn" : `Turn ${m.modifier || "onto the road"}`;
    return `${turn} onto ${m.label}, heading ${m.heading}, and go ${distance}.`;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

const NAME_HEADERS = ["name", "title", "label", "location", "site"];
const LAT_HEADERS = ["lat", "latitude", "y"];
const LON_HEADERS = ["lon", "lng", "long", "longitude", "x"];

/** Reads a CSV with name, latitude and longitude columns. Bad rows are counted, not fatal. */
export function parseLocationsCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new Error("That file is empty.");
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const column = (names) => headers.findIndex((h) => names.includes(h));
  const nameCol = column(NAME_HEADERS);
  const latCol = column(LAT_HEADERS);
  const lonCol = column(LON_HEADERS);
  if (latCol < 0 || lonCol < 0) {
    throw new Error("The CSV needs a latitude column and a longitude column.");
  }

  const rows = [];
  let skipped = 0;
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line);
    const lat = Number.parseFloat(cells[latCol]);
    const lon = Number.parseFloat(cells[lonCol]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      rows.push({ name: (nameCol >= 0 && cells[nameCol]) || `Row ${index + 2}`, lat, lon });
    } else {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/** Locations within `radiusFeet` of `center`, closest first. */
export function withinRadius(center, locations, radiusFeet) {
  return locations
    .map((location) => ({
      ...location,
      feet: distanceFeet(center, location),
      direction: compass(bearingDegrees(center, location)),
    }))
    .filter((location) => location.feet <= radiusFeet)
    .sort((a, b) => a.feet - b.feet);
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

/** Reads point placemarks from Google Earth KML. Lines and shapes have no single location, so they're counted as skipped. */
export function parseKml(text) {
  const placemarks = text.match(/<(?:\w+:)?Placemark\b[\s\S]*?<\/(?:\w+:)?Placemark>/g) || [];
  const rows = [];
  let skipped = 0;
  placemarks.forEach((placemark, index) => {
    const name = placemark.match(/<(?:\w+:)?name>([\s\S]*?)<\/(?:\w+:)?name>/);
    const point = placemark.match(/<(?:\w+:)?Point\b[\s\S]*?<(?:\w+:)?coordinates>\s*([^<]+?)\s*<\/(?:\w+:)?coordinates>/);
    const [lon, lat] = point ? point[1].split(/[\s,]+/).map(Number) : [];
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      rows.push({ name: (name && decodeXml(name[1])) || `Placemark ${index + 1}`, lat, lon });
    } else {
      skipped += 1;
    }
  });
  return { rows, skipped };
}

/** The map grid square holding a point, so nearby locations can share one highway lookup. */
export function gridCell({ lat, lon }, size = 0.5) {
  const row = Math.floor(lat / size);
  const col = Math.floor(lon / size);
  return {
    key: `${row}:${col}`,
    south: row * size, west: col * size, north: (row + 1) * size, east: (col + 1) * size,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  // Spreadsheets run text starting with these as formulas, and names come from uploaded files
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
