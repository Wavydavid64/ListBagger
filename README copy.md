# Mountaineers Peak Map

Local web app for exploring Mountaineers peak-bagging lists on an interactive Washington map.

## Current V0 features

- Interactive Washington map
- Peak markers
- Hover tooltips
- Clickable peak detail popups
- Search by peak name
- Select one or more Mountaineers lists
- ANY / ALL list matching
- All peak/list membership data stored locally in JSON files

## Run locally

Requirements:

- Node.js 20 or newer
- npm

Then:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Production-style local build

```bash
npm run build
npm run preview
```

## Data files

```text
src/data/lists.json
src/data/peaks.json
```

The V0 repository contains only a small representative dataset. The next major step is building the importer that populates these files with the full Mountaineers/Peakbagger list dataset.

## Internet requirement

The application itself and its peak data are local. The current basemap uses remote OpenFreeMap tiles, so map tiles require an internet connection.

If fully offline operation is desired, the map layer can later be replaced with local PMTiles/MBTiles.
