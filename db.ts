import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "listbagger.db");
const LEGACY_PEAKS = path.join(DATA_DIR, "peaks.json");
const LEGACY_LISTS = path.join(DATA_DIR, "lists.json");

export type PeakList = {
  id: string;
  peakbaggerListId: number;
  name: string;
  peakCount: number;
  sourceUrl: string;
  sourceArchive?: string;
  sourceFetchedAt?: string;
  sourceSchemaVersion?: number;
};

export type Peak = {
  peakbaggerId: number;
  name: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  prominenceFt?: number;
  sourceUrl: string;
  sourceArchive?: string;
  sourceFetchedAt?: string;
  sourceSchemaVersion?: number;
  sourceAttributes?: Record<string, string>;
  listIds: string[];
};

export type ImportRow = {
  id: number;
  sourceUrl: string;
  listId?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  totalPeaks: number;
  processedPeaks: number;
  addedPeaks: number;
  reusedPeaks: number;
  error?: string;
};

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA synchronous = NORMAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS peaks (
  peakbagger_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  elevation_ft INTEGER NOT NULL,
  prominence_ft INTEGER,
  source_url TEXT NOT NULL,
  source_archive TEXT,
  source_fetched_at TEXT,
  source_schema_version INTEGER,
  source_attributes_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  peakbagger_list_id INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  peak_count INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  source_archive TEXT,
  source_fetched_at TEXT,
  source_schema_version INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS peak_list_memberships (
  peakbagger_id INTEGER NOT NULL REFERENCES peaks(peakbagger_id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  PRIMARY KEY (peakbagger_id, list_id)
);
CREATE TABLE IF NOT EXISTS source_pages (
  kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  sha256 TEXT,
  byte_count INTEGER,
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, source_id)
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  list_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  total_peaks INTEGER NOT NULL DEFAULT 0,
  processed_peaks INTEGER NOT NULL DEFAULT 0,
  added_peaks INTEGER NOT NULL DEFAULT 0,
  reused_peaks INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_memberships_list ON peak_list_memberships(list_id);
CREATE INDEX IF NOT EXISTS idx_imports_started ON imports(started_at DESC);
`);

function safeJsonFile(file: string): unknown[] {
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function migrateLegacyJsonIfNeeded() {
  const peakCount = Number((db.prepare("SELECT COUNT(*) AS c FROM peaks").get() as { c: number }).c);
  const listCount = Number((db.prepare("SELECT COUNT(*) AS c FROM lists").get() as { c: number }).c);
  if (peakCount > 0 || listCount > 0) return;

  const legacyLists = safeJsonFile(LEGACY_LISTS) as Array<Record<string, unknown>>;
  const legacyPeaks = safeJsonFile(LEGACY_PEAKS) as Array<Record<string, unknown>>;
  if (legacyLists.length === 0 && legacyPeaks.length === 0) return;

  console.log(`Migrating legacy JSON cache into SQLite (${legacyPeaks.length} peaks, ${legacyLists.length} lists)…`);
  db.exec("BEGIN IMMEDIATE;");
  try {
    const insertList = db.prepare(`
      INSERT OR REPLACE INTO lists
      (id, peakbagger_list_id, name, peak_count, source_url, source_archive, source_fetched_at, source_schema_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const item of legacyLists) {
      const id = String(item.id ?? "");
      const pbid = Number(item.peakbaggerListId ?? String(id).replace(/^peakbagger-/, ""));
      if (!id || !Number.isInteger(pbid)) continue;
      insertList.run(
        id,
        pbid,
        String(item.name ?? `Peakbagger List ${pbid}`),
        Number(item.peakCount ?? 0),
        String(item.sourceUrl ?? `https://www.peakbagger.com/list.aspx?lid=${pbid}`),
        item.sourceArchive ? String(item.sourceArchive) : null,
        item.sourceFetchedAt ? String(item.sourceFetchedAt) : null,
        item.sourceSchemaVersion ? Number(item.sourceSchemaVersion) : null,
      );
    }

    const insertPeak = db.prepare(`
      INSERT OR REPLACE INTO peaks
      (peakbagger_id, name, latitude, longitude, elevation_ft, prominence_ft, source_url, source_archive, source_fetched_at, source_schema_version, source_attributes_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const insertMembership = db.prepare(
      "INSERT OR IGNORE INTO peak_list_memberships (peakbagger_id, list_id) VALUES (?, ?)",
    );

    for (const item of legacyPeaks) {
      const pid = Number(item.peakbaggerId);
      const lat = Number(item.latitude);
      const lon = Number(item.longitude);
      const elev = Number(item.elevationFt);
      if (!Number.isInteger(pid) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(elev)) continue;
      insertPeak.run(
        pid,
        String(item.name ?? `Peak ${pid}`),
        lat,
        lon,
        Math.round(elev),
        item.prominenceFt == null ? null : Math.round(Number(item.prominenceFt)),
        String(item.sourceUrl ?? `https://www.peakbagger.com/peak.aspx?pid=${pid}`),
        item.sourceArchive ? String(item.sourceArchive) : null,
        item.sourceFetchedAt ? String(item.sourceFetchedAt) : null,
        item.sourceSchemaVersion ? Number(item.sourceSchemaVersion) : null,
        item.sourceAttributes ? JSON.stringify(item.sourceAttributes) : null,
      );
      const ids = Array.isArray(item.listIds) ? item.listIds.map(String) : [];
      for (const listId of ids) {
        if (db.prepare("SELECT 1 FROM lists WHERE id = ?").get(listId)) {
          insertMembership.run(pid, listId);
        }
      }
    }
    db.exec("COMMIT;");
    console.log("Legacy JSON migration complete. SQLite is now the live datastore.");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

migrateLegacyJsonIfNeeded();

function syncArchivedSourceMetadata() {
  const metaDir = path.join(DATA_DIR, "source", "meta");
  if (!fs.existsSync(metaDir)) return;
  const statement = db.prepare(`
    INSERT INTO source_pages(kind,source_id,url,archive_path,fetched_at,sha256,byte_count,schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind,source_id) DO UPDATE SET
      url=excluded.url, archive_path=excluded.archive_path,
      fetched_at=excluded.fetched_at, sha256=excluded.sha256,
      byte_count=excluded.byte_count, schema_version=excluded.schema_version
  `);
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const filename of fs.readdirSync(metaDir)) {
      if (!filename.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(metaDir, filename), "utf8")) as Record<string, unknown>;
        const kind = String(meta.kind ?? "");
        const sourceId = Number(meta.sourceId);
        const url = String(meta.url ?? "");
        const archivePath = String(meta.htmlPath ?? "");
        const fetchedAt = String(meta.fetchedAt ?? "");
        if (!kind || !Number.isInteger(sourceId) || !url || !archivePath || !fetchedAt) continue;
        statement.run(
          kind, sourceId, url, archivePath, fetchedAt,
          meta.sha256 ? String(meta.sha256) : null,
          meta.bytes == null ? null : Number(meta.bytes),
          meta.schemaVersion == null ? 1 : Number(meta.schemaVersion),
        );
      } catch {
        // One damaged metadata sidecar should not prevent the app from starting.
      }
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

