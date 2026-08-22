import express from "express";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const LISTS_FILE = path.join(DATA_DIR, "lists.json");
const PEAKS_FILE = path.join(DATA_DIR, "peaks.json");
const VENV_DIR = path.join(__dirname, ".venv");
const PYTHON_BIN = path.join(VENV_DIR, "bin", "python");
const BROWSER_IMPORT_SCRIPT = path.join(
  __dirname,
  "scripts",
  "import_peakbagger_list.py",
);
const PORT = Number(process.env.PORT ?? 5173);

interface PeakList {
  id: string;
  peakbaggerListId: number;
  name: string;
  peakCount: number;
  sourceUrl: string;
}

interface Peak {
  peakbaggerId: number;
  name: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  prominenceFt?: number;
  sourceUrl: string;
  listIds: string[];
}

interface ImportResult {
  peakbaggerListId: number;
  sourceUrl: string;
  name: string;
  addedPeaks: number;
  reusedPeaks: number;
  totalPeaks: number;
}

await ensureDataFiles();

const app = express();
app.use(express.json());

app.get("/api/data", async (_req, res) => {
  try {
    const [lists, peaks] = await Promise.all([
      readJson<PeakList[]>(LISTS_FILE),
      readJson<Peak[]>(PEAKS_FILE),
    ]);
    res.json({ lists, peaks });
  } catch (error) {
    res.status(500).json({ error: messageFrom(error) });
  }
});

app.get("/api/importer-status", async (_req, res) => {
  const [pythonExists, scriptExists] = await Promise.all([
    fileExists(PYTHON_BIN),
    fileExists(BROWSER_IMPORT_SCRIPT),
  ]);

  res.json({
    ready: pythonExists && scriptExists,
    pythonExists,
    scriptExists,
    setupCommand: "npm run setup:browser",
  });
});

app.post("/api/import-list", async (req, res) => {
  try {
    await assertImporterReady();
    const url = validatePeakbaggerListUrl(req.body?.url);
    const result = await importPeakbaggerList(url);
    res.json({
      list: {
        id: `peakbagger-${result.peakbaggerListId}`,
        peakbaggerListId: result.peakbaggerListId,
        name: result.name,
        peakCount: result.totalPeaks,
        sourceUrl: result.sourceUrl,
      },
      addedPeaks: result.addedPeaks,
      reusedPeaks: result.reusedPeaks,
      totalPeaks: result.totalPeaks,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: messageFrom(error) });
  }
});

const devMode = process.argv.includes("--dev");

if (devMode) {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(__dirname, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Mountaineers Peak Map: http://127.0.0.1:${PORT}`);
});

async function importPeakbaggerList(
  sourceUrl: URL,
): Promise<ImportResult> {
  const lid = Number(sourceUrl.searchParams.get("lid"));
  const canonicalUrl = `https://www.peakbagger.com/list.aspx?lid=${lid}`;

  console.log(`Importing Peakbagger list ${canonicalUrl}`);

  const result = await runProcess(
    PYTHON_BIN,
    [BROWSER_IMPORT_SCRIPT, canonicalUrl],
    { timeoutMs: 0 },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || "Peakbagger browser importer failed.",
    );
  }

  try {
    return JSON.parse(result.stdout) as ImportResult;
  } catch {
    throw new Error(
      "Peakbagger browser importer returned invalid JSON. " +
        "See the terminal for import progress.",
    );
  }
}

async function assertImporterReady(): Promise<void> {
  const missing: string[] = [];

  if (!(await fileExists(PYTHON_BIN))) {
    missing.push(".venv Python");
  }
  if (!(await fileExists(BROWSER_IMPORT_SCRIPT))) {
    missing.push("browser import script");
  }

  if (missing.length > 0) {
    throw new Error(
      `Browser importer is not installed (${missing.join(", ")}). ` +
        "From the repository run: npm run setup:browser",
    );
  }
}

function validatePeakbaggerListUrl(value: unknown): URL {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Enter a Peakbagger list URL.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("That is not a valid URL.");
  }

  if (!/(^|\.)peakbagger\.com$/i.test(url.hostname)) {
    throw new Error("The URL must be from peakbagger.com.");
  }

  if (!/\/list\.aspx$/i.test(url.pathname)) {
    throw new Error("The URL must be a Peakbagger list.aspx link.");
  }

  const lid = Number(url.searchParams.get("lid"));
  if (!Number.isInteger(lid)) {
    throw new Error("The Peakbagger URL does not contain a valid list ID (lid).");
  }

  return url;
}

function validateDataset(lists: PeakList[], peaks: Peak[]): void {
  const listIds = new Set<string>();

  for (const list of lists) {
    if (listIds.has(list.id)) {
      throw new Error(`Duplicate list ID ${list.id}.`);
    }
    listIds.add(list.id);
  }

  const peakIds = new Set<number>();

  for (const peak of peaks) {
    if (peakIds.has(peak.peakbaggerId)) {
      throw new Error(`Duplicate Peakbagger peak ID ${peak.peakbaggerId}.`);
    }
    peakIds.add(peak.peakbaggerId);

    if (
      !Number.isFinite(peak.latitude) ||
      !Number.isFinite(peak.longitude)
    ) {
      throw new Error(`Missing coordinates for ${peak.name}.`);
    }

    if (peak.latitude < -90 || peak.latitude > 90) {
      throw new Error(`Invalid latitude for ${peak.name}.`);
    }
    if (peak.longitude < -180 || peak.longitude > 180) {
      throw new Error(`Invalid longitude for ${peak.name}.`);
    }

    for (const listId of peak.listIds) {
      if (!listIds.has(listId)) {
        throw new Error(`${peak.name} references unknown list ${listId}.`);
      }
    }
  }

  for (const list of lists) {
    const actual = peaks.filter((peak) => peak.listIds.includes(list.id)).length;
    if (actual !== list.peakCount) {
      throw new Error(
        `${list.name} says ${list.peakCount} peaks but the local dataset has ${actual}.`,
      );
    }
  }
}

async function ensureDataFiles(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });

  for (const file of [LISTS_FILE, PEAKS_FILE]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "[]\n", "utf8");
    }
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            child.kill("SIGTERM");
            settled = true;
            reject(
              new Error(
                `${path.basename(command)} timed out after ${Math.round(
                  options.timeoutMs / 1000,
                )} seconds.`,
              ),
            );
          }, options.timeoutMs)
        : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
