import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IncomingEmail, Intake } from "./intake";

import type { Lead, NewLead, IntakeRow } from "./types";
export type { Lead, NewLead, IntakeRow } from "./types";

export class OutreachStore {
  readonly db: DatabaseSync;
  constructor(path = process.env.OUTREACH_DB_PATH || resolve(process.cwd(), ".outreach/orit.sqlite")) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_state (key TEXT PRIMARY KEY, last_uid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intakes (message_key TEXT PRIMARY KEY, sender TEXT NOT NULL, subject TEXT NOT NULL, received_at TEXT NOT NULL, analysis TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, domain TEXT NOT NULL UNIQUE, business TEXT NOT NULL, website TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, contact_source TEXT NOT NULL, fact TEXT NOT NULL, fact_quote TEXT NOT NULL, country_evidence TEXT NOT NULL, sources TEXT NOT NULL, verified_at TEXT NOT NULL, ecommerce_verified INTEGER NOT NULL DEFAULT 0, product_url TEXT, ecommerce_evidence TEXT, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','draft','sending','sent','replied','suppressed','uncertain')), subject TEXT, body TEXT, message_id TEXT UNIQUE, sent_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS suppressions (email TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  claim(key: string, seconds = 180): string | null {
    const owner = randomUUID();
    const row = this.db.prepare("INSERT INTO locks VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE locks.expires < ? RETURNING owner").get(key, owner, Date.now() + seconds * 1000, Date.now());
    return row ? owner : null;
  }
  release(key: string, owner: string) { this.db.prepare("DELETE FROM locks WHERE key=? AND owner=?").run(key, owner); }
  exists(key: string) { return Boolean(this.db.prepare("SELECT 1 FROM intakes WHERE message_key=?").get(key)); }
  saveIntake(email: IncomingEmail, intake: Intake) {
    this.db.prepare("INSERT OR IGNORE INTO intakes(message_key,sender,subject,received_at,analysis) VALUES(?,?,?,?,?)").run(email.key, email.sender.slice(0, 500), email.subject.slice(0, 500), email.receivedAt, JSON.stringify(intake));
  }
  intakes(): IntakeRow[] { return this.db.prepare("SELECT * FROM intakes ORDER BY created_at DESC LIMIT 50").all() as IntakeRow[]; }
  checkpoint(key: string) { return Number(this.db.prepare("SELECT last_uid FROM mail_state WHERE key=?").get(key)?.last_uid || 0); }
  advance(key: string, uid: number) { this.db.prepare("INSERT INTO mail_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET last_uid=MAX(mail_state.last_uid,excluded.last_uid)").run(key, uid); }
  setting(key: string) { return this.db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value as string | undefined; }
  setSetting(key: string, value: string) { this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  isSuppressed(email: string) { return Boolean(this.db.prepare("SELECT 1 FROM suppressions WHERE email=?").get(email)); }
  suppress(email: string, reason: string) {
    this.db.prepare("INSERT OR IGNORE INTO suppressions VALUES(?,?,?)").run(email.toLowerCase(), reason, new Date().toISOString());
    this.db.prepare("UPDATE leads SET status='suppressed' WHERE email=? AND status NOT IN ('sent','replied','uncertain')").run(email);
  }
  recordReply(email: string) {
    this.db.prepare("UPDATE leads SET status='replied' WHERE email=? AND status IN ('sent','sending','uncertain','draft','queued')").run(email);
    this.suppress(email, "Inbound message; stop automated outreach");
  }
  addLead(lead: NewLead) {
    if (this.isSuppressed(lead.email)) return false;
    const result = this.db.prepare("INSERT OR IGNORE INTO leads(domain,business,website,email,contact_source,fact,fact_quote,country_evidence,sources,verified_at,ecommerce_verified,product_url,ecommerce_evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(lead.domain, lead.business, lead.website, lead.email.toLowerCase(), lead.contact_source, lead.fact, lead.fact_quote, lead.country_evidence, lead.sources, lead.verified_at, lead.ecommerce_verified ? 1 : 0, lead.product_url || null, lead.ecommerce_evidence || null);
    return result.changes === 1;
  }
  leads(status?: string): Lead[] {
    return (status ? this.db.prepare("SELECT * FROM leads WHERE status=? ORDER BY id LIMIT 50").all(status) : this.db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 50").all()) as unknown as Lead[];
  }
  domains(): string[] { return this.db.prepare("SELECT domain FROM leads ORDER BY id DESC LIMIT 200").all().map(row => String(row.domain)); }
  draft(id: number, subject: string, body: string) { this.db.prepare("UPDATE leads SET subject=?,body=?,status='draft' WHERE id=? AND status='queued'").run(subject, body, id); }
  reserve(id: number, messageId: string, dailyLimit: number, spacingMs: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const count = Number(this.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE sent_at>=?").get(since)?.n);
      const latest = this.db.prepare("SELECT MAX(sent_at) AS t FROM leads").get()?.t as string | null;
      const uncertain = this.db.prepare("SELECT 1 FROM leads WHERE status IN ('sending','uncertain') LIMIT 1").get();
      if (count >= dailyLimit || uncertain || (latest && Date.now() - Date.parse(latest) < spacingMs)) { this.db.exec("ROLLBACK"); return false; }
      const changed = this.db.prepare("UPDATE leads SET status='sending',message_id=?,sent_at=? WHERE id=? AND status='draft' AND NOT EXISTS(SELECT 1 FROM suppressions WHERE suppressions.email=leads.email)").run(messageId, new Date().toISOString(), id).changes;
      this.db.exec("COMMIT"); return changed === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finish(id: number, status: "sent" | "uncertain") {
    this.db.prepare("UPDATE leads SET status=?,error=? WHERE id=? AND status='sending'").run(status, status === "uncertain" ? "Delivery uncertain. Check Gmail Sent before resolving; automatic sending paused." : null, id);
  }
  summary() { return this.db.prepare("SELECT status, COUNT(*) AS count FROM leads GROUP BY status").all(); }
}
let cached: OutreachStore | undefined;
export function store() { return cached ??= new OutreachStore(); }
