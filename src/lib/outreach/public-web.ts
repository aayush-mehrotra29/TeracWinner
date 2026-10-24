import { lookup } from "node:dns/promises";
import { pinnedHttps } from "./pinned-http";
import { isIP } from "node:net";
import { getDomain } from "tldts";
import { convert } from "html-to-text";

export function publicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function publicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(url.hostname) || !getDomain(url.hostname) || /\.(local|internal|localhost|test|example|invalid)$/i.test(url.hostname)) throw new Error("Not a public HTTPS business URL");
  url.hash = ""; return url;
}
export function domainOf(value: string) { return getDomain(publicUrl(value).hostname)!; }
export type PublicPage = { url: string; html: string; text: string };
export async function fetchPublicPage(value: string, expectedDomain = domainOf(value), redirects = 0): Promise<PublicPage> {
  const url = publicUrl(value);
  if (domainOf(value) !== expectedDomain || redirects > 3) throw new Error("Business page redirected outside its website");
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error("Website resolved to a non-public address");
  const ip = addresses[0].address;
  const response = await pinnedHttps(url,ip);
  if (response.status >= 300 && response.status < 400 && response.location) return fetchPublicPage(new URL(response.location, url).href, expectedDomain, redirects + 1);
  if (response.status !== 200 || !response.type.includes("text/html")) throw new Error("Website page unavailable");
  const visibleHtml=response.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const text = convert(visibleHtml, { wordwrap: false, selectors: [{ selector: "script", format: "skip" }, { selector: "style", format: "skip" }, { selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }] }).slice(0, 22000);
  return { url: url.href, html: response.html, text };
}
export function contactLinks(page: PublicPage): string[] {
  const urls = new Set<string>();
  for (const match of page.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try { const url = new URL(match[1].replace(/&amp;/g, "&"), page.url); if (domainOf(url.href) === domainOf(page.url) && /contact|about/i.test(url.pathname) && !url.search) urls.add(url.href); } catch { /* Ignore non-website links. */ }
  }
  return [...urls].slice(0, 3);
}
export function publishedEmails(page: PublicPage): string[] {
  const visible = page.text + "\n" + [...page.html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)[^"']*["']/gi)].map(m => m[1]).join("\n");
  return [...new Set((visible.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(s => s.toLowerCase()))]
    .filter(email => !/^(noreply|no-reply|privacy|legal|abuse|press|media|careers|jobs)@/.test(email) && !/\.(png|jpg|webp)$/i.test(email))
    .sort((a,b) => Number(!/^(hello|info|contact|team|support|help)@/.test(a)) - Number(!/^(hello|info|contact|team|support|help)@/.test(b)));
}
