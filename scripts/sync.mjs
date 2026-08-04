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
 * Why curl: VSCO is behind Cloudflare, which blocks Node's built-in fetch by TLS
 * fingerprint even from residential IPs (HTTP 403). The system curl (curl.exe on
 * Windows, curl on Ubuntu/Linux) passes. If curl is unavailable, install it or
 * set CURL_BIN.
 *
 * Usage:
 *   npm run sync              # fetch everything and write src/data/photos.json
 *   npm run probe             # diagnostics only; prints what would be fetched
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const probeOnly = process.argv.includes("--probe");
const USER = (process.env.VSCO_USER || "sockyeh").toLowerCase();
const ROOT = "https://vsco.co";
const OUT_URL = new URL("../src/data/photos.json", import.meta.url);
const CURL = process.env.CURL_BIN || (process.platform === "win32" ? "curl.exe" : "curl");

const LIMIT = "14";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 250;
const MAX_BUFFER = 64 * 1024 * 1024;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureScheme = (u) => (/^https?:\/\//.test(u) ? u : `https://${u}`);

function log(...args) {
  console.log("[vsco]", ...args);
}

/**
 * HTTP GET via curl. Returns { code, body } where `code` is the HTTP status
 * and `body` is the raw response text (empty on hard failures).
 */
async function curl(url, { accept, headers = {} } = {}) {
  const args = [
    "-sSL",
    "--compressed",
    "--max-time",
    "60",
    "-A",
    HEADERS["User-Agent"],
    "-H",
    `Accept: ${accept}`,
    "-H",
    `Accept-Language: ${HEADERS["Accept-Language"]}`,
    "-H",
    "Cache-Control: no-cache",
    "-H",
    "Pragma: no-cache",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", "\n%{http_code}", url);

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
    throw new Error(`curl failed for ${url}: ${e.message}`);
  }

  const nl = stdout.lastIndexOf("\n");
  const body = nl === -1 ? "" : stdout.slice(0, nl);
  const code = Number((nl === -1 ? stdout : stdout.slice(nl + 1)).trim());
  return { code, body };
}

const htmlAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const jsonAccept = "application/json, text/plain, */*";

/**
 * Fetch the gallery page and parse the __PRELOADED_STATE__ JSON out of the HTML.
 */
async function getPreloadState() {
  const url = `${ROOT}/${USER}/gallery`;
  log(`GET ${url}`);
  const { code, body } = await curl(url, { accept: htmlAccept });
  if (code !== 200) {
    if (code === 403) {
      throw new Error(
        `GET ${url} -> HTTP 403. Cloudflare blocked this request. ` +
          `Try again (VSCO may be throttling), or check that curl isn't being ` +
          `intercepted by a proxy/VPN.`,
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
