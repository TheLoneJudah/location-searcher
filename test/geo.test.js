import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closestRoads, compass, directionsFromSteps, distanceFeet, formatDistance, gridCell, nearestPointOnLine,
  parseCoords, parseKml, parseLocationsCsv, roadLabel, toCsv, withinRadius,
} from "../geo.js";

const step = (type, modifier, name, distance, bearing = 0, ref) => ({
  name, ref, distance, maneuver: { type, modifier, bearing_after: bearing },
});

test("parseCoords reads comma and space separated pairs", () => {
  assert.deepEqual(parseCoords("29.76, -95.36"), { lat: 29.76, lon: -95.36 });
  assert.deepEqual(parseCoords(" 29.76 -95.36 "), { lat: 29.76, lon: -95.36 });
});

test("parseCoords rejects addresses and out-of-range values", () => {
  assert.equal(parseCoords("123 Main Street"), null);
  assert.equal(parseCoords("95.0, 10.0"), null);
  assert.equal(parseCoords("10.0, 200.0"), null);
});

test("distanceFeet matches a known distance", () => {
  const miles = distanceFeet({ lat: 29.7604, lon: -95.3698 }, { lat: 29.4241, lon: -98.4936 }) / 5280;
  assert.ok(Math.abs(miles - 189) < 2, `got ${miles}`);
});

test("compass wraps around north", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(359), "N");
  assert.equal(compass(135), "SE");
});

test("formatDistance switches from feet to miles", () => {
  assert.equal(formatDistance(420), "420 ft");
  assert.equal(formatDistance(7920), "1.5 mi");
});

test("nearestPointOnLine lands on the segment, not just a vertex", () => {
  const nearest = nearestPointOnLine({ lat: 1, lon: 0.5 }, [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  assert.ok(Math.abs(nearest.lat) < 1e-9);
  assert.ok(Math.abs(nearest.lon - 0.5) < 1e-3);
});

test("roadLabel drops a name that only spells out the ref", () => {
  assert.equal(roadLabel("Farm-to-Market Road 665", "FM 665"), "FM 665");
  assert.equal(roadLabel("Old Brownsville Road", "FM 665;FM 763"), "FM 665 / FM 763 (Old Brownsville Road)");
  assert.equal(roadLabel("Main Street", ""), "Main Street");
  assert.equal(roadLabel("", ""), "");
});

test("closestRoads keeps one entry per road, nearest first", () => {
  const way = (name, lat) => ({ tags: { name }, geometry: [{ lat, lon: -1 }, { lat, lon: 1 }] });
  const roads = closestRoads({ lat: 0, lon: 0 }, [way("Far", 0.2), way("Near", 0.1), way("Near", 0.15), { tags: {} }]);
  assert.deepEqual(roads.map((r) => r.label), ["Near", "Far"]);
  assert.ok(Math.abs(roads[0].lat - 0.1) < 1e-9);
});

test("directionsFromSteps names roads and merges straight-on steps", () => {
  const lines = directionsFromSteps([
    step("depart", "", "Main Street", 1000, 90),
    step("new name", "straight", "Main Street", 1000, 90),
    step("turn", "left", "", 500, 0, "US 59"),
    step("arrive", "", "", 0),
  ]);
  assert.deepEqual(lines, ["Head east on Main Street for 1.2 mi.", "Turn left onto US 59, heading north, and go 0.3 mi."]);
});

test("directionsFromSteps skips a tiny opening step", () => {
  const lines = directionsFromSteps([
    step("depart", "", "US 59", 1, 90),
    step("turn", "right", "Oak Lane", 800, 180),
  ]);
  assert.deepEqual(lines, ["Head south on Oak Lane for 0.5 mi."]);
});

test("parseLocationsCsv handles quotes, a BOM, header variants and bad rows", () => {
  const csv = '﻿Name,Lat,Lng\n"Smith, John",29.5,-95.1\nBroken,abc,-95\nPlain,30,-96\n';
  const { rows, skipped } = parseLocationsCsv(csv);
  assert.equal(skipped, 1);
  assert.deepEqual(rows, [
    { name: "Smith, John", lat: 29.5, lon: -95.1 },
    { name: "Plain", lat: 30, lon: -96 },
  ]);
});

test("parseLocationsCsv explains a missing coordinate column", () => {
  assert.throws(() => parseLocationsCsv("name,city\nA,B\n"), /latitude column/);
});

test("withinRadius filters and sorts by distance", () => {
  const center = { lat: 0, lon: 0 };
  const hits = withinRadius(center, [
    { name: "Far", lat: 1, lon: 0 },
    { name: "Second", lat: 0.002, lon: 0 },
    { name: "First", lat: 0.001, lon: 0 },
  ], 500);
  assert.deepEqual(hits.map((h) => h.name), ["First"]);
  assert.equal(hits[0].direction, "N");
});

test("parseKml reads points, decodes names and skips shapes", () => {
  const kml = `<kml><Document><Folder>
    <Placemark><name>Tom &amp; Jerry&apos;s</name><Point><coordinates>-95.1,29.5,0</coordinates></Point></Placemark>
    <Placemark><name><![CDATA[Cabin <2>]]></name><Point><coordinates> -96.2,30.5 </coordinates></Point></Placemark>
    <Placemark><Point><coordinates>-97,31</coordinates></Point></Placemark>
    <Placemark><name>Route</name><LineString><coordinates>-95,29 -96,30</coordinates></LineString></Placemark>
  </Folder></Document></kml>`;
  const { rows, skipped } = parseKml(kml);
  assert.equal(skipped, 1);
  assert.deepEqual(rows, [
    { name: "Tom & Jerry's", lat: 29.5, lon: -95.1 },
    { name: "Cabin <2>", lat: 30.5, lon: -96.2 },
    { name: "Placemark 3", lat: 31, lon: -97 },
  ]);
});

test("gridCell groups nearby points and handles negative coordinates", () => {
  assert.equal(gridCell({ lat: 29.51, lon: -95.2 }).key, gridCell({ lat: 29.9, lon: -95.4 }).key);
  assert.notEqual(gridCell({ lat: 29.49, lon: -95.2 }).key, gridCell({ lat: 29.51, lon: -95.2 }).key);
  const cell = gridCell({ lat: 29.51, lon: -95.2 });
  assert.deepEqual([cell.south, cell.north, cell.west, cell.east], [29.5, 30, -95.5, -95]);
});

test("toCsv quotes text and defuses spreadsheet formulas", () => {
  const csv = toCsv(["Name", "Lon"], [['Smith, "Jo"', -95.1], ["=SUM(A1)", 2], [null, 3]]);
  assert.equal(csv, ["Name,Lon", '"Smith, ""Jo""",-95.1', "'=SUM(A1),2", ",3"].join("\r\n"));
});

test("directionsFromSteps drops a lone tiny step", () => {
  assert.deepEqual(directionsFromSteps([step("depart", "", "Main Street", 0, 90), step("arrive", "", "", 0)]), []);
});
