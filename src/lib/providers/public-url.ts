import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value.includes(":")) {
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice("::ffff:".length);
      return isIP(mapped) === 4 ? privateAddress(mapped) : true;
    }
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
}

export async function validatePublicHttpsUrl(raw: string): Promise<string> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("Only public HTTPS URLs without credentials or custom ports are allowed");
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[/, "").replace(/\]$/, ""))) throw new Error("Direct IP-address URLs are not allowed");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private hostnames are not allowed");
  }
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((record) => privateAddress(record.address))) {
    throw new Error("Private network addresses are not allowed");
  }
  url.hash = "";
  return url.toString();
}