syncArchivedSourceMetadata();

export function getAppData(): { lists: PeakList[]; peaks: Peak[] } {
  const lists = db.prepare(`
    SELECT id, peakbagger_list_id AS peakbaggerListId, name, peak_count AS peakCount,
           source_url AS sourceUrl, source_archive AS sourceArchive,
           source_fetched_at AS sourceFetchedAt, source_schema_version AS sourceSchemaVersion
    FROM lists ORDER BY name COLLATE NOCASE
  `).all() as unknown as PeakList[];

  const peakRows = db.prepare(`
    SELECT peakbagger_id AS peakbaggerId, name, latitude, longitude,
           elevation_ft AS elevationFt, prominence_ft AS prominenceFt,
           source_url AS sourceUrl, source_archive AS sourceArchive,
           source_fetched_at AS sourceFetchedAt, source_schema_version AS sourceSchemaVersion,
           source_attributes_json AS sourceAttributesJson
    FROM peaks ORDER BY name COLLATE NOCASE
  `).all() as unknown as Array<Record<string, unknown>>;

  const membershipRows = db.prepare(`
    SELECT peakbagger_id AS peakbaggerId, list_id AS listId
    FROM peak_list_memberships ORDER BY peakbagger_id
  `).all() as unknown as Array<{ peakbaggerId: number; listId: string }>;

  const memberships = new Map<number, string[]>();
  for (const row of membershipRows) {
    const ids = memberships.get(Number(row.peakbaggerId)) ?? [];
    ids.push(String(row.listId));
    memberships.set(Number(row.peakbaggerId), ids);
  }

  const peaks: Peak[] = peakRows.map((row) => ({
    peakbaggerId: Number(row.peakbaggerId),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    elevationFt: Number(row.elevationFt),
    prominenceFt: row.prominenceFt == null ? undefined : Number(row.prominenceFt),
    sourceUrl: String(row.sourceUrl),
    sourceArchive: row.sourceArchive ? String(row.sourceArchive) : undefined,
    sourceFetchedAt: row.sourceFetchedAt ? String(row.sourceFetchedAt) : undefined,
    sourceSchemaVersion: row.sourceSchemaVersion == null ? undefined : Number(row.sourceSchemaVersion),
    sourceAttributes: row.sourceAttributesJson ? JSON.parse(String(row.sourceAttributesJson)) : undefined,
    listIds: memberships.get(Number(row.peakbaggerId)) ?? [],
  }));

  return { lists, peaks };
}

