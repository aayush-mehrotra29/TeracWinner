import { IntegrationBlockedError, ProviderError } from "../providers/errors";
import { TallyMcp, type TallyQuestion, type TallySubmissionPage } from "../providers/tally";
import { ResearchStore } from "./store";
import type { RunRow } from "./types";

const IMAGE_LINK_SECONDS = 30 * 24 * 60 * 60;
const TERAC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TallyStudyMaterials {
  title: string;
  description: string;
  audience: string;
  geography: string;
  concepts: string[];
  questions: TallyQuestion[];
  assetIds: string[];
  taskUrl: string;
  taskDescription: string;
  panelDescription: string;
  businessType: "b2b" | "b2c";
  screeningQuestions: Array<{ key: string; text: string; pick: string; answers: Array<{ text: string; qualify_logic: string }> }>;
  tallyFormId?: string;
  tallyUrl?: string;
  tallyHiddenSubmissionFieldId?: string;
  imageUrls?: string[];
  imageExpiresAt?: string;
  formBuilt?: boolean;
}

export interface TallyStudy {
  id: string;
  run_id: string;
  owner_id: string;
  status: string;
  target_count: number;
  quote: unknown;
  materials: TallyStudyMaterials;
  provider_id: string | null;
  response_token_hash: string | null;
  approved_fingerprint: string | null;
  approval_at: string | null;
  launched_at: string | null;
}

export function productSurveyQuestions(concepts: string[], hasImages: boolean): TallyQuestion[] {
  const two = concepts.length > 1;
  return [
    { id: "current", prompt: "How do you handle this need today? Give a recent example.", type: "text" },
    { id: "reaction", prompt: "What is your first reaction to the product concept shown?", type: "text" },
    ...(hasImages ? [{ id: "image_reaction", prompt: "What do the product images communicate to you, and what remains unclear?", type: "text" as const }] : []),
    { id: "use_intent", prompt: "Would you use this product if it were available?", type: "choice", options: ["Yes", "Maybe", "No", "I need more information"] },
    { id: "use_reason", prompt: "Why did you choose that answer?", type: "text" },
    { id: "benefit", prompt: "What, if anything, seems better than your current option?", type: "text" },
    { id: "concern", prompt: "What would stop you from trying or choosing it?", type: "text" },
    { id: "price", prompt: "What price would feel reasonable, and what would you expect at that price?", type: "text" },
    { id: "change", prompt: "What one change would most improve your view of the product?", type: "text" },
    { id: "choice", prompt: two ? "Which would you choose now?" : "Would you choose this over what you use today?", type: "choice", options: two
      ? ["Concept A", "Concept B", "My current option", "Neither", "Not enough information"]
      : ["This product", "My current option", "Neither", "Not enough information"] },
    { id: "choice_reason", prompt: "What is the main reason for that choice?", type: "text" },
  ];
}

