import { useMemo, useState } from "react";
import MapView, {
  Marker,
  NavigationControl,
  Popup,
} from "react-map-gl/maplibre";
import type { Peak, PeakList, MatchMode } from "./types";
import peaksData from "./data/peaks.json";
import listsData from "./data/lists.json";

const peaks = peaksData as Peak[];
const lists = listsData as PeakList[];

const MAP_STYLE =
  "https://tiles.openfreemap.org/styles/liberty";

export default function App() {
  const [selectedLists, setSelectedLists] = useState<string[]>(
    lists.map((list) => list.id)
  );
  const [matchMode, setMatchMode] = useState<MatchMode>("any");
  const [search, setSearch] = useState("");
  const [selectedPeak, setSelectedPeak] = useState<Peak | null>(null);
  const [hoveredPeak, setHoveredPeak] = useState<Peak | null>(null);

  const listById = useMemo(
    () => new Map(lists.map((list) => [list.id, list])),
    []
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
  }, [selectedLists, matchMode, search]);

  function toggleList(listId: string) {
    setSelectedLists((current) =>
      current.includes(listId)
        ? current.filter((id) => id !== listId)
        : [...current, listId]
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="eyebrow">WASHINGTON</div>
          <h1>Mountaineers Peak Map</h1>
          <p>
            Explore peaks across Mountaineers peak-bagging lists.
          </p>
        </div>

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
              ? "Show peaks belonging to at least one selected list."
              : "Show only peaks belonging to every selected list."}
          </p>
        </section>

        <section className="list-section">
          <div className="section-heading">Peak lists</div>

          <div className="list-controls">
            <button onClick={() => setSelectedLists(lists.map((l) => l.id))}>
              Select all
            </button>
            <button onClick={() => setSelectedLists([])}>Clear</button>
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
                <span className="list-count">{list.peakCount ?? ""}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="result-count">
          <strong>{visiblePeaks.length}</strong> of {peaks.length} prototype peaks
          shown
        </div>

        <div className="prototype-note">
          V0 contains representative sample peaks only. The full importer is the
          next development step.
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

          {visiblePeaks.map((peak) => (
            <Marker
              key={peak.peakbaggerId}
              longitude={peak.longitude}
              latitude={peak.latitude}
              anchor="center"
            >
              <button
                className={`peak-marker ${
                  peak.listIds.length > 1 ? "multi-list" : ""
                }`}
                aria-label={`${peak.name}, ${peak.elevationFt.toLocaleString()} feet`}
                onMouseEnter={() => setHoveredPeak(peak)}
                onMouseLeave={() => setHoveredPeak(null)}
                onClick={() => setSelectedPeak(peak)}
              />
            </Marker>
          ))}

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
      </div>

      {!compact && <div className="popup-label">Mountaineers lists</div>}

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