export function getRecentImports(limit = 12): ImportRow[] {
  return db.prepare(`
    SELECT id, source_url AS sourceUrl, list_id AS listId, status,
           started_at AS startedAt, completed_at AS completedAt,
           total_peaks AS totalPeaks, processed_peaks AS processedPeaks,
           added_peaks AS addedPeaks, reused_peaks AS reusedPeaks, error
    FROM imports ORDER BY id DESC LIMIT ?
  `).all(limit) as unknown as ImportRow[];
}

export function validateData(projectRoot: string) {
  const issues: Array<{ severity: "error" | "warning"; code: string; message: string; entity?: string }> = [];
  const badCoords = db.prepare(`SELECT name FROM peaks WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180`).all() as unknown as Array<{name:string}>;
  for (const row of badCoords) issues.push({ severity: "error", code: "INVALID_COORDINATES", message: "Peak has invalid coordinates.", entity: row.name });

  const badElev = db.prepare(`SELECT name FROM peaks WHERE elevation_ft <= 0`).all() as unknown as Array<{name:string}>;
  for (const row of badElev) issues.push({ severity: "error", code: "INVALID_ELEVATION", message: "Peak has invalid elevation.", entity: row.name });

  const zero = db.prepare(`SELECT p.name FROM peaks p LEFT JOIN peak_list_memberships m ON m.peakbagger_id=p.peakbagger_id WHERE m.peakbagger_id IS NULL`).all() as unknown as Array<{name:string}>;
  for (const row of zero) issues.push({ severity: "warning", code: "ZERO_MEMBERSHIPS", message: "Peak is cached but currently belongs to no imported lists.", entity: row.name });

  const mismatches = db.prepare(`
    SELECT l.name, l.peak_count AS expected, COUNT(m.peakbagger_id) AS actual
    FROM lists l LEFT JOIN peak_list_memberships m ON m.list_id=l.id
    GROUP BY l.id HAVING expected != actual
  `).all() as unknown as Array<{name:string;expected:number;actual:number}>;
  for (const row of mismatches) issues.push({ severity: "error", code: "LIST_COUNT_MISMATCH", message: `Expected ${row.expected} memberships but found ${row.actual}.`, entity: row.name });

  const sources = db.prepare(`SELECT name, source_archive AS sourceArchive FROM peaks WHERE source_archive IS NOT NULL`).all() as unknown as Array<{name:string;sourceArchive:string}>;
  for (const row of sources) {
    if (!fs.existsSync(path.join(projectRoot, row.sourceArchive))) {
      issues.push({ severity: "warning", code: "MISSING_RAW_FILE", message: `Missing ${row.sourceArchive}`, entity: row.name });
    }
  }

  const noSources = db.prepare(`SELECT name FROM peaks WHERE source_archive IS NULL`).all() as unknown as Array<{name:string}>;
  for (const row of noSources) issues.push({ severity: "warning", code: "NO_RAW_SOURCE", message: "Parsed peak has no archived raw HTML yet.", entity: row.name });

  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    issues,
  };
}

export const databasePath = DB_FILE;
