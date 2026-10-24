import { domainOf, type PublicPage } from "./public-web";

export function productLinks(page: PublicPage): string[] {
  const urls = new Set<string>();
  for (const match of page.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try { const url=new URL(match[1].replace(/&amp;/g,"&"),page.url); if (domainOf(url.href)===domainOf(page.url) && /\/products?\/[^/?#]+/i.test(url.pathname)) {url.search="";url.hash="";urls.add(url.href);} } catch {}
  }
  return [...urls].slice(0,2);
}
function productOffer(value: unknown, depth=0): boolean {
  if (depth>8 || !value || typeof value!=="object") return false;
  if (Array.isArray(value)) return value.slice(0,100).some(item=>productOffer(item,depth+1));
  const object=value as Record<string,unknown>;
  const types=Array.isArray(object["@type"])?object["@type"]:[object["@type"]];
  if (types.some(type=>typeof type==="string" && /(?:^|\/)Product$/.test(type)) && object.offers) {
    const offers=Array.isArray(object.offers)?object.offers:[object.offers];
    return offers.some(offer=>{ if(!offer||typeof offer!=="object")return false;const data=offer as Record<string,unknown>;return Number(data.price)>0 || Number(data.lowPrice)>0; });
  }
  return Object.values(object).slice(0,100).some(item=>productOffer(item,depth+1));
}
function activePurchaseControl(page: PublicPage): string | null {
  const html=page.html.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for(const match of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>|<input\b([^>]*)>/gi)) {
    const attributes=match[2] || match[4] || "";
    if(/\bdisabled\b|aria-disabled\s*=\s*["']true|type\s*=\s*["']hidden/i.test(attributes))continue;
    const text=(match[3] || attributes.match(/value=["']([^"']+)/i)?.[1] || "").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
    const buy=text.match(/\b(add to (?:cart|bag|basket)|buy (?:it )?now|purchase now)\b/i)?.[0];
    if(!buy)continue;
    if(match[1]?.toLowerCase()==="a") {
      const href=attributes.match(/href=["']([^"']+)/i)?.[1];
      if(!href)continue;
      try{const url=new URL(href,page.url);if(domainOf(url.href)!==domainOf(page.url)||!/(cart|checkout|add-to-cart)/i.test(url.href))continue;}catch{continue;}
    }
    return buy;
  }
  return null;
}
export function commerceEvidence(page: PublicPage): string | null {
  const buy=activePurchaseControl(page);
  if(!buy)return null;
  const price=[...page.text.matchAll(/(?:\$|USD\s*)\s*(\d[\d,.]*)/gi)].find(match=>Number(match[1].replace(/,/g,""))>0)?.[0];
  for(const match of page.html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try{if(productOffer(JSON.parse(match[1])))return `Product structured data with a priced offer and ${buy}`;}catch{}
  }
  if(price)return `Purchase control: ${buy}; positive price displayed: ${price}`;
  return null;
}
