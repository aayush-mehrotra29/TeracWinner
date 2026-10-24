import { createHash } from "node:crypto";
import { CONTACT_EMAIL } from "./config";
import { emailStartDate, gmailClient, GMAIL_HOST, parseGmailMessage, pendingUids } from "./gmail";
import { store } from "./store";

/** Mirrors the actual Gmail Sent folder into the local OritApp email ledger. */
export async function syncSentMail(): Promise<{ busy: boolean; processed: number; pending: boolean }> {
  const db = store();
  const owner = await db.claim(`gmail-sent:${CONTACT_EMAIL}`, 180);
  if (!owner) return { busy: true, processed: 0, pending: true };
  const client = gmailClient();
  const since = emailStartDate();
  const started = Date.now();
  const deadline = setTimeout(() => client.close(), 85_000);
  try {
    await client.connect();
    const folders = await client.list();
    const path = folders.find((folder) => folder.specialUse === "\\Sent")?.path ?? "[Gmail]/Sent Mail";
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("Gmail Sent folder unavailable");
      const key = `sent:${createHash("sha256").update(JSON.stringify([
        GMAIL_HOST, CONTACT_EMAIL, path, String(mailbox.uidValidity), since.toISOString(),
      ])).digest("hex")}`;
      const lastUid = await db.checkpoint(key);
      const highest = mailbox.uidNext - 1;
      if (highest <= lastUid || mailbox.exists === 0) return { busy: false, processed: 0, pending: false };
      const found = await client.search({ since, uid: `${lastUid + 1}:${highest}` }, { uid: true });
      if (!found) throw new Error("Gmail Sent search did not complete");
      const ids = pendingUids(found, lastUid, highest);
      if (!ids.length) {
        await db.advance(key, highest);
        return { busy: false, processed: 0, pending: false };
      }
      const messages = await client.fetchAll(ids, {
        uid: true, emailId: true, size: true, envelope: true, internalDate: true,
      }, { uid: true });
      if (messages.length !== ids.length) throw new Error("A Gmail Sent message moved during scan; retrying.");
      let processed = 0;
      let scanned = 0;
      for (const message of messages.sort((left, right) => left.uid - right.uid)) {
        if (Date.now() - started > 55_000) break;
        if (!message.internalDate) throw new Error("Sent message missing timestamp");
        const messageKey = message.emailId
          ? `gmail-sent:${CONTACT_EMAIL}:${message.emailId}` : `gmail-sent:${key}:${message.uid}`;
        const { data: existing, error: existsError } = await db.client.from("outreach_sent_messages")
          .select("message_key").eq("message_key", messageKey).maybeSingle();
        if (existsError) throw existsError;
        if (!existing) {
          const recipient = (message.envelope?.to ?? []).map((address) => address.address)
            .filter(Boolean).join(", ").slice(0, 500) || "Unknown recipient";
          const base = {
            key: messageKey, sender: CONTACT_EMAIL,
            subject: message.envelope?.subject || "(No subject)",
            receivedAt: new Date(message.internalDate).toISOString(),
          };
          let bodyText: string | null = null;
          let attachmentNames: string[] = [];
          let bodyIncomplete = Boolean((message.size ?? 0) > 256_000);
          if (!bodyIncomplete) {
            const raw = await client.fetchOne(String(message.uid), { source: { maxLength: 256_001 } }, { uid: true });
            if (!raw || !raw.source) throw new Error("Sent message disappeared; retrying.");
            if (raw.source.byteLength > 256_000) {
              bodyIncomplete = true;
            } else {
              const parsed = await parseGmailMessage(raw.source, base);
              bodyText = parsed.text.slice(0, 20_000);
              bodyIncomplete = parsed.text.length > 20_000;
              attachmentNames = parsed.attachmentNames;
            }
          }
          const { error } = await db.client.from("outreach_sent_messages").upsert({
            message_key: messageKey, recipient, subject: base.subject.slice(0, 500),
            sent_at: base.receivedAt, body_text: bodyText, body_incomplete: bodyIncomplete,
            attachment_names: attachmentNames,
          }, { onConflict: "message_key", ignoreDuplicates: true });
          if (error) throw error;
          processed += 1;
        }
        await db.advance(key, message.uid);
        scanned += 1;
      }
      return { busy: false, processed, pending: found.length > scanned };
    } finally { lock.release(); }
  } finally {
    clearTimeout(deadline);
    client.close();
    await db.release(`gmail-sent:${CONTACT_EMAIL}`, owner);
  }
}
