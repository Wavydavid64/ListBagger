# Mountaineers Peak Map

Local React + MapLibre application for exploring Mountaineers / Peakbagger peak lists.

## V0.5

V0.5 changes the Peakbagger browser flow specifically for Cloudflare verification.

The importer **does not attempt to solve or bypass Cloudflare**.

Instead:

1. the app launches regular Google Chrome directly
2. Chrome uses an isolated persistent local profile
3. Playwright attaches to that already-running Chrome through the local Chrome DevTools Protocol
4. if Cloudflare presents a CAPTCHA or managed challenge, you complete it manually
5. the importer waits without a short CAPTCHA timeout
6. once genuine Peakbagger content appears, the import resumes automatically

This also removes the Playwright-launched browser path that previously produced navigation errors such as:

```text
Page.evaluate: Execution context was destroyed
```

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

`setup:browser` creates a repository-local:

```text
.venv/
```

with:

- Playwright
- BeautifulSoup

No `peakbagger-cli` is used.

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Importing

Paste a Peakbagger list URL such as:

```text
https://www.peakbagger.com/list.aspx?lid=5045
```

A dedicated normal Chrome window opens.

### If Cloudflare appears

Complete the verification yourself in that Chrome window.

Do not close the window.

The terminal will display:

```text
Cloudflare verification is waiting in Chrome.
Complete it manually in the Chrome window.
The import will resume automatically afterward.
```

After the real Peakbagger page loads it will print:

```text
Peakbagger verification complete. Resuming import.
```

There is no short CAPTCHA timeout.

## Persistent Chrome profile

The dedicated browser profile is stored in:

```text
.cache/peakbagger-map/chrome-profile/
```

Cookies from a successful manual verification persist there and can be reused by later imports.

This is not your normal personal Chrome profile.

If the dedicated profile becomes corrupted:

```bash
rm -rf .cache/peakbagger-map/chrome-profile
```

Then retry the import.

## Data import behavior

After the list page loads:

1. list membership and Peakbagger IDs are extracted
2. existing IDs in `data/peaks.json` are reused
3. only missing peaks are visited
4. latitude/longitude, elevation and prominence are parsed
5. requests are spaced by two seconds
6. list and peak data are written atomically

Local data:

```text
data/lists.json
data/peaks.json
```

Re-importing a list refreshes its membership.

## Marker encoding

All markers use one neutral color.

Marker size represents the number of imported lists containing the peak.

Marker color is reserved for a future difficulty classification.

## Build

```bash
npm run build
```

Run the production build locally:

```bash
npm start
```
