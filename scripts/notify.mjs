#!/usr/bin/env node
/**
 * Emails subscribers when the gallery gains new photos.
 *
 * Runs on the same box as scripts/sync.mjs (the daily systemd timer) and is
 * chained after it, so this needs no server of its own.
 *
 * How it avoids re-sending old photos:
 *   src/data/photos.json  ->  new photos
 *   data/notify-state.json ->  ids already announced
 * The state file is the only thing standing between subscribers and 140
 * backfill emails, so it is written only after Resend accepts the broadcast.
 *
 * Requires (env):
 *   SUPABASE_URL              https://naileoezbanniagzphwz.supabase.co
 *   SUPABASE_SECRET_KEY       sb_secret_... — bypasses RLS to read the list
 *   RESEND_API_KEY            re_... — must be FULL ACCESS, not send-only, since
 *                             it also reads and writes segment contacts
 *   RESEND_SEGMENT_ID         target segment for broadcasts
 *   NOTIFY_FROM               "SockYeh's Gallery <gallery@sockyeh.dev>"
 *
 * Optional:
 *   SITE_URL                default https://gallery.sockyeh.dev
 *   NOTIFY_DRY_RUN          1 = print the email, send nothing
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PHOTOS = join(ROOT, "src", "data", "photos.json");
const STATE = join(ROOT, "data", "notify-state.json");

// Astro loads .env for the build, but this is plain node. The built-in loader
// never overrides vars systemd already set, and is fine with no file.
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

const SITE_URL = (process.env.SITE_URL || "https://gallery.sockyeh.dev").replace(
  /\/$/,
  "",
);
const DRY_RUN = process.env.NOTIFY_DRY_RUN === "1";
const MAX_PHOTOS = 12;

const env = {
  supabaseUrl: process.env.SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  resendKey: process.env.RESEND_API_KEY,
  segmentId: process.env.RESEND_SEGMENT_ID,
  from: process.env.NOTIFY_FROM,
};

function log(...args) {
  console.log("[notify]", ...args);
}

function missingKeys() {
  return Object.entries(env)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

async function getSubscribers() {
  const url = `${env.supabaseUrl}/rest/v1/subscribers?select=email&unsubscribed_at=is.null&order=created_at`;
  const res = await fetch(url, {
    headers: {
      // Supabase secret keys are not JWTs, so they go on `apikey` only.
      apikey: env.secretKey,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase list failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()).map((r) => r.email);
}

/**
 * Resend rejects requests that carry no User-Agent (their error 1010), so every
 * call goes through here rather than using fetch bare.
 */
function resendFetch(path, init = {}) {
  return fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.resendKey}`,
      "User-Agent": "photoportfolio-notify/1.0",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
}

/**
 * Paginated Resend contact listing, keyed by lowercased email. Used for both
 * `/contacts` (account-wide) and `/segments/:id/contacts`. Limit 100 is Resend's
 * maximum page size.
 */
async function listResendContacts(basePath) {
  const byEmail = new Map();
  let after = null;

  for (let page = 0; page < 100; page++) {
    const path = `${basePath}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const res = await resendFetch(path);
    if (!res.ok) {
      throw new Error(
        `Resend contacts (${basePath}) failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    for (const c of body.data || []) {
      if (c.email) byEmail.set(c.email.toLowerCase(), c);
    }
    if (!body.has_more || !body.data?.length) break;
    after = body.data[body.data.length - 1].id;
  }

  return byEmail;
}

/**
 * Supabase is the signup source of truth, but a broadcast only reaches contacts
 * that exist in the Resend segment — so the two have to be reconciled. This only
 * ever ADDS contacts and never touches ones already there.
 *
 * Two independent reasons to leave someone alone:
 *   1. already in the segment (never mutate, so an unsubscribe is not undone)
 *   2. unsubscribed anywhere in the account — Resend may or may not keep
 *      opt-outs listed in a segment, so checking `/contacts` means a re-add can
 *      never silently re-subscribe somebody.
 *
 * Pass `{ dry: true }` to report what would change without writing.
 */
async function syncSegment(emails, { dry = false } = {}) {
  const inSegment = await listResendContacts(`/segments/${env.segmentId}/contacts`);
  const account = await listResendContacts("/contacts");

  const optedOut = new Set(
    [...account.entries()].filter(([, c]) => c.unsubscribed).map(([e]) => e),
  );

  const missing = emails.filter(
    (e) => !inSegment.has(e.toLowerCase()) && !optedOut.has(e.toLowerCase()),
  );

  log(
    `segment has ${inSegment.size} contact(s), ${optedOut.size} opted out account-wide; ` +
      `${missing.length} to add`,
  );

  if (dry) return missing.length;

  for (const email of missing) {
    const res = await resendFetch("/contacts", {
      method: "POST",
      body: JSON.stringify({
        email,
        unsubscribed: false,
        segments: [{ id: env.segmentId }],
      }),
    });

    // 409 = they already exist (perhaps outside this segment). Safe to ignore.
    if (res.ok || res.status === 409) continue;
    throw new Error(
      `Resend add contact failed for segment ${env.segmentId}: HTTP ${res.status} ${await res.text()}`,
    );
  }

  return missing.length;
}

/**
 * Newest-first photos whose ids are not in the state file's `sent` list.
 */
async function findNewPhotos() {
  const data = JSON.parse(await readFile(PHOTOS, "utf8"));
  const photos = [...data.photos].sort((a, b) => (b.date || 0) - (a.date || 0));

  let sent = [];
  try {
    ({ sent = [] } = JSON.parse(await readFile(STATE, "utf8")));
  } catch {
    // No state yet. On the very first run this means every existing photo looks
    // new, which would be a 140-photo blast to the list — so seed instead.
    return { seeded: photos.map((p) => p.id), newPhotos: [] };
  }

  const sentSet = new Set(sent);
  const newPhotos = photos.filter((p) => !sentSet.has(p.id)).slice(0, MAX_PHOTOS);
  return { seeded: null, newPhotos };
}

async function saveState(sent) {
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify({ sent }, null, 2) + "\n", "utf8");
}

function buildHtml(newPhotos) {
  const tiles = newPhotos
    .map(
      (p) => `      <img src="${p.full}" alt="${(p.caption || "photo").replace(
        /"/g,
        "&quot;",
      )}" width="${p.width || ""}" style="max-width:100%;height:auto;display:block;margin:0 0 16px;border-radius:4px;" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#191919;color:#f2f2f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;">
      <p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin:0 0 8px;">New work</p>
      <h1 style="font-size:20px;letter-spacing:0.02em;margin:0 0 20px;">
        ${newPhotos.length === 1 ? "A new photo" : `${newPhotos.length} new photos`}
      </h1>
