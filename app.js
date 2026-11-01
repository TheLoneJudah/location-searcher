import {
  areaBoxes, bearingDegrees, closestRoads, directionsFromSteps, distanceFeet, formatDistance, gridCell,
  headingWord, parseCoords, parseKml, parseLocationsCsv, toCsv, withinRadius,
} from "./geo.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const HIGHWAY_CLASSES = "motorway|trunk|primary|secondary";
const SEARCH_RADII_M = [10000, 30000, 80000];
const OVERPASS_ROUNDS = 3;
const OVERPASS_TIMEOUT_MS = 25000;
const OVERPASS_HEDGE_MS = 4000;     // how long one server gets before the next is tried alongside it
const FT_PER_UNIT = { ft: 1, mi: 5280, m: 3.28084, km: 3280.84 };

const BATCH_LIMIT = 500;
const SECONDS_PER_LOCATION = 5;
const NOMINATIM_GAP_MS = 1100;      // Nominatim's public limit is one request a second
const AREA_SIZE_DEG = 0.25;         // locations inside one grid square share a road download
const AREA_BUFFER_DEG = 0.15;       // highways fetched beyond the locations in each square
const FEET_PER_DEG_LAT = 364000;
const MAX_FAILURES_IN_A_ROW = 3;    // a run of failures means a service is down, so stop and let the user resume

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const coordText = ({ lat, lon }) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
});
const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Imagery &copy; Esri" },
);

const map = L.map("map", { layers: [streets], zoomControl: false }).setView([39.5, -98.35], 4);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.control.layers({ Streets: streets, Satellite: satellite }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: true, metric: true, position: "bottomright" }).addTo(map);

const NorthArrow = L.Control.extend({
  onAdd() {
    const arrow = L.DomUtil.create("div", "north-arrow");
    arrow.setAttribute("role", "img");
    arrow.setAttribute("aria-label", "North is up");
    arrow.innerHTML = '<svg viewBox="0 0 24 36" aria-hidden="true"><path d="M12 2 4 24l8-5z"/>'
      + '<path class="hollow" d="M12 2l8 22-8-5z"/><text x="12" y="34">N</text></svg>';
    return arrow;
  },
});
new NorthArrow({ position: "topright" }).addTo(map);

const fileLayer = L.layerGroup().addTo(map);
const radiusLayer = L.layerGroup().addTo(map);
const resultLayer = L.layerGroup().addTo(map);
const pin = L.divIcon({ className: "pin" });

