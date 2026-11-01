# Location Searcher

Find any place, see its closest major road, get turn-by-turn directions that name real roads, and check what's within a set distance of it.

It's a static web page with no backend, no API keys and nothing to install. All it needs is a browser and an internet connection.

## Features

- Search by address, place name or coordinates, or click the map
- Street and satellite views, with a north arrow and scale bar
- Closest major road, chosen by shortest drive rather than straight-line distance
- turn-by-turn directions from that road, with a copy button
- Upload Google Earth KML or KMZ files, or a CSV
- Batch directions for up to 500 locations, with stop, resume and CSV download
- Nearby: see which uploaded locations fall inside a radius of any place

## How it works

1. **Find the place.** Nominatim turns the search into coordinates. Typed coordinates skip this step.
2. **Find major roads.** Overpass returns highways and main streets nearby, and the app keeps the closest few.
3. **Pick the closest by road.** OSRM routes from each one, and the shortest drive wins, so a river or border can't make a road look closer than it is.
4. **Write directions.** The route's steps become plain sentences naming each road.

Batch runs do the same for each location, one at a time. Nearby locations share one road download, which keeps requests down. If the services fail three times in a row, the batch pauses so you can resume later without losing finished work.

Uploaded files are read in your browser and never uploaded. Their coordinates are sent to the map services above to do the lookups, so check you're comfortable with that for sensitive locations.

## Run it locally

The page uses JavaScript modules, so it has to be served rather than opened as a file:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Upload formats

**KML and KMZ:** export from Google Earth with right-click, then "Save Place As". Point placemarks are read; lines and shapes are skipped.

**CSV:** needs a latitude column and a longitude column. A name column is optional. Accepted headers:

| Field | Headers |
|---|---|
| Name | `name`, `title`, `label`, `location`, `site` |
| Latitude | `lat`, `latitude`, `y` |
| Longitude | `lon`, `lng`, `long`, `longitude`, `x` |

See [`sample-locations.csv`](sample-locations.csv).

## Tests

```bash
npm test
```

No packages are needed; the tests use Node's built-in test runner.

## Data sources

| Purpose | Service |
|---|---|
| Search | [Nominatim](https://nominatim.org/) |
| Major roads | [Overpass API](https://overpass-api.de/) |
| Routing | [OSRM demo server](https://project-osrm.org/) |
| Map | [OpenStreetMap](https://www.openstreetmap.org/), [Esri World Imagery](https://www.esri.com/) |

These are free public services with usage limits and no uptime guarantee, so this project suits light personal use. Heavier use should run its own servers or a paid provider. Road lookups can take up to a minute when Overpass is busy.

Map data © OpenStreetMap contributors. Check road access yourself; directions may not reflect private roads, gates or closures.

## License

[MIT](LICENSE)
