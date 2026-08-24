import { useEffect, useMemo, useRef, useState } from "react";
import MapView, {
  Layer,
  NavigationControl,
  Popup,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from "react-map-gl/maplibre";
import type {
  AppData,
  ImportResult,
  ImportRow,
  MatchMode,
  Peak,
  PeakList,
} from "./types";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
type Panel = "map" | "lists";
type Validation = {
  errors: number;
  warnings: number;
  issues: Array<{
    severity: "error" | "warning";
    code: string;
    message: string;
    entity?: string;
  }>;
};

export default function App() {
  const mapRef = useRef<MapRef | null>(null);
  const [lists, setLists] = useState<PeakList[]>([]);
  const [peaks, setPeaks] = useState<Peak[]>([]);
  const [selectedLists, setSelectedLists] = useState<string[]>([]);
  const [mode, setMode] = useState<MatchMode>("any");
  const [search, setSearch] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [minMemberships, setMinMemberships] = useState(1);
  const [selectedPeak, setSelectedPeak] = useState<Peak | null>(null);
  const [hoveredPeak, setHoveredPeak] = useState<Peak | null>(null);
  const [panel, setPanel] = useState<Panel>("map");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [importerReady, setImporterReady] = useState<boolean | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [imports, setImports] = useState<ImportRow[]>([]);

  async function loadData(preserveSelection = true) {
    const response = await fetch("/api/data");
    if (!response.ok) throw new Error("Could not load local data.");
    const data = (await response.json()) as AppData;
    setLists(data.lists);
    setPeaks(data.peaks);
    setSelectedLists((current) => {
      if (!preserveSelection || current.length === 0) {
        return data.lists.map((list) => list.id);
      }
      const validIds = new Set(data.lists.map((list) => list.id));
      return current.filter((id) => validIds.has(id));
    });
  }

  async function loadImports() {
    const response = await fetch("/api/imports");
    if (response.ok) setImports((await response.json()) as ImportRow[]);
  }

  useEffect(() => {
    void loadData(false);
    void loadImports();
    void fetch("/api/importer-status")
      .then((response) => response.json())
      .then((status: { ready: boolean }) => setImporterReady(Boolean(status.ready)))
      .catch(() => setImporterReady(false));
  }, []);

  useEffect(() => {
    if (!importing) return;
    const timer = window.setInterval(() => {
      void loadData(true);
      void loadImports();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [importing]);

  const listById = useMemo(
    () => new Map(lists.map((list) => [list.id, list] as const)),
    [lists],
  );

  const membershipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const peak of peaks) {
      for (const id of peak.listIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [peaks]);

  const visibleLists = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return lists;
    return lists.filter((list) =>
      `${list.name} ${list.peakbaggerListId}`.toLowerCase().includes(query),
    );
  }, [lists, listSearch]);

  const visiblePeaks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return peaks.filter((peak) => {
      if (query && !peak.name.toLowerCase().includes(query)) return false;
      if (peak.listIds.length < minMemberships) return false;
      if (selectedLists.length === 0) return true;
      return mode === "any"
        ? selectedLists.some((id) => peak.listIds.includes(id))
        : selectedLists.every((id) => peak.listIds.includes(id));
    });
  }, [peaks, search, minMemberships, selectedLists, mode]);

  const peakById = useMemo(
    () => new Map(peaks.map((peak) => [peak.peakbaggerId, peak] as const)),
    [peaks],
  );

  const geojson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: visiblePeaks.map((peak) => ({
        type: "Feature" as const,
        id: peak.peakbaggerId,
        geometry: {
          type: "Point" as const,
          coordinates: [peak.longitude, peak.latitude],
        },
        properties: {
          peakbaggerId: peak.peakbaggerId,
          name: peak.name,
          listCount: peak.listIds.length,
          elevationFt: peak.elevationFt,
        },
      })),
    }),
    [visiblePeaks],
  );

  function toggleList(id: string) {
    setSelectedLists((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function pickFeature(event: MapLayerMouseEvent) {
    const feature = event.features?.[0];
    const pid = Number(feature?.properties?.peakbaggerId);
    return Number.isFinite(pid) ? peakById.get(pid) ?? null : null;
  }

  function zoomVisible() {
    const map = mapRef.current?.getMap();
    if (!map || visiblePeaks.length === 0) return;
    if (visiblePeaks.length === 1) {
      map.easeTo({
        center: [visiblePeaks[0].longitude, visiblePeaks[0].latitude],
        zoom: 11,
      });
      return;
    }
    const longitudes = visiblePeaks.map((peak) => peak.longitude);
    const latitudes = visiblePeaks.map((peak) => peak.latitude);
    map.fitBounds(
      [
        [Math.min(...longitudes), Math.min(...latitudes)],
        [Math.max(...longitudes), Math.max(...latitudes)],
      ],
      { padding: 70, duration: 600 },
    );
  }

  async function runImport(url: string) {
    setImporting(true);
    setImportError("");
    setImportMessage(
      "Chrome may open. Complete Cloudflare manually if asked; cached peaks are reused.",
    );
    try {
      const response = await fetch("/api/import-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await response.json()) as ImportResult | { error: string };
      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : "Import failed.");
      }
      setImportMessage(
        `Imported ${body.list.name}: ${body.addedPeaks} new, ${body.reusedPeaks} cached.`,
      );
      setImportUrl("");
      await loadData(true);
      await loadImports();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  async function validate() {
    const response = await fetch("/api/validate");
    if (response.ok) setValidation((await response.json()) as Validation);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">WASHINGTON</div>
          <h1>Mountaineers Peak Map</h1>
          <p>
            {peaks.length} cached peaks · {lists.length} lists · SQLite + WebGL
          </p>
        </div>

        <div className="top-tabs">
          <button className={panel === "map" ? "active" : ""} onClick={() => setPanel("map")}>Map</button>
          <button className={panel === "lists" ? "active" : ""} onClick={() => setPanel("lists")}>Lists</button>
        </div>

        {panel === "map" ? (
          <>
            <label className="search-block">
              <span>Search peaks</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Little Tahoma…" />
            </label>

            <section>
              <div className="section-heading">Match selected lists</div>
              <div className="mode-switch">
                <button className={mode === "any" ? "active" : ""} onClick={() => setMode("any")}>ANY</button>
                <button className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}>ALL</button>
              </div>
            </section>

            <section>
              <div className="section-heading">Membership count</div>
              <select className="select-input" value={minMemberships} onChange={(event) => setMinMemberships(Number(event.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n === 1 ? "Any number of lists" : `${n}+ lists`}</option>
                ))}
              </select>
            </section>

            <section className="list-section">
              <div className="section-heading">Peak lists</div>
              <input className="mini-search" value={listSearch} onChange={(event) => setListSearch(event.target.value)} placeholder="Filter list names…" />
              <div className="list-controls">
                <button onClick={() => setSelectedLists(lists.map((list) => list.id))}>All</button>
                <button onClick={() => setSelectedLists([])}>Clear</button>
                <button onClick={zoomVisible}>Zoom</button>
              </div>
              <div className="list-items">
                {visibleLists.map((list) => (
                  <label key={list.id} className="list-row">
                    <input type="checkbox" checked={selectedLists.includes(list.id)} onChange={() => toggleList(list.id)} />
                    <span className="list-name">{list.name}</span>
                    <span className="list-count">{membershipCounts.get(list.id) ?? 0}</span>
                  </label>
                ))}
              </div>
            </section>

            <div className="result-count"><strong>{visiblePeaks.length}</strong> visible peaks</div>
          </>
        ) : (
          <>
            <section>
              <div className="section-heading">Add Peakbagger list</div>
              <form className="import-form" onSubmit={(event) => { event.preventDefault(); void runImport(importUrl); }}>
                <input value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://www.peakbagger.com/list.aspx?lid=…" />
                <button disabled={importing || importerReady === false}>{importing ? "Importing…" : "Import list"}</button>
              </form>
              {importerReady === false && <p className="status error">Run: npm run setup:browser</p>}
              {importMessage && <p className="status">{importMessage}</p>}
              {importError && <p className="status error">{importError}</p>}
            </section>

            <section>
              <div className="section-heading">Imported lists</div>
              <div className="manager-list">
                {lists.map((list) => (
                  <div className="manager-row" key={list.id}>
                    <div className="manager-main">
                      <strong>{list.name}</strong>
                      <div className="manager-meta">
                        {membershipCounts.get(list.id) ?? 0} memberships
                        {list.sourceFetchedAt ? ` · ${new Date(list.sourceFetchedAt).toLocaleString()}` : ""}
                      </div>
                    </div>
                    <button disabled={importing} onClick={() => void runImport(list.sourceUrl)}>Re-import</button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="section-heading">Recent imports</div>
              <div className="manager-list">
                {imports.slice(0, 8).map((item) => (
                  <div className="manager-row" key={item.id}>
                    <div className="manager-main">
                      <strong>{item.status.toUpperCase()} · {item.processedPeaks}/{item.totalPeaks || "?"}</strong>
                      <div className="manager-meta">
                        {new Date(item.startedAt).toLocaleString()} · +{item.addedPeaks} new · {item.reusedPeaks} cached
                        {item.error ? ` · ${item.error}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="section-heading">Dataset validation</div>
              <button className="validation-button" onClick={() => void validate()}>Run validation</button>
              {validation && (
                <div className="validation-summary">
                  <div><strong>{validation.errors}</strong> errors · <strong>{validation.warnings}</strong> warnings</div>
                  {validation.issues.slice(0, 20).map((issue, index) => (
                    <div className={`issue ${issue.severity}`} key={`${issue.code}-${index}`}>
                      <strong>{issue.code}</strong>
                      <span>{issue.entity ? `${issue.entity}: ` : ""}{issue.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </aside>

      <main className="map-area">
        <MapView
          ref={mapRef}
          initialViewState={{ longitude: -120.8, latitude: 47.35, zoom: 6.25 }}
          mapStyle={MAP_STYLE}
          minZoom={4}
          maxZoom={15}
          interactiveLayerIds={["peaks-layer"]}
          onMouseMove={(event) => setHoveredPeak(pickFeature(event))}
          onMouseLeave={() => setHoveredPeak(null)}
          onClick={(event) => {
            const peak = pickFeature(event);
            if (peak) setSelectedPeak(peak);
          }}
        >
          <NavigationControl position="top-right" />
          <Source id="peaks" type="geojson" data={geojson}>
            <Layer
              id="peaks-layer"
              type="circle"
              paint={{
                "circle-radius": [
                  "interpolate", ["linear"], ["get", "listCount"],
                  1, 5,
                  2, 7,
                  3, 9,
                  5, 13,
                  10, 18,
                ],
                "circle-color": "#356148",
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
                "circle-opacity": 0.92,
              } as any}
            />
          </Source>

          {hoveredPeak && !selectedPeak && (
            <Popup longitude={hoveredPeak.longitude} latitude={hoveredPeak.latitude} closeButton={false} closeOnClick={false} offset={10}>
              <PeakSummary peak={hoveredPeak} lists={listById} />
            </Popup>
          )}

          {selectedPeak && (
            <Popup longitude={selectedPeak.longitude} latitude={selectedPeak.latitude} onClose={() => setSelectedPeak(null)} closeOnClick={false} maxWidth="390px">
              <PeakDetail peak={selectedPeak} lists={listById} />
            </Popup>
          )}
        </MapView>
      </main>
    </div>
  );
}

function PeakSummary({ peak, lists }: { peak: Peak; lists: Map<string, PeakList> }) {
  return (
    <div className="peak-summary compact">
      <h2>{peak.name}</h2>
      <div className="peak-elevation">{peak.elevationFt.toLocaleString()} ft · {peak.listIds.length} list{peak.listIds.length === 1 ? "" : "s"}</div>
      <div className="badges">
        {peak.listIds.slice(0, 4).map((id) => <span className="badge" key={id}>{lists.get(id)?.name ?? id}</span>)}
      </div>
    </div>
  );
}

function PeakDetail({ peak, lists }: { peak: Peak; lists: Map<string, PeakList> }) {
  return (
    <div className="peak-detail">
      <div className="detail-kicker">{peak.listIds.length} list{peak.listIds.length === 1 ? "" : "s"}</div>
      <h2>{peak.name}</h2>
      <div className="detail-grid">
        <div><span>Elevation</span><strong>{peak.elevationFt.toLocaleString()} ft</strong></div>
        <div><span>Prominence</span><strong>{peak.prominenceFt == null ? "—" : `${peak.prominenceFt.toLocaleString()} ft`}</strong></div>
      </div>
      <div className="popup-label">Lists</div>
      <div className="membership-list">
        {peak.listIds.map((id) => <span className="badge" key={id}>{lists.get(id)?.name ?? id}</span>)}
      </div>
      {peak.sourceAttributes && Object.keys(peak.sourceAttributes).length > 0 && (
        <>
          <div className="popup-label">Cached Peakbagger data</div>
          <dl className="attribute-list">
            {Object.entries(peak.sourceAttributes).slice(0, 10).map(([key, value]) => (
              <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </>
      )}
      <div className="detail-actions"><a href={peak.sourceUrl} target="_blank" rel="noreferrer">Open Peakbagger</a></div>
    </div>
  );
}