${tiles}
      <p style="font-size:12px;color:rgba(255,255,255,0.45);margin:28px 0 0;">
        <a href="${SITE_URL}" style="color:#f2f2f2;">View the gallery</a>
      </p>
    </div>
  </body>
</html>`;
}

async function main() {
  // Unconfigured is a normal, non-fatal state: the daily sync still runs and
  // the unit must not be marked failed just because the newsletter was never
  // set up. Throws below here mean something is actually wrong.
  const missing = missingKeys();
  if (missing.length) {
    log(`not configured (${missing.join(", ")}) — skipping newsletter`);
    return;
  }

  const { seeded, newPhotos } = await findNewPhotos();

  if (seeded) {
    log(`first run — recording ${seeded.length} existing photos as already sent`);
    log("no email sent. New photos from here on will trigger a broadcast.");
    await saveState(seeded);
    return;
  }

  if (!newPhotos.length) {
    log("no new photos since last run — nothing to send");
    return;
  }

  const emails = await getSubscribers();
  log(`${newPhotos.length} new photo(s), ${emails.length} subscriber(s)`);

  if (!emails.length) {
    log("no active subscribers — recording photos without sending");
    await saveState([...newPhotos.map((p) => p.id), ...(await readState())]);
    return;
  }

  const subject =
    newPhotos.length === 1
      ? "A new photo"
      : `${newPhotos.length} new photos`;

  if (DRY_RUN) {
    log("dry run — not sending");
    log(`  from    : ${env.from}`);
    log(`  to      : segment ${env.segmentId} (${emails.length} subscriber(s))`);
    log(`  subject : ${subject}`);
    for (const p of newPhotos) log(`  + ${p.full}`);
    // Read-only: report what the segment sync would change without doing it.
    try {
      const n = await syncSegment(emails, { dry: true });
      log(`  sync    : would add ${n} contact(s) to the segment`);
    } catch (e) {
      log(`  sync    : skipped (${e.message})`);
    }
    return;
  }

  await syncSegment(emails);

  // Broadcasts (not emails/send) because Resend treats them as marketing sends:
  // no 100/day cap, and Resend handles suppression for bounced/complained
  // addresses so a bad address cannot poison the list.
  const res = await resendFetch("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      segment_id: env.segmentId,
      from: env.from,
      subject,
      html: buildHtml(newPhotos),
      // Resend appends its own unsubscribe link to broadcast recipients and
      // suppresses them from later sends automatically.
      text: `${subject}\n\n${newPhotos.map((p) => p.full).join("\n")}\n\nView the gallery: ${SITE_URL}`,
      send: true,
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(
      `Resend broadcast failed: HTTP ${res.status} ${JSON.stringify(payload)}`,
    );
  }

  // Only now is it safe to record these ids, so a failed send is retried tomorrow.
  const prior = await readState();
  await saveState([...newPhotos.map((p) => p.id), ...prior]);

  log(`sent broadcast ${payload.id} to segment ${env.segmentId}`);
}

async function readState() {
  try {
    const { sent = [] } = JSON.parse(await readFile(STATE, "utf8"));
    return sent;
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error(`[notify] ERROR: ${e.message}`);
  process.exitCode = 1;
});
