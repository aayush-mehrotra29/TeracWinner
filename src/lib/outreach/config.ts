let runtimeConfig: Record<string,string> = {};
export function setRuntimeConfig(values: Record<string,string>) { runtimeConfig={...values}; }
export function env(name: string) { return runtimeConfig[name] ?? process.env[name]; }
export function required(name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export const CONTACT_EMAIL = "oritsoftware@gmail.com";
export const WEBSITE_URL = "https://orit.dev/";
