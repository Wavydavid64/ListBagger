#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup
from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB = DATA / "listbagger.db"
SOURCE = DATA / "source"
PEAK_HTML = SOURCE / "peaks"
LIST_HTML = SOURCE / "lists"
META = SOURCE / "meta"
PROFILE = ROOT / ".cache" / "peakbagger-map" / "chrome-profile"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
POLL = 1.0
DELAY = 1.0
SCHEMA = 1


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def ensure_dirs() -> None:
    for directory in (DATA, PEAK_HTML, LIST_HTML, META, PROFILE):
        directory.mkdir(parents=True, exist_ok=True)


def dbconn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
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
        """
    )
    return conn


def lid_from_url(url: str) -> int:
    parsed = urlparse(url)
    values = parse_qs(parsed.query).get("lid")
    if (
        parsed.hostname not in {"peakbagger.com", "www.peakbagger.com"}
        or not parsed.path.lower().endswith("/list.aspx")
        or not values
        or not re.fullmatch(r"-?\d+", values[0])
    ):
        raise ValueError("Invalid Peakbagger list URL.")
    return int(values[0])


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_cdp(port: int) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=1
            ) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("Chrome debugging connection did not start.")


def launch(url: str):
    if not CHROME.exists():
        raise RuntimeError("Google Chrome not found.")
    port = free_port()
    process = subprocess.Popen(
        [
            str(CHROME),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    wait_cdp(port)
    return process, port


def snapshot(page):
    try:
        return page.url, page.title(), page.content()
    except PlaywrightError as exc:
        message = str(exc).lower()
        if any(
            token in message
            for token in (
                "execution context was destroyed",
                "navigation",
                "cannot find context",
            )
        ):
            return None
        raise


def looks_real(html: str, kind: str) -> bool:
    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" ", strip=True))
    if kind == "list":
        return bool(soup.select_one('a[href*="peak.aspx?pid="]'))
    return "Latitude/Longitude (WGS84)" in text and bool(
        re.search(r"\bElevation:\s*[\d,]+", text, re.I)
    )


def cloudflare(title: str, html: str) -> bool:
    combined = (title + "\n" + html[:150000]).lower()
    return any(
        token in combined
        for token in (
            "just a moment",
            "cf-chl-",
            "challenge-platform",
            "verify you are human",
            "performing security verification",
            "checking your browser",
        )
    )


def wait_real(page, kind: str) -> str:
    signature = None
    stable = 0
    announced = False
    while True:
        snap = snapshot(page)
        if not snap:
            time.sleep(POLL)
            continue
        url, title, html = snap
        if "peakbagger.com" not in url.lower():
            signature = None
            stable = 0
            time.sleep(POLL)
            continue
        if looks_real(html, kind):
            if announced:
                log("Peakbagger verification complete. Resuming import.")
                announced = False
        elif cloudflare(title, html):
            if not announced:
                log(
                    "\nCloudflare verification is waiting in Chrome.\n"
                    "Complete it manually; import resumes automatically.\n"
                )
                announced = True
            signature = None
            stable = 0
            time.sleep(POLL)
            continue
        else:
            signature = None
            stable = 0
            time.sleep(POLL)
            continue
        new_signature = (url, len(html))
        stable = stable + 1 if new_signature == signature else 1
        signature = new_signature
        if stable >= 2:
            return html
        time.sleep(POLL)


def navigate(page, url: str, kind: str) -> str:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except PlaywrightError as exc:
        log(f"Navigation changed/timed out; waiting: {exc}")
    return wait_real(page, kind)


def fast_fetch(page, url: str, kind: str) -> str | None:
    script = """
    async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
      return {status: response.status, url: response.url, text: await response.text()};
    }
    """
    try:
        result = page.evaluate(script, url)
        html = str(result.get("text", ""))
        if int(result.get("status", 0)) == 200 and looks_real(html, kind):
            return html
    except PlaywrightError as exc:
        log(f"Fast browser fetch failed: {exc}")
    return None


def save_source(conn, kind: str, source_id: int, url: str, html: str):
    html_path = (PEAK_HTML if kind == "peak" else LIST_HTML) / f"{source_id}.html"
    html_path.write_text(html, encoding="utf-8")
    relative = str(html_path.relative_to(ROOT))
    fetched = now()
    digest = hashlib.sha256(html.encode()).hexdigest()
    byte_count = len(html.encode())
    (META / f"{kind}-{source_id}.json").write_text(
        json.dumps(
            {
                "schemaVersion": SCHEMA,
                "kind": kind,
                "sourceId": source_id,
                "url": url,
                "fetchedAt": fetched,
                "sha256": digest,
                "bytes": byte_count,
                "htmlPath": relative,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    conn.execute(
        """
        INSERT INTO source_pages(kind,source_id,url,archive_path,fetched_at,sha256,byte_count,schema_version)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(kind,source_id) DO UPDATE SET
          url=excluded.url, archive_path=excluded.archive_path,
          fetched_at=excluded.fetched_at, sha256=excluded.sha256,
          byte_count=excluded.byte_count, schema_version=excluded.schema_version
        """,
        (kind, source_id, url, relative, fetched, digest, byte_count, SCHEMA),
    )
    conn.commit()
    return relative, fetched


def parse_num(value: str):
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", value or "")
    return round(float(match.group().replace(",", ""))) if match else None


def parse_list(html: str, lid: int):
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.find("h1")
    name = clean(heading.get_text(" ", strip=True) if heading else "") or f"Peakbagger List {lid}"
    peaks = {}
    for anchor in soup.select('a[href*="peak.aspx?pid="]'):
        match = re.search(r"peak\.aspx\?pid=(-?\d+)", anchor.get("href") or "", re.I)
        if not match:
            continue
        pid = int(match.group(1))
        peak_name = clean(anchor.get_text(" ", strip=True))
        if pid in peaks or not peak_name:
            continue
        elevation = prominence = None
        row = anchor.find_parent("tr")
        if row:
            cells = [clean(td.get_text(" ", strip=True)) for td in row.find_all("td")]
            try:
                index = next(i for i, cell in enumerate(cells) if peak_name in cell)
                numbers = [n for n in (parse_num(cell) for cell in cells[index + 1 :]) if n is not None]
                elevation = numbers[0] if numbers else None
                prominence = numbers[-1] if len(numbers) > 1 else None
            except StopIteration:
                pass
        peaks[pid] = {
            "peakbaggerId": pid,
            "name": peak_name,
            "elevationFt": elevation,
            "prominenceFt": prominence,
        }
    if not peaks:
        raise RuntimeError("No peaks found on list page.")
    return name, list(peaks.values())


def source_attributes(soup: BeautifulSoup):
    output = {}
    for row in soup.find_all("tr"):
        cells = [
            clean(cell.get_text(" ", strip=True))
            for cell in row.find_all(["th", "td"])
            if clean(cell.get_text(" ", strip=True))
        ]
        if len(cells) == 2 and len(cells[0]) <= 100:
            output.setdefault(cells[0].rstrip(":"), cells[1])
    return output


def parse_peak(html: str, pid: int, fallback: dict, archive: str, fetched: str):
    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" ", strip=True))
    heading = soup.find("h1")
    name = clean(heading.get_text(" ", strip=True) if heading else "").split(",")[0].strip() or fallback["name"]
    coordinate_match = re.search(
        r"Latitude/Longitude\s*\(WGS84\)\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)",
        text,
        re.I,
    )
    if not coordinate_match:
        raise RuntimeError(f"No coordinates for pid={pid}")
    elevation_match = re.search(
        r"\bElevation:\s*([\d,]+(?:\.\d+)?)\s*(?:feet|ft)\b", text, re.I
    )
    prominence_match = re.search(
        r"\bProminence:\s*([\d,]+(?:\.\d+)?)\s*(?:feet|ft)\b", text, re.I
    )
    elevation = (
        round(float(elevation_match.group(1).replace(",", "")))
        if elevation_match
        else fallback.get("elevationFt")
    )
    prominence = (
        round(float(prominence_match.group(1).replace(",", "")))
        if prominence_match
        else fallback.get("prominenceFt")
    )
    if not elevation:
        raise RuntimeError(f"No elevation for pid={pid}")
    return (
        pid,
        name,
        float(coordinate_match.group(1)),
        float(coordinate_match.group(2)),
        int(elevation),
        None if prominence is None else int(prominence),
        f"https://www.peakbagger.com/peak.aspx?pid={pid}",
        archive,
        fetched,
        SCHEMA,
        json.dumps(source_attributes(soup), ensure_ascii=False),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    args = parser.parse_args()
    ensure_dirs()
    lid = lid_from_url(args.url)
    url = f"https://www.peakbagger.com/list.aspx?lid={lid}"
    list_id = f"peakbagger-{lid}"
    conn = dbconn()
    started = now()
    cursor = conn.execute(
        "INSERT INTO imports(source_url,list_id,status,started_at) VALUES(?,?,?,?)",
        (url, list_id, "running", started),
    )
    import_id = cursor.lastrowid
    conn.commit()
    chrome = None
    added = reused = 0

    try:
        chrome, port = launch(url)
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()
            list_html = wait_real(page, "list")
            list_archive, list_fetched = save_source(conn, "list", lid, url, list_html)
            name, stubs = parse_list(list_html, lid)
            total = len(stubs)

            conn.execute(
                """
                INSERT INTO lists(id,peakbagger_list_id,name,peak_count,source_url,source_archive,source_fetched_at,source_schema_version,updated_at)
                VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name, peak_count=excluded.peak_count,
                  source_url=excluded.source_url, source_archive=excluded.source_archive,
                  source_fetched_at=excluded.source_fetched_at,
                  source_schema_version=excluded.source_schema_version,
                  updated_at=CURRENT_TIMESTAMP
                """,
                (list_id, lid, name, total, url, list_archive, list_fetched, SCHEMA),
            )
            conn.execute("DELETE FROM peak_list_memberships WHERE list_id=?", (list_id,))
            conn.execute("UPDATE imports SET total_peaks=? WHERE id=?", (total, import_id))
            conn.commit()
            log(f"Found {total} peaks on {name}.")

            for index, stub in enumerate(stubs, 1):
                pid = stub["peakbaggerId"]
                row = conn.execute(
                    "SELECT peakbagger_id,source_archive FROM peaks WHERE peakbagger_id=?",
                    (pid,),
                ).fetchone()
                raw_path = PEAK_HTML / f"{pid}.html"

                if row and raw_path.exists():
                    reused += 1
                    log(f"[{index}/{total}] Cached {stub['name']}")
                else:
                    if raw_path.exists():
                        peak_html = raw_path.read_text(encoding="utf-8")
                        archive = str(raw_path.relative_to(ROOT))
                        fetched = now()
                    else:
                        log(f"[{index}/{total}] Fetching {stub['name']}")
                        peak_url = f"https://www.peakbagger.com/peak.aspx?pid={pid}"
                        peak_html = fast_fetch(page, peak_url, "peak")
                        if peak_html is None:
                            log("Fast fetch challenged; falling back to visible Chrome.")
                            peak_html = navigate(page, peak_url, "peak")
                            try:
                                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                                wait_real(page, "list")
                            except Exception:
                                pass
                        archive, fetched = save_source(conn, "peak", pid, peak_url, peak_html)
                        time.sleep(DELAY)

                    peak = parse_peak(peak_html, pid, stub, archive, fetched)
                    conn.execute(
                        """
                        INSERT INTO peaks(peakbagger_id,name,latitude,longitude,elevation_ft,prominence_ft,source_url,source_archive,source_fetched_at,source_schema_version,source_attributes_json,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                        ON CONFLICT(peakbagger_id) DO UPDATE SET
                          name=excluded.name, latitude=excluded.latitude,
                          longitude=excluded.longitude, elevation_ft=excluded.elevation_ft,
                          prominence_ft=excluded.prominence_ft, source_url=excluded.source_url,
                          source_archive=excluded.source_archive,
                          source_fetched_at=excluded.source_fetched_at,
                          source_schema_version=excluded.source_schema_version,
                          source_attributes_json=excluded.source_attributes_json,
                          updated_at=CURRENT_TIMESTAMP
                        """,
                        peak,
                    )
                    added += 1

                conn.execute(
                    "INSERT OR IGNORE INTO peak_list_memberships(peakbagger_id,list_id) VALUES(?,?)",
                    (pid, list_id),
                )
                conn.execute(
                    "UPDATE imports SET processed_peaks=?,added_peaks=?,reused_peaks=? WHERE id=?",
                    (index, added, reused, import_id),
                )
                conn.commit()

            conn.execute(
                "UPDATE imports SET status=?,completed_at=?,processed_peaks=?,added_peaks=?,reused_peaks=? WHERE id=?",
                ("complete", now(), total, added, reused, import_id),
            )
            conn.commit()
            browser.close()

        print(
            json.dumps(
                {
                    "peakbaggerListId": lid,
                    "sourceUrl": url,
                    "name": name,
                    "addedPeaks": added,
                    "reusedPeaks": reused,
                    "totalPeaks": total,
                }
            )
        )
        return 0
    except KeyboardInterrupt:
        conn.execute(
            "UPDATE imports SET status=?,completed_at=?,error=? WHERE id=?",
            ("cancelled", now(), "Import cancelled", import_id),
        )
        conn.commit()
        log("Import cancelled")
        return 130
    except Exception as exc:
        conn.execute(
            "UPDATE imports SET status=?,completed_at=?,error=? WHERE id=?",
            ("failed", now(), str(exc), import_id),
        )
        conn.commit()
        log(f"Importer failed: {exc}")
        return 3
    finally:
        conn.close()
        if chrome and chrome.poll() is None:
            chrome.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