let current = null;           // the searched location on the map
let locations = [];           // rows from the uploaded file; these stay in the browser
let batch = [];               // one entry per location once a batch has run
let batchRunning = false;
let stopRequested = false;
let searchToken = 0;          // ignores slow answers from a search that has been replaced
let overpassOrder = OVERPASS_ENDPOINTS;  // the last server to answer goes first
let areas = new Map();        // the box to fetch for each grid square in the batch
const areaCache = new Map();  // highways per grid square, shared by nearby locations

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Map service answered ${response.status}`);
  return response.json();
}

async function geocode(query) {
  const params = new URLSearchParams({ format: "jsonv2", q: query, limit: "1" });
  const [hit] = await fetchJson(`${NOMINATIM}/search?${params}`);
  return hit && { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
}

async function reverseGeocode({ lat, lon }, zoom = 14) {
  const params = new URLSearchParams({ format: "jsonv2", lat, lon, zoom, addressdetails: "1" });
  return fetchJson(`${NOMINATIM}/reverse?${params}`);
}

/** Gives each server a head start, then asks the next alongside it. The first good answer wins. */
async function firstOverpassAnswer(query) {
  const answered = new AbortController();
  const attempts = overpassOrder.map(async (url, index) => {
    await sleep(index * OVERPASS_HEDGE_MS);
    if (answered.signal.aborted) throw new Error("Another server answered");
    const data = await fetchJson(url, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.any([answered.signal, AbortSignal.timeout(OVERPASS_TIMEOUT_MS)]),
    });
    // An overloaded server can answer 200 with no results and a remark explaining why
    if (data.remark) throw new Error(data.remark);
    return { url, data };
  });
  try {
    const { url, data } = await Promise.any(attempts);
    overpassOrder = [url, ...overpassOrder.filter((other) => other !== url)];
    return data;
  } finally {
    answered.abort();
  }
}

/** The public Overpass servers are often busy, so try again over a few rounds. */
async function overpass(query) {
  let lastError;
  for (let round = 1; round <= OVERPASS_ROUNDS; round += 1) {
    try {
      return await firstOverpassAnswer(query);
    } catch (error) {
      lastError = error;
    }
    if (round < OVERPASS_ROUNDS) {
      setStatus(`The road data server is busy. Retrying (${round + 1} of ${OVERPASS_ROUNDS})…`);
      await sleep(round * 3000);
    }
  }
  throw lastError;
}

async function highwaysAround(point) {
  for (const radius of SEARCH_RADII_M) {
    const query = `[out:json][timeout:30];way(around:${radius},${point.lat},${point.lon})`
      + `[highway~"^(${HIGHWAY_CLASSES})$"];out tags geom;`;
    const data = await overpass(query);
    const roads = closestRoads(point, data.elements || []);
    if (roads.length) return roads;
  }
  return [];
}

/** Batch version: fetch each grid square once, and reuse it for every location inside. */
async function highwaysFromArea(point) {
  const { key } = gridCell(point, AREA_SIZE_DEG);
  if (!areaCache.has(key)) {
    const { south, west, north, east } = areas.get(key);
    const query = `[out:json][timeout:25];way(${south},${west},${north},${east})`
      + `[highway~"^(${HIGHWAY_CLASSES})$"];out tags geom;`;
    const data = await overpass(query);
    areaCache.set(key, data.elements || []);
  }
  const roads = closestRoads(point, areaCache.get(key));
  // A road outside the fetched area could be closer, so only trust ones well inside the buffer
  const trustedFeet = 0.9 * AREA_BUFFER_DEG * FEET_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
  return roads.length > 0 && roads.every((road) => road.feet < trustedFeet) ? roads : highwaysAround(point);
}

async function route(from, to) {
  const path = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const data = await fetchJson(`${OSRM}/route/v1/driving/${path}?steps=true&geometries=geojson&overview=full`);
  return data.code === "Ok" && data.routes.length ? data : null;
}

/** The closest highway is the one with the shortest drive, not the shortest straight line. */
async function bestHighwayRoute(point, findHighways = highwaysAround) {
  const roads = await findHighways(point);
  const routes = await Promise.all(roads.map((road) => route(road, point).catch(() => null)));
  let best = null;
  routes.forEach((result, index) => {
    if (!result) return;
    const metres = result.routes[0].distance + (result.waypoints[1].distance || 0);
    if (!best || metres < best.metres) best = { road: roads[index], result, metres };
  });
  return best || (roads[0] ? { road: roads[0], result: null } : null);
}

function buildDirections(point, { road, result }) {
  if (!result) {
    const feet = distanceFeet(road, point);
    const heading = headingWord(bearingDegrees(road, point));
    return [`This location is ${formatDistance(feet)} ${heading} of ${road.label} in a straight line. No driving route was found.`];
  }
  const steps = directionsFromSteps(result.routes[0].legs[0].steps);
  const [endLon, endLat] = result.waypoints[1].location;
  const end = { lat: endLat, lon: endLon };
  const offRoadFeet = distanceFeet(end, point);
  const offRoad = `${formatDistance(offRoadFeet)} ${headingWord(bearingDegrees(end, point))}`;
  if (offRoadFeet > 100 && steps.length === 0) {
    steps.push(`The destination is about ${offRoad} of ${road.label}.`);
  } else if (offRoadFeet > 100) {
    steps.push(`The mapped road ends here. The destination is about ${offRoad}.`);
  } else {
    steps.push("Arrive at the destination.");
  }
  return steps;
}

function drawRoute({ road, result }, point) {
  L.polyline(road.line.map((p) => [p.lat, p.lon]), { color: "#a9812f", weight: 5, opacity: 0.75 }).addTo(resultLayer);
  L.circleMarker([road.lat, road.lon], { radius: 6, color: "#faf8f3", weight: 2, fillColor: "#a9812f", fillOpacity: 1 })
    .bindTooltip(`Road access: ${road.label}`).addTo(resultLayer);
  const bounds = L.latLngBounds([[point.lat, point.lon], [road.lat, road.lon]]);
  if (result) {
    const path = result.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    L.polyline(path, { color: "#1f4d3f", weight: 4 }).addTo(resultLayer);
    path.forEach((p) => bounds.extend(p));
  }
  map.fitBounds(bounds.pad(0.2), panelPadding());
}

/** Keeps fitted content clear of the floating panel. */
function panelPadding() {
  return window.innerWidth > 760 ? { paddingTopLeft: [430, 20] } : {};
}

function showSteps(steps, highway) {
  $("highway").textContent = highway;
  $("highway-line").hidden = false;
  $("steps").replaceChildren(...steps.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
  $("copy").hidden = false;
}

function showLocation(point, label) {
  current = { ...point, label };
  resultLayer.clearLayers();
  L.marker([point.lat, point.lon], { icon: pin, title: label, alt: label }).addTo(resultLayer);
  map.setView([point.lat, point.lon], 14);
  $("place").textContent = label;
  $("coords").textContent = coordText(point);
  $("navigate").href = `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}&travelmode=driving`;
  $("highway-line").hidden = true;
  $("steps").replaceChildren();
  $("copy").hidden = true;
  $("result").hidden = false;
  updateRadiusResults();
}

async function search(query) {
  const token = ++searchToken;
  setStatus("Searching…");
  try {
    let point = parseCoords(query);
    let label;
    if (point) {
      label = await reverseGeocode(point).then((hit) => hit.display_name).catch(() => null);
      label = label || coordText(point);
    } else {
      const hit = await geocode(query);
      if (!hit) {
        setStatus(`No results for “${query}”. Try adding a city or state.`, true);
        return;
      }
      point = hit;
      label = hit.label;
    }
    if (token !== searchToken) return;
    showLocation(point, label);

    setStatus("Finding the closest major road…");
    const best = await bestHighwayRoute(point);
    if (token !== searchToken) return;
    if (!best) {
      setStatus("No major road found within 50 miles.");
      return;
    }
    drawRoute(best, point);
    showSteps(buildDirections(point, best), best.road.label);
    setStatus("");
  } catch (error) {
    if (token !== searchToken) return;
    const located = current ? " The location is shown, but directions could not be loaded." : "";
    setStatus(`A free map service is busy right now.${located} Please try again in a few minutes.`, true);
    console.error(error);
  }
}

function showTab(name) {
  for (const tab of ["search", "batch"]) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`view-${tab}`).hidden = tab !== name;
  }
}

async function readLocations(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv") return parseLocationsCsv(await file.text());
  if (extension === "kml") return parseKml(await file.text());
  if (extension === "kmz") {
    const zip = await JSZip.loadAsync(file);
    const kml = zip.file("doc.kml") || zip.file(/\.kml$/i)[0];
    if (!kml) throw new Error("That KMZ doesn't contain a KML file.");
    return parseKml(await kml.async("string"));
  }
  throw new Error("Please choose a KML, KMZ or CSV file.");
}

function batchEstimate(count) {
  const minutes = Math.ceil((count * SECONDS_PER_LOCATION) / 60);
  return `${count > BATCH_LIMIT ? `The first ${BATCH_LIMIT} locations will run. ` : ""}`
    + `Finds the county, closest major road and directions for each location. Allow about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

