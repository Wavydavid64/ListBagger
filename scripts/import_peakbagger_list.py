#!/usr/bin/env python3
"""
Peakbagger list importer for Mountaineers Peak Map.

Design goals:
- Cloudflare verification is manual; never automate CAPTCHA solving.
- Launch normal Google Chrome and attach over CDP.
- After verification, fetch peak HTML inside the verified browser session
  without navigating the visible tab whenever possible.
- Fall back to visible navigation if an in-browser fetch is challenged.
- Save raw HTML for every list and peak so future parsers can recover fields
  without contacting Peakbagger again.
- Checkpoint parsed peak data after EVERY successful peak so interrupted
  imports resume from the local cache.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup
from playwright.sync_api import Error as PlaywrightError, sync_playwright

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
PEAKS_FILE = DATA_DIR / "peaks.json"
LISTS_FILE = DATA_DIR / "lists.json"
SOURCE_DIR = DATA_DIR / "source"
PEAK_HTML_DIR = SOURCE_DIR / "peaks"
LIST_HTML_DIR = SOURCE_DIR / "lists"
META_DIR = SOURCE_DIR / "meta"

PROFILE_DIR = PROJECT_ROOT / ".cache" / "peakbagger-map" / "chrome-profile"
CHROME_BIN = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

POLL_SECONDS = 1.0
SETTLE_POLLS_REQUIRED = 2
REQUEST_DELAY_SECONDS = 1.0
CDP_STARTUP_TIMEOUT_SECONDS = 30.0
CACHE_SCHEMA_VERSION = 1


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def parse_number(value: str) -> int | None:
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", value or "")
    if not match:
        return None
    try:
        return round(float(match.group(0).replace(",", "")))
    except ValueError:
        return None


def list_id_from_url(url: str) -> int:
    parsed = urlparse(url)
    if parsed.hostname not in {"peakbagger.com", "www.peakbagger.com"}:
        raise ValueError("URL must be from peakbagger.com.")
    if not parsed.path.lower().endswith("/list.aspx"):
        raise ValueError("URL must be a Peakbagger list.aspx page.")
    values = parse_qs(parsed.query).get("lid")
    if not values or not re.fullmatch(r"-?\d+", values[0]):
        raise ValueError("Peakbagger list URL must include a numeric lid.")
    return int(values[0])


def ensure_dirs() -> None:
    for directory in (DATA_DIR, PEAK_HTML_DIR, LIST_HTML_DIR, META_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    for file in (PEAKS_FILE, LISTS_FILE):
        if not file.exists():
            atomic_write_text(file, "[]\n")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def atomic_write_json(path: Path, value) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_source(kind: str, source_id: int, url: str, html: str) -> str:
    if kind == "peak":
        html_path = PEAK_HTML_DIR / f"{source_id}.html"
    else:
        html_path = LIST_HTML_DIR / f"{source_id}.html"

    atomic_write_text(html_path, html)

    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
    meta = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "kind": kind,
        "sourceId": source_id,
        "url": url,
        "fetchedAt": utc_now(),
        "sha256": digest,
        "bytes": len(html.encode("utf-8")),
        "htmlPath": str(html_path.relative_to(PROJECT_ROOT)),
    }
    atomic_write_json(META_DIR / f"{kind}-{source_id}.json", meta)
    return str(html_path.relative_to(PROJECT_ROOT))


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_cdp(port: int) -> None:
    deadline = time.monotonic() + CDP_STARTUP_TIMEOUT_SECONDS
    url = f"http://127.0.0.1:{port}/json/version"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("Chrome opened but its local debugging connection did not start.")


def launch_chrome(url: str) -> tuple[subprocess.Popen, int]:
    if not CHROME_BIN.exists():
        raise RuntimeError("Google Chrome was not found in /Applications.")
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    port = find_free_port()
    process = subprocess.Popen(
        [
            str(CHROME_BIN),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={PROFILE_DIR}",
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    log("Opening normal Google Chrome.")
    wait_for_cdp(port)
    return process, port


def safe_snapshot(page) -> tuple[str, str, str] | None:
    try:
        return page.url, page.title(), page.content()
    except PlaywrightError as exc:
        message = str(exc).lower()
        if any(
            token in message
            for token in (
                "execution context was destroyed",
                "most likely because of a navigation",
                "cannot find context",
                "navigation",
            )
        ):
            return None
        raise


def is_cloudflare(title: str, html: str) -> bool:
    combined = f"{title}\n{html[:150000]}".lower()
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


def page_looks_real(html: str, expected_kind: str) -> bool:
    soup = BeautifulSoup(html, "html.parser")
    text = clean_text(soup.get_text(" ", strip=True))
    if expected_kind == "list":
        return bool(soup.select_one('a[href*="peak.aspx?pid="]'))
    return (
        "Latitude/Longitude (WGS84)" in text
        and bool(re.search(r"\bElevation:\s*[\d,]+", text, re.I))
    )


def wait_for_real_page(page, *, expected_kind: str) -> str:
    stable_signature = None
    stable_count = 0
    announced = False

    while True:
        snapshot = safe_snapshot(page)
        if snapshot is None:
            time.sleep(POLL_SECONDS)
            continue

        url, title, html = snapshot

        if "peakbagger.com" not in url.lower():
            stable_signature = None
            stable_count = 0
            time.sleep(POLL_SECONDS)
            continue

        # Genuine content wins over residual Cloudflare scripts.
        if page_looks_real(html, expected_kind):
            if announced:
                log("Peakbagger verification complete. Resuming import.")
                announced = False
        elif is_cloudflare(title, html):
            if not announced:
                log("")
                log("Cloudflare verification is waiting in Chrome.")
                log("Complete it manually in the Chrome window.")
                log("The import will resume automatically afterward.")
                log("")
                announced = True
            stable_signature = None
            stable_count = 0
            time.sleep(POLL_SECONDS)
            continue
        else:
            stable_signature = None
            stable_count = 0
            time.sleep(POLL_SECONDS)
            continue

        signature = (url, len(html))
        if signature == stable_signature:
            stable_count += 1
        else:
            stable_signature = signature
            stable_count = 1

        if stable_count >= SETTLE_POLLS_REQUIRED:
            return html
        time.sleep(POLL_SECONDS)


def navigate_and_wait(page, url: str, *, expected_kind: str) -> str:
    log(f"Navigating Chrome to {url}")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45_000)
    except PlaywrightError as exc:
        log(f"Navigation changed/timed out; waiting for final page: {exc}")
    return wait_for_real_page(page, expected_kind=expected_kind)


def browser_fetch_html(page, url: str, *, expected_kind: str) -> str | None:
    """
    Fetch a same-origin page through the already verified Chrome tab without
    navigating it. This uses Chrome's own network/session state and is much
    faster than full-page navigation. If Peakbagger responds with a challenge,
    return None so the caller can fall back to visible navigation.
    """
    script = """
    async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow"
      });
      return {
        status: response.status,
        url: response.url,
        text: await response.text()
      };
    }
    """

    for attempt in range(3):
        try:
            result = page.evaluate(script, url)
            status = int(result.get("status", 0))
            html = str(result.get("text", ""))
            final_url = str(result.get("url", ""))

            if (
                status == 200
                and "peakbagger.com" in final_url.lower()
                and page_looks_real(html, expected_kind)
            ):
                return html

            if status in {403, 429} or is_cloudflare("", html):
                return None

            log(f"In-browser fetch returned HTTP {status}; retrying.")
        except PlaywrightError as exc:
            if "execution context was destroyed" in str(exc).lower():
                time.sleep(1)
                continue
            log(f"In-browser fetch failed: {exc}")
            return None
        time.sleep(1)

    return None


def parse_list(html: str, lid: int) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    name = clean_text(h1.get_text(" ", strip=True) if h1 else "")
    if not name:
        title = clean_text(soup.title.get_text(" ", strip=True) if soup.title else "")
        name = re.sub(
            r"\s*[-|]?\s*Peakbagger(?:\.com)?\s*$", "", title, flags=re.I
        ).strip()
    if not name:
        name = f"Peakbagger List {lid}"

    peaks_by_pid: dict[int, dict] = {}

    for anchor in soup.select('a[href*="peak.aspx?pid="]'):
        href = anchor.get("href") or ""
        match = re.search(r"peak\.aspx\?pid=(-?\d+)", href, re.I)
        if not match:
            continue
        pid = int(match.group(1))
        if pid in peaks_by_pid:
            continue

        peak_name = clean_text(anchor.get_text(" ", strip=True))
        if not peak_name:
            continue

        elevation_ft = None
        prominence_ft = None
        row = anchor.find_parent("tr")
        row_text = clean_text(row.get_text(" ", strip=True)) if row else ""

        if row:
            cells = [clean_text(td.get_text(" ", strip=True)) for td in row.find_all("td")]
            try:
                peak_index = next(i for i, cell in enumerate(cells) if peak_name in cell)
            except StopIteration:
                peak_index = -1
            if peak_index >= 0:
                numeric = [
                    value
                    for value in (parse_number(cell) for cell in cells[peak_index + 1 :])
                    if value is not None
                ]
                if numeric:
                    elevation_ft = numeric[0]
                if len(numeric) >= 2:
                    prominence_ft = numeric[-1]

        peaks_by_pid[pid] = {
            "peakbaggerId": pid,
            "name": peak_name,
            "elevationFt": elevation_ft,
            "prominenceFt": prominence_ft,
            "listRowText": row_text or None,
        }

    if not peaks_by_pid:
        raise RuntimeError("Peakbagger loaded, but no peak links were found.")

    return {"name": name, "peaks": list(peaks_by_pid.values())}


def extract_all_label_values(soup: BeautifulSoup) -> dict[str, str]:
    """
    Preserve generic label/value text from Peakbagger tables. Raw HTML is still
    the authoritative future-proof cache; this dictionary is a convenience.
    """
    result: dict[str, str] = {}

    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all(["th", "td"])]
        cells = [cell for cell in cells if cell]
        if len(cells) == 2:
            key = cells[0].rstrip(":").strip()
            value = cells[1].strip()
            if key and value and len(key) <= 100:
                result.setdefault(key, value)

    # Also capture obvious "Label: value" lines from the page.
    text = soup.get_text("\n", strip=True)
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        match = re.match(r"^([A-Za-z][A-Za-z0-9 /()'&.-]{1,80}):\s*(.+)$", line)
        if match:
            result.setdefault(match.group(1).strip(), match.group(2).strip())

    return result


def parse_peak(html: str, pid: int, fallback: dict, source_archive: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    text = clean_text(soup.get_text(" ", strip=True))

    heading = soup.find("h1")
    name = clean_text(heading.get_text(" ", strip=True) if heading else "")
    if name:
        name = name.split(",")[0].strip()
    if not name:
        name = fallback["name"]

    coordinate_match = re.search(
        r"Latitude/Longitude\s*\(WGS84\)\s*"
        r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)",
        text,
        re.I,
    )
    if not coordinate_match:
        coordinate_match = re.search(
            r"Latitude/Longitude[^-\d]*"
            r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)",
            text,
            re.I,
        )
    if not coordinate_match:
        raise RuntimeError(f"Could not find WGS84 coordinates for pid={pid}.")

    latitude = float(coordinate_match.group(1))
    longitude = float(coordinate_match.group(2))

    elevation_ft = None
    match = re.search(
        r"\bElevation:\s*([\d,]+(?:\.\d+)?)\s*(?:feet|ft)\b", text, re.I
    )
    if match:
        elevation_ft = round(float(match.group(1).replace(",", "")))
    elif isinstance(fallback.get("elevationFt"), int):
        elevation_ft = fallback["elevationFt"]

    if not isinstance(elevation_ft, int) or elevation_ft <= 0:
        raise RuntimeError(f"Could not determine elevation for pid={pid}.")

    prominence_ft = None
    match = re.search(
        r"\bProminence:\s*([\d,]+(?:\.\d+)?)\s*(?:feet|ft)\b", text, re.I
    )
    if match:
        prominence_ft = round(float(match.group(1).replace(",", "")))
    elif isinstance(fallback.get("prominenceFt"), int):
        prominence_ft = fallback["prominenceFt"]

    return {
        "peakbaggerId": pid,
        "name": name,
        "latitude": latitude,
        "longitude": longitude,
        "elevationFt": elevation_ft,
        "prominenceFt": prominence_ft,
        "sourceUrl": f"https://www.peakbagger.com/peak.aspx?pid={pid}",
        "sourceArchive": source_archive,
        "sourceFetchedAt": utc_now(),
        "sourceSchemaVersion": CACHE_SCHEMA_VERSION,
        "sourceAttributes": extract_all_label_values(soup),
        "listIds": [],
    }


def checkpoint_peak(peak: dict) -> None:
    peaks = read_json(PEAKS_FILE, [])
    by_pid = {
        item.get("peakbaggerId"): item
        for item in peaks
        if isinstance(item, dict) and isinstance(item.get("peakbaggerId"), int)
    }
    existing = by_pid.get(peak["peakbaggerId"])
    if existing:
        memberships = existing.get("listIds", [])
        peak["listIds"] = list(dict.fromkeys([*memberships, *peak.get("listIds", [])]))
    by_pid[peak["peakbaggerId"]] = peak
    output = sorted(by_pid.values(), key=lambda item: str(item.get("name", "")).lower())
    atomic_write_json(PEAKS_FILE, output)


def add_list_membership(pid: int, list_id: str, list_name: str) -> None:
    peaks = read_json(PEAKS_FILE, [])
    changed = False
    for peak in peaks:
        if peak.get("peakbaggerId") == pid:
            memberships = [
                value for value in peak.get("listIds", []) if value != list_id
            ]
            memberships.append(list_id)
            peak["listIds"] = list(dict.fromkeys(memberships))
            changed = True
            break
    if not changed:
        raise RuntimeError(f"Could not checkpoint membership for pid={pid}.")
    atomic_write_json(PEAKS_FILE, peaks)


def remove_list_membership_everywhere(list_id: str) -> None:
    peaks = read_json(PEAKS_FILE, [])
    for peak in peaks:
        peak["listIds"] = [
            value for value in peak.get("listIds", []) if value != list_id
        ]
    # Keep cached peaks even if they currently belong to zero imported lists.
    # They remain useful source data and can be reused without refetching.
    atomic_write_json(PEAKS_FILE, peaks)


def save_list_record(lid: int, name: str, peak_count: int, source_archive: str) -> None:
    lists = read_json(LISTS_FILE, [])
    list_id = f"peakbagger-{lid}"
    record = {
        "id": list_id,
        "peakbaggerListId": lid,
        "name": name,
        "peakCount": peak_count,
        "sourceUrl": f"https://www.peakbagger.com/list.aspx?lid={lid}",
        "sourceArchive": source_archive,
        "sourceFetchedAt": utc_now(),
        "sourceSchemaVersion": CACHE_SCHEMA_VERSION,
    }
    lists = [item for item in lists if item.get("id") != list_id]
    lists.append(record)
    lists.sort(key=lambda item: str(item.get("name", "")).lower())
    atomic_write_json(LISTS_FILE, lists)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--existing-peaks", required=False)
    args = parser.parse_args()

    ensure_dirs()

    try:
        lid = list_id_from_url(args.url)
    except ValueError as exc:
        log(str(exc))
        return 2

    canonical_url = f"https://www.peakbagger.com/list.aspx?lid={lid}"
    list_id = f"peakbagger-{lid}"

    existing_peaks = read_json(PEAKS_FILE, [])
    existing_by_pid = {
        item.get("peakbaggerId"): item
        for item in existing_peaks
        if isinstance(item, dict) and isinstance(item.get("peakbaggerId"), int)
    }

    result = {
        "peakbaggerListId": lid,
        "sourceUrl": canonical_url,
        "name": "",
        "addedPeaks": 0,
        "reusedPeaks": 0,
        "totalPeaks": 0,
    }

    chrome_process = None

    try:
        chrome_process, port = launch_chrome(canonical_url)

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{port}"
            )
            if not browser.contexts:
                raise RuntimeError("Connected to Chrome but found no browser context.")
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.new_page()

            list_html = wait_for_real_page(page, expected_kind="list")
            list_archive = save_source("list", lid, canonical_url, list_html)
            parsed_list = parse_list(list_html, lid)

            result["name"] = parsed_list["name"]
            stubs = parsed_list["peaks"]
            result["totalPeaks"] = len(stubs)
            log(f"Found {len(stubs)} peaks on {result['name']}.")

            # Refresh membership for this list. Cached mountains themselves stay.
            remove_list_membership_everywhere(list_id)

            total = len(stubs)
            for index, stub in enumerate(stubs, start=1):
                pid = stub["peakbaggerId"]
                existing = existing_by_pid.get(pid)
                cached_html_path = PEAK_HTML_DIR / f"{pid}.html"
                peak_html = None

                # A peak is only considered fully cached when its complete
                # source HTML is archived. Older versions stored only parsed
                # fields; those legacy entries are backfilled once so future
                # parsers can recover new fields without contacting Peakbagger.
                if (
                    existing
                    and cached_html_path.exists()
                    and all(
                        isinstance(existing.get(field), (int, float))
                        for field in ("latitude", "longitude", "elevationFt")
                    )
                ):
                    log(f"[{index}/{total}] Fully cached pid={pid} {stub['name']}")
                    add_list_membership(pid, list_id, result["name"])
                    result["reusedPeaks"] += 1
                    continue

                if cached_html_path.exists():
                    log(f"[{index}/{total}] Reparsing raw cache pid={pid} {stub['name']}")
                    peak_html = cached_html_path.read_text(encoding="utf-8")
                else:
                    if existing:
                        log(
                            f"[{index}/{total}] Backfilling source archive "
                            f"pid={pid} {stub['name']}"
                        )
                    else:
                        log(f"[{index}/{total}] Fetching pid={pid} {stub['name']}")
                    peak_url = f"https://www.peakbagger.com/peak.aspx?pid={pid}"

                    peak_html = browser_fetch_html(
                        page, peak_url, expected_kind="peak"
                    )

                    if peak_html is None:
                        log("Fast fetch was challenged; falling back to visible Chrome.")
                        peak_html = navigate_and_wait(
                            page, peak_url, expected_kind="peak"
                        )
                        # Return to list page once manual verification/navigation settles.
                        try:
                            page.goto(canonical_url, wait_until="domcontentloaded", timeout=45_000)
                            wait_for_real_page(page, expected_kind="list")
                        except PlaywrightError:
                            pass

                    save_source("peak", pid, peak_url, peak_html)
                    time.sleep(REQUEST_DELAY_SECONDS)

                archive_rel = str((PEAK_HTML_DIR / f"{pid}.html").relative_to(PROJECT_ROOT))
                peak = parse_peak(peak_html, pid, stub, archive_rel)
                peak["listIds"] = [list_id]
                checkpoint_peak(peak)
                existing_by_pid[pid] = peak
                result["addedPeaks"] += 1

            save_list_record(
                lid,
                result["name"],
                len(stubs),
                list_archive,
            )

            browser.close()

    except KeyboardInterrupt:
        log("Import cancelled. Successfully fetched peaks remain cached.")
        return 130
    except Exception as exc:
        log(f"Importer failed: {exc}")
        log("Successfully fetched peaks remain cached and will be reused next time.")
        return 3
    finally:
        if chrome_process is not None and chrome_process.poll() is None:
            chrome_process.terminate()

    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
