/**
 * RSS feed for the gallery, generated at build time from src/data/photos.json.
 *
 * No backend: `npm run build` writes a static /rss.xml. Because it is a real
 * feed, any reader works too — plus Resend's marketing sends and Supabase, which
 * is why the email side never has to parse RSS.
 */
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import rawData from "../data/photos.json";
import type { PhotosData } from "../lib/types";

const data = rawData as PhotosData;

// Newest first, and only recent items — an RSS feed of 140 full-size CDN URLs is
// both slow to download and mostly noise for a reader.
const ITEMS = 30;

export async function GET(context: APIContext) {
  const photos = [...data.photos]
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, ITEMS);

  const title = `${data.profile?.name || data.user} — photography`;

  return rss({
    title,
    description: data.profile?.description || "Recent photos",
    site: context.site ?? "https://gallery.sockyeh.dev",
    trailingSlash: false,
    items: photos.map((p) => ({
      title: p.caption || `Photo ${new Date(p.date || Date.now()).toISOString().slice(0, 10)}`,
      description: p.caption || undefined,
      pubDate: p.date ? new Date(p.date) : new Date(),
      // The feed links to the photo itself; readers land on the gallery for context.
      link: p.full,
      categories: p.tags,
    })),
    customData: `<language>en-us</language>`,
  });
}
