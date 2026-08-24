# Mountaineers Peak Map — V0.9

Local Washington peak-list explorer using React, MapLibre, SQLite and a browser-assisted Peakbagger importer.

## What changed

V0.9 is the performance architecture pass.

- **SQLite is now the live datastore:** `data/listbagger.db`
- Existing `data/peaks.json` and `data/lists.json` are automatically migrated on first startup if the database is empty.
- Legacy JSON files are not deleted.
- Full raw Peakbagger HTML remains under `data/source/` and is still the future-proof source cache.
- Peak/list memberships are normalized in SQLite instead of repeatedly rewriting a large JSON document.
- Import progress is stored in an `imports` table after each peak, so interrupted imports retain progress and cached data.
- The map no longer creates one React DOM marker per mountain. Peaks are rendered as one MapLibre **GeoJSON circle layer** using WebGL.
- Marker size still represents number of list memberships. Color remains reserved for difficulty.

## Preserve these when upgrading

Do not delete:

```text
data/
.cache/
.venv/
.git/
```

The most important directory is `data/`. It now contains:

```text
data/listbagger.db
data/source/peaks/*.html
data/source/lists/*.html
data/source/meta/*.json
```

## Requirements

- Node.js **22.13+**
- npm
- Python 3.12+
- Google Chrome

V0.9 uses Node's built-in `node:sqlite`; no SQLite npm package is required.

## Install / run

```bash
npm install
npm run build
npm run dev
```

If `.venv` is missing:

```bash
npm run setup:browser
```

Open:

```text
http://127.0.0.1:5173
```

## Automatic JSON → SQLite migration

At startup, if `data/listbagger.db` contains no peaks/lists, the server reads legacy:

```text
data/peaks.json
data/lists.json
```

and imports peaks, lists, source metadata and memberships into SQLite.

Once the DB contains data, SQLite is authoritative. The legacy JSON files remain untouched as a backup.

## Database schema

```text
peaks
lists
peak_list_memberships
source_pages
imports
```

`peakbagger_id` is the canonical peak key.

## Import behavior

Paste any Peakbagger list URL in the Lists tab. The importer:

1. records an import row in SQLite
2. opens the persistent Chrome profile
3. waits for manual Cloudflare verification if necessary
4. parses list membership
5. reuses peaks whose full raw source HTML is cached
6. fetches only missing peak pages
7. upserts each peak and membership directly into SQLite
8. updates import progress after each peak
9. archives all newly fetched HTML under `data/source/`

## Performance

Hundreds or thousands of peaks are rendered through one WebGL layer rather than hundreds/thousands of DOM nodes. Filtering still happens locally, but updating one GeoJSON source is much cheaper than re-rendering a React marker component per peak.
