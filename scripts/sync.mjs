#!/usr/bin/env node
/**
 * Syncs photos from a public VSCO profile grid (vsco.co/<user>).
 *
 * Strategy (mirrors the battle-tested gallery-dl VSCO extractor):
 *   1. Fetch  https://vsco.co/<user>/gallery  and pull the __PRELOADED_STATE__ JSON
 *      embedded in the page. It contains a per-visit bearer token (`tkn`) and the
 *      user's `site_id`.
 *   2. Paginate  https://vsco.co/api/3.0/medias/profile?site_id=<id>&limit=14&cursor=...
 *      with `Authorization: Bearer <tkn>` plus the web client headers.
 *   3. Normalize every photo and write src/data/photos.json.
 *
 * Why curl: VSCO sits behind Cloudflare, which rejects anything that doesn't look
 * like a real browser. Node's built-in fetch fails on TLS fingerprint, and a plain
 * curl with only a User-Agent now returns 403 — Cloudflare's WAF also wants the
 * `sec-ch-ua*` client hints and `Sec-Fetch-*` fetch-metadata headers, so we send
 * them. The system curl (curl.exe on Windows, curl on Ubuntu/Linux) satisfies all
 * of this. If curl is unavailable, install it or set CURL_BIN.
 *
 * Usage:
 *   npm run sync              # fetch everything and write src/data/photos.json
 *   npm run probe             # diagnostics only; prints what would be fetched
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const probeOnly = process.argv.includes("--probe");
const USER = (process.env.VSCO_USER || "sockyeh").toLowerCase();
const ROOT = "https://vsco.co";
const OUT_URL = new URL("../src/data/photos.json", import.meta.url);
const CURL = process.env.CURL_BIN || (process.platform === "win32" ? "curl.exe" : "curl");

const LIMIT = "14";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 1200;
const MAX_BUFFER = 64 * 1024 * 1024;
const RETRIES = 4;
const RETRY_BASE_MS = 3000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Cloudflare's WAF rejects requests that look non-browser. Any one of the
 * `sec-ch-ua*` / `Sec-Fetch-*` headers is enough to flip a 403 into a 200, so we
 * send the full set a real Chrome navigation would.
 */
const CLIENT_HINTS = {
  "sec-ch-ua":
    '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-ch-ua-platform-version": '"15.0.0"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"140.0.7339.80"',
  "sec-ch-ua-model": '""',
};

/** Fetch-Metadata differs between a top-level navigation and a same-origin XHR. */
const FETCH_METADATA = {
  document: {
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  },
  xhr: {
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  },
};

const COOKIE_JAR = join(tmpdir(), "vsco-sync-cookies.txt");
const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureScheme = (u) => (/^https?:\/\//.test(u) ? u : `https://${u}`);

function log(...args) {
  console.log("[vsco]", ...args);
}

function cloudflareRay(body) {
  const m = /Cloudflare Ray ID:\s*<strong[^>]*>([a-f0-9]+)/i.exec(body || "");
  return m ? m[1] : null;
}

/**
 * HTTP GET via curl. Returns { code, body } where `code` is the HTTP status
 * and `body` is the raw response text (empty on hard failures).
 *
 * `kind` selects the Fetch-Metadata profile ("document" for the HTML page,
 * "xhr" for the JSON API). 403/429/5xx are retried with exponential backoff,
 * because Cloudflare throttles bursts rather than blocking outright.
 */
async function curl(url, { accept, kind = "document", headers = {} } = {}) {
  const args = [
    "-sSL",
    "--compressed",
    "--max-time",
    "60",
    "-A",
    UA,
    "-b",
    COOKIE_JAR,
    "-c",
    COOKIE_JAR,
    "-H",
    `Accept: ${accept}`,
    "-H",
    "Accept-Language: en-US,en;q=0.9",
    "-H",
    "Cache-Control: no-cache",
    "-H",
    "Pragma: no-cache",
  ];
  for (const [k, v] of Object.entries({ ...CLIENT_HINTS, ...FETCH_METADATA[kind] })) {
    args.push("-H", `${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", "\n%{http_code}", url);

  let lastError = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
      log(`retry ${attempt}/${RETRIES - 1} in ${wait}ms (${url.slice(0, 60)}...)`);
      await sleep(wait);
    }

    let stdout = "";
    try {
      const res = await execFileAsync(CURL, args, {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      });
      stdout = res.stdout;
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(
          `${CURL} not found. This script needs the system curl binary ` +
            `(curl.exe on Windows, curl on Ubuntu/Linux). ` +
            `If you don't have it, install curl and set CURL_BIN to its path.`,
        );
      }
      lastError = new Error(`curl failed for ${url}: ${e.message}`);
      continue;
    }

    const nl = stdout.lastIndexOf("\n");
    const body = nl === -1 ? "" : stdout.slice(0, nl);
    const code = Number((nl === -1 ? stdout : stdout.slice(nl + 1)).trim());

    if (!RETRY_STATUS.has(code)) return { code, body };
    lastError = new Error(`HTTP ${code} for ${url}${cloudflareRay(body) ? ` (Ray ${cloudflareRay(body)})` : ""}`);
  }

  throw lastError ?? new Error(`HTTP request failed for ${url}`);
}

const htmlAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const jsonAccept = "application/json, text/plain, */*";

/**
 * Fetch the gallery page and parse the __PRELOADED_STATE__ JSON out of the HTML.
 */
