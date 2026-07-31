/**
 * Image proxy + cache for gallery.sockyeh.dev/img/*.
 *
 * Rewrites a request for /img/<path> to https://img.vsco.co/<path>, fetches it
 * from Cloudflare's edge (Cloudflare->Cloudflare requests bypass the bot checks
 * that block residential/VPS clients), and caches the result so visitors never
 * hit VSCO's CDN directly and images load from the nearest CF PoP.
 */

const UPSTREAM = "https://img.vsco.co";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const prefix = "/img/";

    if (!url.pathname.startsWith(prefix)) {
      return new Response("Not Found", { status: 404 });
    }

    const key = url.pathname.slice(prefix.length);
    if (!key) {
      return new Response("Bad Request", { status: 400 });
    }

    const upstream = `${UPSTREAM}/${key}`;
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const upstreamRes = await fetch(upstream, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      cf: {
        cacheEverything: true,
        cacheTtl: CACHE_TTL_SECONDS,
      },
    });

    if (!upstreamRes.ok) {
      return new Response(`Upstream error: ${upstreamRes.status}`, {
        status: 502,
      });
    }

    const res = new Response(upstreamRes.body, upstreamRes);
    res.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, immutable`);
    await cache.put(cacheKey, res.clone());
    return res;
  },
};
