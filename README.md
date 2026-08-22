# Mountaineers Peak Map

Local React + MapLibre application for exploring Mountaineers / Peakbagger peak lists.

## V0.7

V0.7 focuses on speed, resumability, and future-proof caching.

### Startup behavior

The map always reads the local files first:

```text
data/peaks.json
data/lists.json
```

Every mountain successfully imported in an earlier session appears when the app starts. No Peakbagger request is required to display cached mountains.

### Two-layer cache

Parsed data is stored in:

```text
data/peaks.json
data/lists.json
```

The **complete source HTML** for every fetched page is also archived:

```text
data/source/peaks/<pid>.html
data/source/lists/<lid>.html
data/source/meta/*.json
```

The raw HTML archive is deliberate. We cannot know every field the UI may need in the future, so preserving the entire source page is safer than trying to guess every useful field now. Future versions can reparse those archived pages without hitting Peakbagger again.

Each peak also stores convenient parsed source metadata such as generic label/value fields in `sourceAttributes`.

### Checkpointing

Every newly fetched peak is written to `data/peaks.json` immediately.

If an import stops at peak 73 of 100, those 73 are still present. Restarting the import reuses them instead of fetching them again.

Cached peaks are retained even if they currently belong to zero imported lists. This preserves the expensive source cache.

### Faster verified-session fetching

Cloudflare verification remains manual.

After you verify once in the dedicated normal Chrome window, the importer keeps that verified tab open and requests individual peak pages from inside the same Chrome session using same-origin browser `fetch()`.

That avoids full browser navigation for every mountain.

If Peakbagger challenges an individual fast request, the importer falls back to visible Chrome navigation and waits for manual verification rather than failing.

A one-second delay remains between genuinely new Peakbagger peak requests.

## Requirements

- Node.js 22+
- npm
- Python 3.12+
- Google Chrome for macOS

## Install

```bash
npm install
npm run setup:browser
```

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Import a list

Paste a Peakbagger list URL such as:

```text
https://www.peakbagger.com/list.aspx?lid=5045
```

If Cloudflare appears, complete it manually in the Chrome window. The import resumes automatically.

## Important when upgrading versions

**Do not delete or overwrite your `data/` directory.**

That directory contains both your map database and the raw Peakbagger source archive.

The browser-only profile is separate:

```text
.cache/peakbagger-map/chrome-profile/
```

`.cache/` can be deleted if necessary. `data/` is the valuable persistent dataset.

## Build

```bash
npm run build
```

Run the built app locally:

```bash
npm start
```


## Migrating from V0.6 or earlier

Older versions cached only parsed peak fields. V0.7 deliberately treats those
entries as a partial/legacy cache until the corresponding raw source page exists
under:

```text
data/source/peaks/<pid>.html
```

The next time a legacy peak appears in an imported list, V0.7 fetches that peak
page once to backfill the source archive. After that it is fully cached and does
not need to be fetched again merely because we add new parsed fields later.