async function getPreloadState() {
  const url = `${ROOT}/${USER}/gallery`;
  log(`GET ${url}`);
  const { code, body } = await curl(url, { accept: htmlAccept, kind: "document" });
  if (code !== 200) {
    if (code === 403) {
      throw new Error(
        `GET ${url} -> HTTP 403. Cloudflare blocked this request` +
          `${cloudflareRay(body) ? ` (Ray ${cloudflareRay(body)})` : ""}. ` +
          `Wait a few minutes before retrying and avoid rapid syncs — ` +
          `Cloudflare throttles bursts.`,
      );
    }
    throw new Error(`GET ${url} -> HTTP ${code}`);
  }

  const marker = "__PRELOADED_STATE__ = ";
  const i = body.indexOf(marker);
  if (i === -1) {
    throw new Error(
      "Could not find __PRELOADED_STATE__ in the page. The page structure may have changed.",
    );
  }

  const start = i + marker.length;
  const end = body.indexOf("<", start);
  const slice = body.slice(start, end === -1 ? body.length : end);

  try {
    return JSON.parse(slice.replace(/":undefined/g, '":null'));
  } catch (e) {
    throw new Error(`Failed to parse __PRELOADED_STATE__: ${e.message}`);
  }
}

function siteInfo(state) {
  const site = state.sites?.siteByUsername?.[USER]?.site;
  if (!site) {
    throw new Error(
      `Could not find site for "@${USER}" in the preload state. ` +
        `Is the username correct and is the profile public?`,
    );
  }
  return {
    tkn: state.users?.currentUser?.tkn,
    siteId: String(site.id),
    username: site.username || USER,
    name: site.name || site.username || USER,
    profileImage: site.profileImage || "",
    description: site.description || "",
  };
}

/**
 * Paginate /api/3.0/medias/profile, yielding every media object.
 */
async function* fetchMedia(siteId, tkn) {
  const base = `${ROOT}/api/3.0/medias/profile`;
  const headers = {
    Referer: `${ROOT}/${USER}`,
    Authorization: `Bearer ${tkn}`,
    "X-Client-Platform": "web",
    "X-Client-Build": "1",
  };

  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ site_id: siteId, limit: LIMIT });
    if (cursor) params.set("cursor", cursor);

    const { code, body } = await curl(`${base}?${params}`, {
      accept: jsonAccept,
      kind: "xhr",
      headers,
    });
    if (code !== 200) {
      throw new Error(`medias/profile API -> HTTP ${code}`);
    }

    const data = JSON.parse(body);
    const batch = Array.isArray(data.media) ? data.media : [];
    if (batch.length) {
      for (const m of batch) {
        const inner = m && typeof m === "object" && m.type ? m[m.type] : m;
        if (inner) yield inner;
      }
    }

    cursor = data.next_cursor || null;
    if (!cursor) break;
    await sleep(PAGE_DELAY_MS);
  }
}

/**
 * Build the full-size CDN URL exactly the way gallery-dl does.
 */
function resolveFull(responsive) {
  if (/^https?:\/\//.test(responsive)) return responsive;

  const slash = responsive.indexOf("/");
  if (slash === -1) return null;
  const base = responsive.slice(slash + 1);
  const cdnEnd = base.indexOf("/");
  const cdn = cdnEnd === -1 ? base : base.slice(0, cdnEnd);
  const path = cdnEnd === -1 ? "" : base.slice(cdnEnd + 1);

  if (cdn.startsWith("aws")) return `https://image-${cdn}.vsco.co/${path}`;
  if (/^\d+$/.test(cdn)) return `https://image.vsco.co/${base}`;
  return `https://${responsive}`;
}

function normalize(media) {
  if (!media) return null;

  const isVideo = !!media.is_video || !!media.isVideo;
  const responsive = media.responsive_url || media.responsiveUrl || "";
  const videoUrl = media.video_url || media.videoUrl || "";

  if (!isVideo && !responsive) return null;

  const full = isVideo ? ensureScheme(videoUrl) : resolveFull(responsive);
  if (!full) return null;

  const rawDate = media.upload_date ?? media.uploadDate;
  let date = 0;
  if (typeof rawDate === "number") date = rawDate;
  else if (typeof rawDate === "string") {
    const t = Date.parse(rawDate);
    if (!Number.isNaN(t)) date = t;
  }

  return {
    id: String(media._id || media.id || full),
    full,
    thumb: full,
    width: media.width || 0,
    height: media.height || 0,
    caption: media.description || media.caption || "",
    date,
    video: isVideo,
    tags: Array.isArray(media.tags)
      ? media.tags.map((t) => t?.text || t).filter(Boolean)
      : [],
  };
}

async function main() {
  const state = await getPreloadState();
  const { tkn, siteId, username, name, profileImage, description } = siteInfo(state);

  log(`user    : @${username}`);
  log(`site_id : ${siteId}`);
  log(`token   : ${tkn ? `present (${tkn.length} chars)` : "MISSING — extraction will fail"}`);

  if (!tkn) throw new Error("No bearer token found in preload state.");

  const photos = [];
  for await (const media of fetchMedia(siteId, tkn)) {
    const photo = normalize(media);
    if (photo) photos.push(photo);
  }

  log(`found ${photos.length} photos`);

  if (probeOnly) {
    const sample = photos[0];
    log("probe only — no files written.");
    if (sample) {
      log(`sample  : ${sample.full}`);
      log(`caption : ${JSON.stringify(sample.caption.slice(0, 80))}`);
      log(`size    : ${sample.width}x${sample.height}`);
    }
    return;
  }

  const payload = {
    user: username,
    profile: {
      name,
      image: profileImage.replace(/w=\d+/, "w=600"),
      description,
    },
    syncedAt: new Date().toISOString(),
    total: photos.length,
    photos,
  };

  await writeFile(OUT_URL, JSON.stringify(payload, null, 2) + "\n", "utf8");
  log(`wrote ${photos.length} photos -> ${OUT_URL.pathname}`);
}

main().catch((e) => {
  console.error(`[vsco] ERROR: ${e.message}`);
  process.exitCode = 1;
});
