import { parsePaidBrief } from "./paid-brief";
import { CONTACT_EMAIL } from "./config";
import { analyzeEmail, type IncomingEmail, type Intake } from "./intake";
import { store } from "./store";
import { isOptOut } from "./campaign";
import { emailStartDate, gmailClient, gmailMailboxKey, gmailMessageKey, GMAIL_FOLDER, parseGmailMessage, pendingUids } from "./gmail";
export type IntakeRepository = { exists: (key: string) => Promise<boolean>; save: (email: IncomingEmail, intake: Intake) => Promise<void> };
export async function processEmail(email: IncomingEmail, repository: IntakeRepository, analyze = analyzeEmail): Promise<boolean> {
  if (await repository.exists(email.key)) return false;
  const brief = parsePaidBrief(email.text);
  const intake: Intake = brief ? {
    category: "product_submission", summary: "Formatted paid brief; payment verification pending.",
    product_name: brief.name, product_description: brief.description, product_url: brief.url || null,
    target_audience: brief.audience, research_question: brief.question, order_reference: brief.paymentId,
    missing_information: [], next_action: "research_intake",
  } : await analyze(email);
  await repository.save(email, intake);
  return true;
}
export async function checkInbox() {
  const since = emailStartDate(); const client = gmailClient(); const db = store();
  const lockKey = `gmail:${CONTACT_EMAIL}`; const owner = await db.claim(lockKey, 180);
  if (!owner) return { busy: true, processed: 0, pending: true };
  await db.setSetting("inbox_pending","true");
  const started = Date.now(); const deadline = setTimeout(() => client.close(), 85000);
  const repository: IntakeRepository = { exists: async key => db.exists(key), save: async (email, intake) => db.saveIntake(email, intake) };
  try {
    await client.connect();
    const lock = await client.getMailboxLock(GMAIL_FOLDER, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("Gmail Inbox unavailable");
      const key = gmailMailboxKey(String(mailbox.uidValidity), since); const lastUid = await db.checkpoint(key);
      const highest = mailbox.uidNext - 1;
      if (highest <= lastUid || mailbox.exists === 0) return { busy: false, processed: 0, pending: false };
      const found = await client.search({ since, uid: `${lastUid + 1}:${highest}` }, { uid: true });
      if (!found) throw new Error("Gmail search did not complete");
      const ids = pendingUids(found, lastUid, highest);
      if (!ids.length) return { busy: false, processed: 0, pending: false };
      const messages = await client.fetchAll(ids, { uid: true, emailId: true, size: true, envelope: true, internalDate: true }, { uid: true });
      let processed = 0; let scanned = 0;
      for (const message of messages.sort((a, b) => a.uid - b.uid)) {
        if (Date.now() - started > 55000) break;
        const messageKey = gmailMessageKey(message.emailId, key, message.uid);
        if (!(await db.exists(messageKey))) {
          if (!message.internalDate) throw new Error("Message missing receipt timestamp");
          const base = { key: messageKey, sender: message.envelope?.from?.[0]?.address || "Unknown sender", subject: message.envelope?.subject || "(No subject)", receivedAt: new Date(message.internalDate).toISOString() };
          // Any inbound contact takes the address out of automated prospecting before a model runs.
          if (base.sender.includes("@") && base.sender.toLowerCase() !== CONTACT_EMAIL) await db.recordReply(base.sender);
          if ((message.size ?? 0) > 256000) {
            await db.saveIntake({ ...base, text: "", attachmentNames: [], incomplete: true }, manualIntake("Large email requires manual review in Gmail.")); processed++;
          } else {
            const raw = await client.fetchOne(String(message.uid), { source: { maxLength: 256001 } }, { uid: true });
            if (!raw || !raw.source) throw new Error("Message disappeared; retry inbox scan");
            const email = await parseGmailMessage(raw.source, base);
            for (const failed of email.failedRecipients || []) await db.suppress(failed, "Delivery failure reported by Gmail");
            if (isOptOut(email.subject, email.text)) {
              await db.suppress(email.sender, "Opt-out received"); await db.saveIntake(email, { ...manualIntake("Opt-out received; future outreach suppressed."), next_action: "no_action" }); processed++;
            } else if (email.sender.toLowerCase() === CONTACT_EMAIL || email.automatic) {
              await db.saveIntake(email, { ...manualIntake("Automated or self-sent message; no reply sent."), next_action: "no_action" }); processed++;
            } else if (await processEmail(email, repository)) processed++;
          }
        }
        await db.advance(key, message.uid); scanned++;
      }
      return { busy: false, processed, pending: found.length > scanned };
    } finally { lock.release(); }
  } finally { clearTimeout(deadline); client.close(); await db.release(lockKey, owner); }
}
function manualIntake(summary: string): Intake {
  return { category: "other", summary, product_name: null, product_description: null, product_url: null, target_audience: null, research_question: null, order_reference: null, missing_information: [], next_action: "human_review" };
}