function plain(value: string, max = 1000): string {
  return value.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function wholeWords(value: string, max: number): string {
  const clean = plain(value, max + 1);
  if (clean.length <= max) return clean;
  const boundary = clean.slice(0, max + 1).lastIndexOf(" ");
  return clean.slice(0, boundary > max / 2 ? boundary : max).trimEnd();
}

/** A respondent sees the product description, not the research decision or instructions to the agent. */
function respondentConcept(idea: string): string {
  const clean = plain(idea, 1200);
  const questionEnd = clean.indexOf("?");
  const afterDecision = questionEnd >= 0 ? clean.slice(questionEnd + 1).trim() : "";
  const candidate = afterDecision.length >= 80 ? afterDecision : clean;
  const sentences = candidate.match(/[^.!?]+[.!?]?/g) ?? [candidate];
  const description = sentences.map((sentence) => sentence.trim()).filter((sentence) =>
    !/^(?:assess|evaluate|analy[sz]e|compare|recommend|determine|tell me|help me|note any|the attached image\b)/i.test(sentence),
  ).join(" ").trim();
  return plain(description.length >= 50 ? description : candidate, 1000);
}

function respondentTitle(idea: string, concepts: string[]): string {
  const launch = /^(?:should|could|would)\s+([\w&.'-]+)\s+(?:launch|introduce|sell|offer)\s+(?:the|a|an)\s+(.+?)(?=\s+(?:of|in|for)\s+|,|\?|$)/i.exec(idea);
  const product = launch && !/^(?:I|we)$/i.test(launch[1])
    ? `${launch[1]} ${launch[2]}` : concepts.length > 0 ? concepts[0] : respondentConcept(idea);
  return `Product feedback: ${wholeWords(product, 85) || "New product concept"}`;
}

export function makeStudyMaterials(run: RunRow): TallyStudyMaterials {
  const idea = plain(run.input.idea, 1200);
  const concepts = (run.input.concepts?.map((value) => plain(value, 1000)).filter(Boolean) ?? []).slice(0, 2);
  if (!concepts.length) concepts.push(respondentConcept(idea));
  const audience = plain(run.input.audience || "US adults who have considered products addressing this need", 200);
  const geography = plain(run.input.geography || "United States", 80);
  const title = respondentTitle(idea, run.input.concepts ?? []);
  const description = `Review ${concepts.length === 2 ? "two product concepts" : "a product concept"} and answer questions about current behavior, likely use, objections, and price.`;
  const businessType = /\b(company|team|manager|director|enterprise|business|procurement|b2b)\b/i.test(audience) ? "b2b" : "b2c";
  const assetIds = (run.input.assetIds ?? []).slice(0, 4);
  return {
    title, description, audience, geography, concepts,
    questions: productSurveyQuestions(concepts, assetIds.length > 0), assetIds,
    taskUrl: "", taskDescription: description,
    panelDescription: `${audience}; ${geography}; people with recent experience choosing or using relevant alternatives.`,
    businessType,
    screeningQuestions: [{
      key: "recent_relevance", text: "In the past 12 months, have you personally used or actively compared solutions relevant to this described need?", pick: "one",
      answers: [{ text: "Yes", qualify_logic: "must" }, { text: "No", qualify_logic: "reject" }],
    }],
  };
}

export function formTitleForRun(run: RunRow): string {
  return `Orit study ${run.id}: ${plain(run.input.idea, 75) || "Product feedback"}`.slice(0, 140);
}

export function tallyFormBlocks(run: RunRow, materials: TallyStudyMaterials, imageUrls: string[]): unknown[] {
  void run;
  const blocks: unknown[] = [
    { type: "HIDDEN_FIELDS", hiddenFields: [{ name: "teracSubmissionId" }, { name: "submissionId" }, { name: "taskId" }] },
    { type: "TEXT", html: "Please review the product concept and any images, then answer based on your own experience. There are no right answers." },
  ];
  materials.concepts.forEach((concept, index) => {
    blocks.push({ type: "TEXT", html: `${materials.concepts.length > 1 ? `Concept ${index === 0 ? "A" : "B"}: ` : "Product concept: "}${plain(concept, 1000)}` });
  });
  imageUrls.forEach((url, index) => blocks.push({
    type: "IMAGE", name: `Product image ${index + 1}`, url,
    altText: `Product concept image ${index + 1}`,
  }));
  blocks.push({ type: "TEXT", html: "Consider what you would actually do when choosing a product like this." });
  for (const question of materials.questions) {
    blocks.push({ type: "TITLE", html: question.prompt });
    if (question.type === "choice") {
      for (const option of question.options ?? []) blocks.push({ type: "MULTIPLE_CHOICE_OPTION", text: option });
    } else {
      blocks.push({ type: "TEXTAREA", placeholder: "Answer in your own words." });
    }
  }
  return blocks;
}

export function tallyHiddenFieldId(ledger: string, name = "teracSubmissionId"): string | null {
  const fields = ledger.split("\n").find((line) => line.includes("| HIDDEN_FIELDS |"));
  if (!fields) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`([a-f0-9-]{36})=${escaped}(?:,|\\s*\\|)`, "i").exec(fields)?.[1] ?? null;
}

async function signedImageUrls(store: ResearchStore, run: RunRow, assetIds: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const assetId of assetIds) {
    const { data: asset, error } = await store.db.from("assets").select("path,mime_type")
      .eq("id", assetId).eq("owner_id", run.owner_id).eq("project_id", run.project_id).maybeSingle();
    if (error || !asset || !String(asset.mime_type).startsWith("image/")) {
      throw new IntegrationBlockedError("An uploaded product image cannot be shared with Tally participants", "tally");
    }
    const signed = await store.db.storage.from("research-images").createSignedUrl(String(asset.path), IMAGE_LINK_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      throw new IntegrationBlockedError("A product image could not be signed for the Tally form", "tally");
    }
    urls.push(signed.data.signedUrl);
  }
  return urls;
}

async function readStudy(store: ResearchStore, runId: string): Promise<TallyStudy | null> {
  const { data, error } = await store.db.from("human_studies").select("*").eq("run_id", runId).maybeSingle();
  if (error) throw new Error(`Unable to read Tally study: ${error.message}`);
  return data as TallyStudy | null;
}

async function saveStudy(store: ResearchStore, study: TallyStudy, changes: Partial<TallyStudy>): Promise<TallyStudy> {
  store.assertLease();
  const { data, error } = await store.db.from("human_studies").update(changes).eq("id", study.id).select("*").single();
  if (error || !data) throw new Error(`Unable to save Tally study: ${error?.message ?? "missing"}`);
  return data as TallyStudy;
}

async function chooseWorkspace(tally: TallyMcp): Promise<string> {
  const workspaces = await tally.listWorkspaces();
  const configured = process.env.TALLY_WORKSPACE_ID;
  if (configured) {
    if (!workspaces.some((workspace) => workspace.id === configured)) throw new IntegrationBlockedError("TALLY_WORKSPACE_ID is not available to the Tally API key", "tally");
    return configured;
  }
  if (workspaces.length === 1) return workspaces[0].id;
  const personal = workspaces.filter((workspace) => workspace.name === "My workspace");
  if (personal.length === 1) return personal[0].id;
  throw new IntegrationBlockedError("Set TALLY_WORKSPACE_ID to select the Tally workspace for deep studies", "tally");
}

export function tallyFormMatchesMaterials(ledger: string, questions: TallyQuestion[], imageUrls: string[]): boolean {
  if (!ledger.includes("| HIDDEN_FIELDS |")) return false;
  if (!questions.every((question) => ledger.includes(`| ${question.prompt} |`))) return false;
  const imageRows = ledger.split("\n").filter((line) => line.includes("| IMAGE |"));
  const savedUrls = imageRows.flatMap((line) => [...line.matchAll(/"url":"([^"]+)"/g)].map((match) => match[1]));
  return savedUrls.length === imageUrls.length && imageUrls.every((url) => savedUrls.includes(url));
}

function imageLinksFresh(materials: TallyStudyMaterials): boolean {
  if (!materials.assetIds.length) return true;
  const expiresAt = Date.parse(materials.imageExpiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 24 * 60 * 60 * 1000;
}

function requireFreshPublishedImages(materials: TallyStudyMaterials): void {
  if (!imageLinksFresh(materials)) {
    throw new IntegrationBlockedError(
      "The Tally product image links are near expiry. Start a new deep run to issue fresh private image links before recruiting respondents.",
      "tally",
    );
  }
}

/** Resumable form creation. The deterministic title lets a retry find a form created before its ID was saved. */
export async function ensureDeepStudyForm(store: ResearchStore, run: RunRow, client?: TallyMcp): Promise<TallyStudy> {
  if (run.mode !== "deep_simulation") throw new Error("Tally study is only available for deep simulation runs");
  store.assertLease();
  let study = await readStudy(store, run.id);
  if (study?.materials?.tallyUrl && study.materials.tallyFormId) {
    requireFreshPublishedImages(study.materials);
    return study;
  }
  const tally = client ?? new TallyMcp();
  if (!client) await tally.connect();
  try {
    const materials = study?.materials ?? makeStudyMaterials(run);
    if (materials.formBuilt && !imageLinksFresh(materials)) requireFreshPublishedImages(materials);
    const imageUrls = materials.imageUrls?.length === materials.assetIds.length && imageLinksFresh(materials)
      ? materials.imageUrls : await signedImageUrls(store, run, materials.assetIds);
    if (!study) {
      const { data, error } = await store.db.from("human_studies").insert({
        run_id: run.id, owner_id: run.owner_id, status: "creating_form", target_count: 12,
        quote: null, materials, provider_id: null, response_token_hash: null,
      }).select("*").single();
      if (error || !data) {
        if (error?.code === "23505") study = await readStudy(store, run.id);
        if (!study) throw new Error(`Unable to create Tally study: ${error?.message ?? "unknown"}`);
      } else study = data as TallyStudy;
    }
    if (!study) throw new Error("Tally study could not be recovered");
    let current = study.materials;
    const workspaceId = await chooseWorkspace(tally);
    let formId = current.tallyFormId;
    if (!formId) {
      const matches = (await tally.listForms(workspaceId)).filter((form) => form.name?.includes(run.id));
      if (matches.length > 1) throw new IntegrationBlockedError("Multiple Tally forms match this deep run; reconcile them before retry", "tally");
      formId = matches[0]?.id ?? (await tally.createForm(formTitleForRun(run), workspaceId)).id;
      current = { ...current, tallyFormId: formId, imageUrls, imageExpiresAt: new Date(Date.now() + IMAGE_LINK_SECONDS * 1000).toISOString() };
      study = await saveStudy(store, study, { materials: current });
    }
    // The UUID stays in the initial remote title until the form ID is saved.
    // This lets a retry find a form created just before a worker crash while
    // keeping internal identifiers out of the respondent-facing published form.
    await tally.setFormTitle(formId, current.title);
    let ledger = (await tally.loadForm(formId)).ledger;
    if (!current.formBuilt) {
      if (!tallyFormMatchesMaterials(ledger, current.questions, imageUrls)) {
        if (/\| (?:TITLE|TEXTAREA|MULTIPLE_CHOICE_OPTION|IMAGE) \|/.test(ledger)) {
          throw new IntegrationBlockedError("Tally form was partially built or is missing a product image; inspect its saved blocks before retry", "tally");
        }
        ledger = await tally.createBlocks(formId, tallyFormBlocks(run, current, imageUrls));
      }
      if (!tallyFormMatchesMaterials(ledger, current.questions, imageUrls)) {
        throw new ProviderError("Tally form is missing required questions or product images", "tally");
      }
      const hiddenId = tallyHiddenFieldId(ledger);
      if (!hiddenId) throw new ProviderError("Tally form did not save the Terac submission field", "tally");
      current = { ...current, tallyHiddenSubmissionFieldId: hiddenId, formBuilt: true };
      study = await saveStudy(store, study, { materials: current });
    }
    const hiddenId = current.tallyHiddenSubmissionFieldId ?? tallyHiddenFieldId(ledger);
    if (!hiddenId) throw new ProviderError("Tally form has no Terac submission field", "tally");
    if (!tallyFormMatchesMaterials(ledger, current.questions, current.imageUrls ?? imageUrls)) {
      throw new IntegrationBlockedError("Tally form does not match the saved questions and product images", "tally");
    }
    await tally.setCompletionRedirect(formId, hiddenId);
    const tallyUrl = await tally.publishForm(formId);
    current = { ...current, tallyFormId: formId, tallyUrl, taskUrl: tallyUrl,
      taskDescription: `${current.description} Participants complete the questionnaire at ${tallyUrl}.` };
    study = await saveStudy(store, study, { status: "awaiting_response", materials: current });
    return study;
  } finally {
    if (!client) await tally.close();
  }
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 5000);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(", ").slice(0, 5000);
  return "";
}

export function completedTallyAnswers(page: TallySubmissionPage, materials: TallyStudyMaterials): Array<{
  tallySubmissionId: string; teracSubmissionId: string; responses: Record<string, string>; submittedAt: string;
}> {
  const fieldId = materials.tallyHiddenSubmissionFieldId;
  if (!fieldId) return [];
  const questionIds = new Map(materials.questions.flatMap((question) => {
    const matched = page.questions.find((item) => item.label === question.prompt);
    return matched ? [[matched.id, question.id] as const] : [];
  }));
  return page.submissions.flatMap((submission) => {
    if (!submission.isCompleted || !submission.id) return [];
    const hidden = submission.responses.find((response) => response.questionId === fieldId);
    const teracSubmissionId = answerText(hidden?.answer);
    if (!TERAC_ID.test(teracSubmissionId) || teracSubmissionId.startsWith("demo_")) return [];
    const responses: Record<string, string> = {};
    for (const response of submission.responses) {
      const questionId = questionIds.get(response.questionId);
      if (questionId) responses[questionId] = answerText(response.answer);
    }
    if (!responses.use_intent || !responses.choice) return [];
    return [{ tallySubmissionId: submission.id, teracSubmissionId, responses, submittedAt: submission.submittedAt }];
  });
}

export function allowlistedTallyAnswers(
  page: TallySubmissionPage, materials: TallyStudyMaterials, allowedTeracIds: ReadonlySet<string>,
): ReturnType<typeof completedTallyAnswers> {
  return completedTallyAnswers(page, materials)
    .filter((item) => allowedTeracIds.has(item.teracSubmissionId));
}

/** Imports completed Tally answers as unconfirmed. Terac reconciliation must confirm their hidden submission ID. */
export async function syncTallyResponses(
  store: ResearchStore, run: RunRow, study: TallyStudy,
  allowedTeracIds: ReadonlySet<string>, client?: TallyMcp,
): Promise<{ importedCount: number; candidateCount: number }> {
  const formId = study.materials.tallyFormId;
  if (!formId || !study.materials.tallyHiddenSubmissionFieldId) {
    throw new IntegrationBlockedError("Tally form is not ready for response collection", "tally");
  }
  const tally = client ?? new TallyMcp();
  if (!client) await tally.connect();
  let importedCount = 0;
  try {
    let pageNumber = 1;
    for (;;) {
      const page = await tally.fetchSubmissions(formId, pageNumber);
      // The form is public. A hidden query parameter by itself proves nothing:
      // only Terac's current same-opportunity submission list grants admission.
      for (const item of allowlistedTallyAnswers(page, study.materials, allowedTeracIds)) {
        store.assertLease();
        const { error } = await store.db.from("human_responses").insert({
          study_id: study.id, owner_id: run.owner_id, provider_submission_id: item.teracSubmissionId,
          provider_status: "unconfirmed", review_status: "pending",
          answers: { responses: item.responses, presentationOrder: study.materials.concepts,
            tallySubmissionId: item.tallySubmissionId, submittedAt: item.submittedAt, demoRun: false },
        });
        if (error && error.code !== "23505") throw new Error(`Unable to save Tally response: ${error.message}`);
        if (!error) importedCount += 1;
      }
      if (!page.hasMore) break;
      if (++pageNumber > 100) throw new IntegrationBlockedError("Tally response list is too large to reconcile safely", "tally");
    }
    const { count, error } = await store.db.from("human_responses").select("id", { count: "exact", head: true })
      .eq("study_id", study.id).eq("owner_id", run.owner_id).not("provider_submission_id", "is", null);
    if (error) throw new Error(`Unable to count Tally responses: ${error.message}`);
    return { importedCount, candidateCount: count ?? 0 };
  } finally {
    if (!client) await tally.close();
  }
}
