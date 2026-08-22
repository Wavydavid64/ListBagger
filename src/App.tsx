import { useEffect, useMemo, useRef, useState } from "react";
import MapView, {
  Marker,
  NavigationControl,
  Popup,
  type MapRef,
} from "react-map-gl/maplibre";
import type { Peak, PeakList, MatchMode } from "./types";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

type DataResponse = {
  lists: PeakList[];
  peaks: Peak[];
};

type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  entity?: string;
};

type ValidationResponse = {
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
};

type ImportResult = {
  list: PeakList;
  addedPeaks: number;
  reusedPeaks: number;
  totalPeaks: number;
};

type Panel = "map" | "lists";

export default function App() {
  const mapRef = useRef<MapRef | null>(null);

  const [lists, setLists] = useState<PeakList[]>([]);
  const [peaks, setPeaks] = useState<Peak[]>([]);
  const [selectedLists, setSelectedLists] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<MatchMode>("any");
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

  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [validating, setValidating] = useState(false);

  async function loadData(preserveSelection = false) {
    const response = await fetch("/api/data");
    if (!response.ok) {
      throw new Error("Could not load local peak data.");
    }
    const data = (await response.json()) as DataResponse;
    setLists(data.lists);
    setPeaks(data.peaks);

    setSelectedLists((current) => {
      if (!preserveSelection || current.length === 0) {
        return data.lists.map((list) => list.id);
      }
      const valid = new Set(data.lists.map((list) => list.id));
      return current.filter((id) => valid.has(id));
    });
  }

  useEffect(() => {
    void loadData();
    void fetch("/api/importer-status")
      .then((response) => response.json())
      .then((status: { ready: boolean }) => setImporterReady(status.ready))
      .catch(() => setImporterReady(false));
  }, []);

  const listById = useMemo(
    () => new Map(lists.map((list) => [list.id, list] as const)),
    [lists],
  );

  const selectedListSet = useMemo(
    () => new Set(selectedLists),
    [selectedLists],
  );

  const visibleLists = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter((list) =>
      `${list.name} ${list.branch ?? ""}`.toLowerCase().includes(q),
    );
  }, [lists, listSearch]);

  const membershipCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const peak of peaks) {
      for (const listId of peak.listIds) {
        counts.set(listId, (counts.get(listId) ?? 0) + 1);
      }
    }
    return counts;
  }, [peaks]);

  const visiblePeaks = useMemo(() => {
    const query = search.trim().toLowerCase();

    return peaks.filter((peak) => {
      if (query && !peak.name.toLowerCase().includes(query)) {
        return false;
      }

      if (peak.listIds.length < minMemberships) {
        return false;
      }

      if (selectedLists.length === 0) {
        return true;
      }

      if (matchMode === "any") {
        return selectedLists.some((listId) => peak.listIds.includes(listId));
      }

      return selectedLists.every((listId) => peak.listIds.includes(listId));
    });
  }, [peaks, search, minMemberships, selectedLists, matchMode]);

  function toggleList(listId: string) {
    setSelectedLists((current) =>
      current.includes(listId)
        ? current.filter((id) => id !== listId)
        : [...current, listId],
    );
  }

  function markerSize(peak: Peak) {
    const n = Math.max(1, peak.listIds.length);
    return Math.min(25, 10 + (n - 1) * 3);
  }

  function zoomToVisible() {
    const map = mapRef.current?.getMap();
    if (!map || visiblePeaks.length === 0) return;

    if (visiblePeaks.length === 1) {
      map.easeTo({
        center: [visiblePeaks[0].longitude, visiblePeaks[0].latitude],
        zoom: 11,
      });
      return;
    }

    const lngs = visiblePeaks.map((peak) => peak.longitude);
    const lats = visiblePeaks.map((peak) => peak.latitude);

    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 70, duration: 700 },
    );
  }

  async function importList(event: React.FormEvent) {
    event.preventDefault();
    setImporting(true);
    setImportError("");
    setImportMessage(
      "Chrome is open for this import. If Cloudflare asks for verification, complete it manually there; the import resumes automatically.",
    );

    try {
      const response = await fetch("/api/import-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl }),
      });

      const body = (await response.json()) as
        | ImportResult
        | { error: string };

      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : "Import failed.");
      }

      setImportMessage(
        `Imported ${body.list.name}: ${body.addedPeaks} new, ${body.reusedPeaks} cached.`,
      );
      setImportUrl("");
      await loadData(true);
      await runValidation();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  async function reimportList(list: PeakList) {
    if (!list.sourceUrl) return;
    setPanel("lists");
    setImportUrl(list.sourceUrl);
    setImportMessage(`Re-importing ${list.name}…`);
    setImportError("");
    setImporting(true);

    try {
      const response = await fetch("/api/import-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: list.sourceUrl }),
      });

      const body = (await response.json()) as
        | ImportResult
        | { error: string };

      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : "Import failed.");
      }

      setImportMessage(
        `Refreshed ${body.list.name}: ${body.addedPeaks} new, ${body.reusedPeaks} cached.`,
      );
      await loadData(true);
      await runValidation();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  async function runValidation() {
    setValidating(true);
    try {
      const response = await fetch("/api/validate");
      if (!response.ok) throw new Error("Validation failed.");
      setValidation((await response.json()) as ValidationResponse);
    } finally {
      setValidating(false);
    }
  }

  const selectedPeakListNames =
    selectedPeak?.listIds.map((id) => listById.get(id)?.name ?? id) ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">WASHINGTON</div>
          <h1>Mountaineers Peak Map</h1>
          <p>Explore local Mountaineers / Peakbagger list data.</p>
        </div>

        <div className="top-tabs">
          <button
            className={panel === "map" ? "active" : ""}
            onClick={() => setPanel("map")}
          >
            Map
          </button>
          <button
            className={panel === "lists" ? "active" : ""}
            onClick={() => setPanel("lists")}
          >
            Lists
          </button>
        </div>

        {panel === "map" ? (
          <>
            <label className="search-block">
              <span>Search peaks</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Little Tahoma, Chair Peak..."
              />
            </label>

            <section>
              <div className="section-heading">Match selected lists</div>
              <div className="mode-switch">
                <button
                  className={matchMode === "any" ? "active" : ""}
                  onClick={() => setMatchMode("any")}
                >
                  ANY
                </button>
                <button
                  className={matchMode === "all" ? "active" : ""}
                  onClick={() => setMatchMode("all")}
                >
                  ALL
                </button>
              </div>
              <p className="hint">
                {matchMode === "any"
                  ? "Show peaks on at least one selected list."
                  : "Show only peaks shared by every selected list."}
              </p>
            </section>

            <section>
              <div className="section-heading">List memberships</div>
              <select
                className="select-input"
                value={minMemberships}
                onChange={(event) =>
                  setMinMemberships(Number(event.target.value))
                }
              >
                <option value={1}>Any number of lists</option>
                <option value={2}>2+ lists</option>
                <option value={3}>3+ lists</option>
                <option value={4}>4+ lists</option>
                <option value={5}>5+ lists</option>
              </select>
            </section>

            <section className="list-section">
              <div className="section-heading">Peak lists</div>

              <input
                className="mini-search"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="Filter list names..."
              />

              <div className="list-controls">
                <button onClick={() => setSelectedLists(lists.map((l) => l.id))}>
                  Select all
                </button>
                <button onClick={() => setSelectedLists([])}>Clear</button>
                <button onClick={zoomToVisible}>Zoom to results</button>
              </div>

              <div className="list-items">
                {visibleLists.map((list) => (
                  <label key={list.id} className="list-row">
                    <input
                      type="checkbox"
                      checked={selectedListSet.has(list.id)}
                      onChange={() => toggleList(list.id)}
                    />
                    <span className="list-name">{list.name}</span>
                    <span className="list-count">
                      {membershipCounts.get(list.id) ?? 0}
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <div className="result-count">
              <strong>{visiblePeaks.length}</strong> of {peaks.length} cached peaks
              shown
            </div>
          </>
        ) : (
          <>
            <section>
              <div className="section-heading">Add Peakbagger list</div>
              <form onSubmit={importList} className="import-form">
                <input
                  value={importUrl}
                  onChange={(event) => setImportUrl(event.target.value)}
                  placeholder="https://www.peakbagger.com/list.aspx?lid=..."
                />
                <button
                  type="submit"
                  disabled={importing || importerReady === false}
                >
                  {importing ? "Importing…" : "Import list"}
                </button>
              </form>

              {importerReady === false && (
                <p className="status error">
                  Browser importer not installed. Run: npm run setup:browser
                </p>
              )}

              {importMessage && <p className="status">{importMessage}</p>}
              {importError && <p className="status error">{importError}</p>}
            </section>

            <section>
              <div className="section-heading">Imported lists</div>
              <div className="manager-list">
                {lists.length === 0 && (
                  <div className="empty-state">No lists imported yet.</div>
                )}

                {lists.map((list) => (
                  <div className="manager-row" key={list.id}>
                    <div className="manager-main">
                      <strong>{list.name}</strong>
                      <div className="manager-meta">
                        {membershipCounts.get(list.id) ?? 0} cached memberships
                        {list.sourceFetchedAt
                          ? ` · fetched ${new Date(
                              list.sourceFetchedAt,
                            ).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <button
                      disabled={!list.sourceUrl || importing}
                      onClick={() => void reimportList(list)}
                    >
                      Re-import
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="section-heading">Dataset validation</div>
              <button
                className="validation-button"
                onClick={() => void runValidation()}
                disabled={validating}
              >
                {validating ? "Checking…" : "Run validation"}
              </button>

              {validation && (
                <div className="validation-summary">
                  <div>
                    <strong>{validation.errors}</strong> errors ·{" "}
                    <strong>{validation.warnings}</strong> warnings
                  </div>

                  {validation.issues.length > 0 ? (
                    <div className="issue-list">
                      {validation.issues.slice(0, 20).map((issue, index) => (
                        <div
                          key={`${issue.code}-${index}`}
                          className={`issue ${issue.severity}`}
                        >
                          <strong>{issue.code}</strong>
                          <span>{issue.message}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="all-good">No validation issues found.</div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </aside>

      <main className="map-area">
        <MapView
          ref={mapRef}
          initialViewState={{
            longitude: -120.8,
            latitude: 47.35,
            zoom: 6.25,
          }}
          mapStyle={MAP_STYLE}
          minZoom={4}
          maxZoom={15}
        >
          <NavigationControl position="top-right" />

          {visiblePeaks.map((peak) => {
            const size = markerSize(peak);

            return (
              <Marker
                key={peak.peakbaggerId}
                longitude={peak.longitude}
                latitude={peak.latitude}
                anchor="center"
              >
                <button
                  className="peak-marker"
                  style={{ width: size, height: size }}
                  aria-label={`${peak.name}, ${peak.elevationFt.toLocaleString()} feet, ${peak.listIds.length} lists`}
                  onMouseEnter={() => setHoveredPeak(peak)}
                  onMouseLeave={() => setHoveredPeak(null)}
                  onClick={() => setSelectedPeak(peak)}
                />
              </Marker>
            );
          })}

          {hoveredPeak && !selectedPeak && (
            <Popup
              longitude={hoveredPeak.longitude}
              latitude={hoveredPeak.latitude}
              closeButton={false}
              closeOnClick={false}
              offset={12}
              className="hover-popup"
            >
              <PeakSummary
                peak={hoveredPeak}
                listById={listById}
                compact
              />
            </Popup>
          )}

          {selectedPeak && (
            <Popup
              longitude={selectedPeak.longitude}
              latitude={selectedPeak.latitude}
              onClose={() => setSelectedPeak(null)}
              closeButton
              closeOnClick={false}
              offset={14}
              maxWidth="390px"
            >
              <div className="peak-detail">
                <div className="detail-kicker">
                  {selectedPeak.listIds.length} list
                  {selectedPeak.listIds.length === 1 ? "" : "s"}
                </div>
                <h2>{selectedPeak.name}</h2>

                <div className="detail-grid">
                  <div>
                    <span>Elevation</span>
                    <strong>
                      {selectedPeak.elevationFt.toLocaleString()} ft
                    </strong>
                  </div>
                  <div>
                    <span>Prominence</span>
                    <strong>
                      {selectedPeak.prominenceFt != null
                        ? `${selectedPeak.prominenceFt.toLocaleString()} ft`
                        : "—"}
                    </strong>
                  </div>
                </div>

                <div className="popup-label">Mountaineers lists</div>
                <div className="membership-list">
                  {selectedPeakListNames.map((name) => (
                    <span className="badge" key={name}>
                      {name}
                    </span>
                  ))}
                </div>

                {selectedPeak.sourceAttributes &&
                  Object.keys(selectedPeak.sourceAttributes).length > 0 && (
                    <>
                      <div className="popup-label">Cached Peakbagger data</div>
                      <dl className="attribute-list">
                        {Object.entries(selectedPeak.sourceAttributes)
                          .slice(0, 8)
                          .map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                      </dl>
                    </>
                  )}

                <div className="detail-actions">
                  {selectedPeak.sourceUrl && (
                    <a
                      href={selectedPeak.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Peakbagger
                    </a>
                  )}
                </div>
              </div>
            </Popup>
          )}
        </MapView>
      </main>
    </div>
  );
}

function PeakSummary({
  peak,
  listById,
  compact = false,
}: {
  peak: Peak;
  listById: Map<string, PeakList>;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "peak-summary compact" : "peak-summary"}>
      <h2>{peak.name}</h2>
      <div className="peak-elevation">
        {peak.elevationFt.toLocaleString()} ft · {peak.listIds.length} list
        {peak.listIds.length === 1 ? "" : "s"}
      </div>

      <div className="badges">
        {peak.listIds.map((listId) => (
          <span className="badge" key={listId}>
            {listById.get(listId)?.name ?? listId}
          </span>
        ))}
      </div>
    </div>
  );
}