async function loadFile(file) {
  if (!file) return;
  if (batchRunning) {
    setStatus("Stop the current batch before loading another file.", true);
    return;
  }
  try {
    const { rows, skipped } = await readLocations(file);
    if (rows.length === 0) throw new Error("No point locations found in that file.");
    locations = rows;
    batch = [];
    areaCache.clear();
    $("batch-list").replaceChildren();
    $("download").hidden = true;
    $("progress").hidden = true;
    $("run").textContent = "Start";
    $("run").hidden = false;
    $("file-tools").hidden = false;
    const skippedNote = skipped ? `, ${skipped} skipped (no single point)` : "";
    $("file-summary").textContent = `${file.name}: ${rows.length} location${rows.length === 1 ? "" : "s"}${skippedNote}`;
    $("batch-estimate").textContent = batchEstimate(rows.length);
    setStatus("");

    fileLayer.clearLayers();
    const points = rows.map((row) => [row.lat, row.lon]);
    for (const row of rows) {
      L.circleMarker([row.lat, row.lon], { radius: 4, color: "#faf8f3", weight: 1.5, fillColor: "#1f4d3f", fillOpacity: 1 })
        .bindTooltip(row.name).addTo(fileLayer);
    }
    map.fitBounds(L.latLngBounds(points).pad(0.1), { ...panelPadding(), maxZoom: 14 });
    updateRadiusResults();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function lookUp(entry) {
  const hit = await reverseGeocode(entry, 10).catch(() => null);
  entry.county = hit?.address?.county || "";
  entry.state = hit?.address?.state || "";
  const best = await bestHighwayRoute(entry, highwaysFromArea);
  if (!best) throw new Error("No major road within 50 miles");
  entry.best = best;
  entry.highway = best.road.label;
  entry.miles = best.result ? best.metres / 1609.344 : null;
  entry.steps = buildDirections(entry, best);
}

function renderRow(entry) {
  const item = entry.element || document.createElement("li");
  entry.element = item;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "batch-row";
  const text = document.createElement("span");
  const name = document.createElement("span");
  name.textContent = entry.name;
  const detail = document.createElement("small");
  detail.textContent = entry.status === "failed" ? "Lookup failed" : [entry.highway, entry.county].filter(Boolean).join(" · ");
  text.append(name, detail);
  const badge = document.createElement("span");
  badge.className = `badge ${entry.status === "failed" ? "failed" : ""}`;
  badge.textContent = entry.status === "failed" ? "Retry later" : entry.miles === null ? "No route" : `${entry.miles.toFixed(1)} mi`;
  button.append(text, badge);
  button.addEventListener("click", () => openEntry(entry));
  item.replaceChildren(button);
  return item;
}

function openEntry(entry) {
  showTab("search");
  showLocation(entry, entry.name);
  $("query").value = coordText(entry);
  if (entry.best) {
    drawRoute(entry.best, entry);
    showSteps(entry.steps, entry.highway);
  }
}

function setProgress(done, total) {
  $("progress").hidden = false;
  $("progress-bar").style.width = `${(done / total) * 100}%`;
}

function setRunning(running) {
  batchRunning = running;
  $("run").hidden = running;
  $("stop").hidden = !running;
  $("stop").disabled = false;
}

async function runBatch() {
  if (batch.length === 0) {
    batch = locations.slice(0, BATCH_LIMIT).map((row) => ({ ...row, status: "pending" }));
    areas = areaBoxes(batch, AREA_SIZE_DEG, AREA_BUFFER_DEG);
  }
  const queue = batch.filter((entry) => entry.status !== "done");
  const total = batch.length;
  stopRequested = false;
  setRunning(true);
  let failuresInARow = 0;

  for (const entry of queue) {
    if (stopRequested) break;
    setStatus(`Looking up ${entry.name}…`);
    const started = Date.now();
    try {
      await lookUp(entry);
      entry.status = "done";
      failuresInARow = 0;
    } catch (error) {
      entry.status = "failed";
      failuresInARow += 1;
      console.error(entry.name, error);
    }
    const row = renderRow(entry);
    if (!row.isConnected) $("batch-list").append(row);
    const done = batch.filter((item) => item.status === "done").length;
    setProgress(done, total);
    $("download").hidden = done === 0;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
    await sleep(Math.max(0, NOMINATIM_GAP_MS - (Date.now() - started)));
  }

  setRunning(false);
  const done = batch.filter((entry) => entry.status === "done").length;
  const failed = batch.filter((entry) => entry.status === "failed").length;
  if (done === total) {
    $("run").hidden = true;
    setStatus(`Finished all ${total} locations.`);
  } else {
    $("run").textContent = "Resume";
    const reason = failuresInARow >= MAX_FAILURES_IN_A_ROW
      ? "Paused because the map services are busy. Try Resume in a few minutes."
      : stopRequested ? "Stopped." : "Some lookups failed. Try Resume in a few minutes.";
    setStatus(`${reason} ${done} of ${total} done${failed ? `, ${failed} failed` : ""}.`, failuresInARow >= MAX_FAILURES_IN_A_ROW);
  }
}

function downloadResults() {
  const rows = batch.filter((entry) => entry.status === "done").map((entry) => [
    entry.name, entry.lat, entry.lon, entry.county, entry.state, entry.highway,
    entry.miles === null ? "" : Number(entry.miles.toFixed(2)),
    entry.steps.map((step, index) => `${index + 1}. ${step}`).join(" "),
    `https://www.google.com/maps/dir/?api=1&destination=${entry.lat},${entry.lon}&travelmode=driving`,
  ]);
  const csv = toCsv(
    ["Name", "Latitude", "Longitude", "County", "State", "Closest major road", "Miles from major road", "Directions", "Google Maps"],
    rows,
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  link.download = "location-directions.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function updateRadiusResults() {
  radiusLayer.clearLayers();
  const list = $("radius-list");
  list.replaceChildren();
  if (locations.length === 0) return;
  if (!current) {
    $("radius-summary").textContent = "";
    return;
  }
  const radiusFeet = Number($("radius").value) * FT_PER_UNIT[$("unit").value];
  if (!(radiusFeet > 0)) {
    $("radius-summary").textContent = "Enter a radius above zero.";
    return;
  }
  const hits = withinRadius(current, locations, radiusFeet);
  $("radius-summary").textContent = `${hits.length} of ${locations.length} within range of ${current.label.split(",")[0]}.`;
  L.circle([current.lat, current.lon], { radius: radiusFeet / 3.28084, color: "#a9812f", weight: 1.5, fillOpacity: 0.06 })
    .addTo(radiusLayer);
  for (const hit of hits) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = hit.name;
    const distance = document.createElement("span");
    distance.textContent = `${formatDistance(hit.feet)} ${hit.direction}`;
    item.append(name, distance);
    list.append(item);
  }
}

$("tab-search").addEventListener("click", () => showTab("search"));
$("tab-batch").addEventListener("click", () => showTab("batch"));

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("query").value.trim();
  if (query) search(query);
});

map.on("click", ({ latlng }) => {
  const text = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  $("query").value = text;
  showTab("search");
  search(text);
});

$("copy").addEventListener("click", async () => {
  const steps = [...$("steps").children].map((item, index) => `${index + 1}. ${item.textContent}`);
  const text = [`Directions to ${current.label}`, `From ${$("highway").textContent}:`, ...steps,
    `GPS: ${coordText(current)}`].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Directions copied.");
  } catch {
    setStatus("Your browser blocked copying. Select the directions and copy them by hand.", true);
  }
});

$("file").addEventListener("change", (event) => {
  loadFile(event.target.files[0]);
  event.target.value = "";
});

const dropzone = $("dropzone");
for (const type of ["dragenter", "dragover"]) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  loadFile(event.dataTransfer.files[0]);
});

$("run").addEventListener("click", runBatch);
$("stop").addEventListener("click", () => {
  stopRequested = true;
  $("stop").disabled = true;
  setStatus("Stopping after this location…");
});
$("download").addEventListener("click", downloadResults);
$("radius").addEventListener("input", updateRadiusResults);
$("unit").addEventListener("change", updateRadiusResults);
