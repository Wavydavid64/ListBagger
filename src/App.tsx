import { FormEvent, useEffect, useMemo, useState } from "react";
import MapView, {
  Marker,
  NavigationControl,
  Popup,
} from "react-map-gl/maplibre";
import type {
  AppData,
  ImportResult,
  MatchMode,
  Peak,
  PeakList,
} from "./types";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export default function App() {
  const [lists, setLists] = useState<PeakList[]>([]);
  const [peaks, setPeaks] = useState<Peak[]>([]);
  const [selectedLists, setSelectedLists] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<MatchMode>("any");
  const [search, setSearch] = useState("");
  const [selectedPeak, setSelectedPeak] = useState<Peak | null>(null);
  const [hoveredPeak, setHoveredPeak] = useState<Peak | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [importerReady, setImporterReady] = useState<boolean | null>(null);

  useEffect(() => {
    void loadData(true);
    void fetch("/api/importer-status")
      .then((response) => response.json())
      .then((status: { ready: boolean }) => setImporterReady(status.ready))
      .catch(() => setImporterReady(false));
  }, []);

  async function loadData(selectEverything = false) {
    try {
      setLoadError("");
      const response = await fetch("/api/data");
      if (!response.ok) throw new Error(`Data request failed (${response.status})`);
      const data = (await response.json()) as AppData;
      setLists(data.lists);
      setPeaks(data.peaks);
      if (selectEverything) {
        setSelectedLists(data.lists.map((list) => list.id));
      } else {
        setSelectedLists((current) =>
          current.filter((id) => data.lists.some((list) => list.id === id)),
        );
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  const listById = useMemo(
    () => new Map(lists.map((list) => [list.id, list] as const)),
    [lists],
  );

  const visiblePeaks = useMemo(() => {
    const query = search.trim().toLowerCase();

    return peaks.filter((peak) => {
      const matchesSearch =
        query.length === 0 || peak.name.toLowerCase().includes(query);

      if (!matchesSearch) return false;
      if (selectedLists.length === 0) return true;

      if (matchMode === "any") {
        return selectedLists.some((listId) => peak.listIds.includes(listId));
      }

      return selectedLists.every((listId) => peak.listIds.includes(listId));
    });
  }, [peaks, selectedLists, matchMode, search]);

  function toggleList(listId: string) {
    setSelectedLists((current) =>
      current.includes(listId)
        ? current.filter((id) => id !== listId)
        : [...current, listId],
    );
  }

  async function importList(event: FormEvent) {
    event.preventDefault();
    if (importing) return;

    setImporting(true);
    setImportError("");
    setImportMessage(
      "Chrome is open for this import. If Cloudflare asks for verification, complete it manually there; the import resumes automatically.",
    );

    try {
      const response = await fetch("/api/import-list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: importUrl }),
      });
      const body = (await response.json()) as ImportResult | { error: string };

      if (!response.ok) {
        throw new Error("error" in body ? body.error : "List import failed.");
      }

      const result = body as ImportResult;
      await loadData(true);
      setImportMessage(
        `Imported ${result.list.name}: ${result.addedPeaks} new peaks, ${result.reusedPeaks} existing peaks reused.`,
      );
      setImportUrl("");
    } catch (error) {
      setImportMessage("");
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">WASHINGTON</div>
          <h1>Mountaineers Peak Map</h1>
          <p>Explore peaks across Mountaineers peak-bagging lists.</p>
        </div>

        <form className="import-panel" onSubmit={importList}>
          <div className="section-heading">Add Peakbagger list</div>
          <input
            type="url"
            value={importUrl}
            onChange={(event) => setImportUrl(event.target.value)}
            placeholder="https://www.peakbagger.com/list.aspx?lid=5045"
            required
            disabled={importing}
          />
          <button
            type="submit"
            disabled={importing || importerReady === false}
          >
            {importing ? "Importing…" : "Import list"}
          </button>
          {importerReady === false && (
            <p className="status error">
              Browser importer not installed. Run: npm run setup:browser
            </p>
          )}
          {importMessage && <p className="status success">{importMessage}</p>}
          {importError && <p className="status error">{importError}</p>}
        </form>

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
              type="button"
              className={matchMode === "any" ? "active" : ""}
              onClick={() => setMatchMode("any")}
            >
              ANY
            </button>
            <button
              type="button"
              className={matchMode === "all" ? "active" : ""}
              onClick={() => setMatchMode("all")}
            >
              ALL
            </button>
          </div>

          <p className="hint">
            {matchMode === "any"
              ? "Show peaks belonging to at least one selected list."
              : "Show only peaks belonging to every selected list."}
          </p>
        </section>

        <section className="list-section">
          <div className="section-heading">Peak lists</div>

          <div className="list-controls">
            <button
              type="button"
              onClick={() => setSelectedLists(lists.map((list) => list.id))}
            >
              Select all
            </button>
            <button type="button" onClick={() => setSelectedLists([])}>
              Clear
            </button>
          </div>

          <div className="list-items">
            {lists.map((list) => (
              <label key={list.id} className="list-row">
                <input
                  type="checkbox"
                  checked={selectedLists.includes(list.id)}
                  onChange={() => toggleList(list.id)}
                />
                <span className="list-name">{list.name}</span>
                <span className="list-count">{list.peakCount}</span>
              </label>
            ))}
          </div>

          {!loading && lists.length === 0 && (
            <div className="empty-list">
              No lists imported yet. Paste a Peakbagger list URL above.
            </div>
          )}
        </section>

        {loadError && <div className="status error">{loadError}</div>}

        <div className="result-count">
          <strong>{visiblePeaks.length}</strong> of {peaks.length} peaks shown
        </div>

        <div className="marker-key">
          Marker size represents how many imported lists contain a peak.
        </div>
      </aside>

      <main className="map-area">
        <MapView
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
            const markerSize = sizeForMemberships(peak.listIds.length);
            return (
              <Marker
                key={peak.peakbaggerId}
                longitude={peak.longitude}
                latitude={peak.latitude}
                anchor="center"
              >
                <button
                  className="peak-marker"
                  style={{ width: markerSize, height: markerSize }}
                  aria-label={`${peak.name}, ${peak.elevationFt.toLocaleString()} feet, ${peak.listIds.length} lists`}
                  title={`${peak.name} · ${peak.listIds.length} list${peak.listIds.length === 1 ? "" : "s"}`}
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
              <PeakSummary peak={hoveredPeak} listById={listById} compact />
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
              maxWidth="340px"
            >
              <PeakSummary peak={selectedPeak} listById={listById} />
            </Popup>
          )}
        </MapView>
      </main>
    </div>
  );
}

function sizeForMemberships(count: number): number {
  return Math.min(26, 10 + Math.max(0, count - 1) * 3);
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
        {peak.elevationFt.toLocaleString()} ft
        {peak.prominenceFt !== undefined &&
          ` · ${peak.prominenceFt.toLocaleString()} ft prominence`}
      </div>

      {!compact && <div className="popup-label">Imported lists</div>}

      <div className="badges">
        {peak.listIds.map((listId) => (
          <span className="badge" key={listId}>
            {listById.get(listId)?.name ?? listId}
          </span>
        ))}
      </div>

      {!compact && (
        <a
          className="peak-link"
          href={peak.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open on Peakbagger ↗
        </a>
      )}
    </div>
  );
}
