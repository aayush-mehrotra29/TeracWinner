import assert from "node:assert/strict";
import test from "node:test";
import {
  allowlistedTallyAnswers, completedTallyAnswers, ensureDeepStudyForm, makeStudyMaterials, productSurveyQuestions, tallyFormBlocks,
  tallyFormMatchesMaterials, tallyHiddenFieldId,
} from "../../src/lib/research/tally";
import type { TallyMcp, TallySubmissionPage } from "../../src/lib/providers/tally";
import type { TallyStudy } from "../../src/lib/research/tally";
import type { ResearchStore } from "../../src/lib/research/store";
import type { RunRow } from "../../src/lib/research/types";

const run = {
  id: "41949b18-f40f-494b-9bf2-ea3bd917e724",
  project_id: "project",
  owner_id: "owner",
  mode: "deep_simulation",
  status: "queued",
  stage: null,
  input: {
    idea: "A shared project planner for college groups",
    audience: "US college students",
    concepts: ["Calendar-first planner", "Chat-first planner"],
    assetIds: ["asset-1"],
  },
  version: 1,
  budget_usd: 0,
  spent_usd: 0,
} as RunRow;

test("deep survey presents concepts, uploaded images, and use and choice questions", () => {
  const materials = makeStudyMaterials(run);
  assert.equal(materials.concepts.length, 2);
  assert.equal(materials.questions.find((item) => item.id === "use_intent")?.type, "choice");
  assert.equal(materials.questions.find((item) => item.id === "image_reaction")?.type, "text");
  const blocks = tallyFormBlocks(run, materials, ["https://storage.example.com/signed/product.png"]);
  assert.equal(blocks.filter((item) => (item as { type: string }).type === "IMAGE").length, 1);
  assert.ok(blocks.some((item) => (item as { html?: string }).html?.includes("Concept B: Chat-first planner")));
  assert.ok(blocks.some((item) => (item as { text?: string }).text === "Not enough information"));
});

test("briefs become a single respondent concept with a concise public title", () => {
  const geem = { ...run, input: { ...run.input, concepts: [], idea:
    "Should GEEM launch the Seoul Street Collection of Korean seaweed chips in the US, and which flavors should it test first? Big Seoul Flavor. Little Seaweed Crunch. This collection combines crunchy seaweed, rice crisps, and sesame seeds with Korean-inspired flavors. Assess likely appeal and weaknesses. The attached image is a packaging concept; note differences in flavor labels." } } as RunRow;
  const materials = makeStudyMaterials(geem);
  assert.equal(materials.title, "Product feedback: GEEM Seoul Street Collection");
  assert.equal(materials.concepts.length, 1);
  assert.match(materials.concepts[0], /crunchy seaweed, rice crisps/);
  assert.doesNotMatch(materials.concepts[0], /Should GEEM|Assess likely|attached image/);
  const text = tallyFormBlocks(geem, materials, []).filter((item) => (item as { type: string }).type === "TEXT")
    .map((item) => (item as { html: string }).html);
  assert.equal(text.filter((item) => item.includes("crunchy seaweed, rice crisps")).length, 1);
  assert.ok(text.every((item) => !item.includes("Should GEEM")));
});

test("single concept survey offers current option and neither", () => {
  const questions = productSurveyQuestions(["One concept"], false);
  assert.equal(questions.some((item) => item.id === "image_reaction"), false);
  assert.deepEqual(questions.find((item) => item.id === "choice")?.options,
    ["This product", "My current option", "Neither", "Not enough information"]);
});

test("Terac hidden submission field is located by its saved Tally UUID", () => {
  const ledger = "| 2 | - | 4532c1b5-1333-43c9-9467-55a63b101e05 | HIDDEN_FIELDS | 30d19a39-9585-428a-9700-9ccbaa348211 | 1 | ... | ac5b8ee5-5b1a-42b0-a8bb-3bdbc573b816=teracSubmissionId, 1ffe77ca-12ec-4c04-8f3a-516abba05b79=submissionId |";
  assert.equal(tallyHiddenFieldId(ledger), "ac5b8ee5-5b1a-42b0-a8bb-3bdbc573b816");
  assert.equal(tallyHiddenFieldId(ledger, "missing"), null);
});

test("a resumed form is complete only when every saved product image matches", () => {
  const questions = productSurveyQuestions(["A"], true);
  const imageUrl = "https://storage.example.com/signed/product.png?token=test";
  const questionRows = questions.map((question) => `| 4 | ${question.prompt} | uuid | TITLE | question | 1 | before | - |`).join("\n");
  const fullLedger = `| 2 | - | hidden | HIDDEN_FIELDS | hidden-q | 1 | before | field=teracSubmissionId |\n${questionRows}\n| 3 | Product image | image | IMAGE | - | 1 | before | images=[{\"url\":\"${imageUrl}\"}] |`;
  assert.equal(tallyFormMatchesMaterials(fullLedger, questions, [imageUrl]), true);
  assert.equal(tallyFormMatchesMaterials(fullLedger.replace(/\| 3 \| Product image[^\n]+/, ""), questions, [imageUrl]), false);
  assert.equal(tallyFormMatchesMaterials(fullLedger, questions, ["https://storage.example.com/other.png"]), false);
});

test("only completed responses with a Terac ID and required product answers are eligible", () => {
  const materials = {
    ...makeStudyMaterials(run),
    tallyHiddenSubmissionFieldId: "hidden-terac-id",
  };
  const usePrompt = materials.questions.find((question) => question.id === "use_intent")!.prompt;
  const choicePrompt = materials.questions.find((question) => question.id === "choice")!.prompt;
  const answers = (id: string) => [
    { questionId: "hidden-terac-id", answer: id },
    { questionId: "use-q", answer: "Maybe" },
    { questionId: "choice-q", answer: "Concept B" },
  ];
  const page: TallySubmissionPage = {
    questions: [
      { id: "use-q", label: usePrompt, type: "MULTIPLE_CHOICE" },
      { id: "choice-q", label: choicePrompt, type: "MULTIPLE_CHOICE" },
    ],
    hasMore: false,
    submissions: [
      { id: "real", isCompleted: true, submittedAt: "2026-10-24T00:00:00Z", responses: answers("terac_real_1") },
      { id: "draft", isCompleted: false, submittedAt: "2026-10-24T00:00:00Z", responses: answers("terac_draft") },
      { id: "public", isCompleted: true, submittedAt: "2026-10-24T00:00:00Z", responses: answers("") },
      { id: "demo", isCompleted: true, submittedAt: "2026-10-24T00:00:00Z", responses: answers("demo_1") },
    ],
  };
  const imported = completedTallyAnswers(page, materials);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].teracSubmissionId, "terac_real_1");
  assert.equal(imported[0].responses.use_intent, "Maybe");
  assert.equal(imported[0].responses.choice, "Concept B");
  assert.equal(allowlistedTallyAnswers(page, materials, new Set<string>()).length, 0);
  assert.equal(allowlistedTallyAnswers(page, materials, new Set(["terac_real_1"]))[0].tallySubmissionId, "real");
});

test("worker retry resumes a complete draft with its saved image instead of adding blocks again", async () => {
  const imageUrl = "https://storage.example.com/signed/product.png?token=test";
  const materials = {
    ...makeStudyMaterials(run),
    tallyFormId: "form-1", imageUrls: [imageUrl],
    imageExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    formBuilt: false,
  };
  const questionRows = materials.questions.map((question) => `| 4 | ${question.prompt} | uuid | TITLE | question | 1 | before | - |`).join("\n");
  const fullLedger = `| 2 | - | hidden | HIDDEN_FIELDS | hidden-q | 1 | before | ac5b8ee5-5b1a-42b0-a8bb-3bdbc573b816=teracSubmissionId |\n${questionRows}\n| 3 | Product image | image | IMAGE | - | 1 | before | images=[{\"url\":\"${imageUrl}\"}] |`;
  let study = {
    id: "study-1", run_id: run.id, owner_id: run.owner_id, status: "creating_form", target_count: 12,
    quote: null, materials, provider_id: null, response_token_hash: null,
    approved_fingerprint: null, approval_at: null, launched_at: null,
  } satisfies TallyStudy;
  const db = {
    from: (table: string) => {
      assert.equal(table, "human_studies");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: study, error: null }) }) }),
        update: (changes: Partial<TallyStudy>) => ({ eq: () => ({ select: () => ({ single: async () => {
          study = { ...study, ...changes } as typeof study;
          return { data: study, error: null };
        } }) }) }),
      };
    },
  };
  let createdBlocks = 0;
  let published = 0;
  let titleSet = "";
  const tally = {
    listWorkspaces: async () => [{ id: "workspace", name: "My workspace" }],
    setFormTitle: async (_formId: string, title: string) => { titleSet = title; },
    loadForm: async () => ({ ledger: fullLedger, status: "DRAFT" }),
    createBlocks: async () => { createdBlocks += 1; return fullLedger; },
    setCompletionRedirect: async (_formId: string, hiddenId: string) => {
      assert.equal(hiddenId, "ac5b8ee5-5b1a-42b0-a8bb-3bdbc573b816");
    },
    publishForm: async () => { published += 1; return "https://tally.so/r/form-1"; },
  } as unknown as TallyMcp;
  const store = { db, assertLease: () => undefined } as unknown as ResearchStore;
  const saved = await ensureDeepStudyForm(store, run, tally);
  assert.equal(saved.status, "awaiting_response");
  assert.equal(saved.materials.tallyUrl, "https://tally.so/r/form-1");
  assert.equal(saved.materials.formBuilt, true);
  assert.equal(createdBlocks, 0);
  assert.equal(published, 1);
  assert.equal(titleSet, materials.title);
});

test("a new form keeps its recovery title until its ID is saved", async () => {
  const newRun = { ...run, input: { ...run.input, assetIds: [], concepts: [] } } as RunRow;
  const materials = makeStudyMaterials(newRun);
  const questionRows = materials.questions.map((question) =>
    `| 4 | ${question.prompt} | uuid | TITLE | question | 1 | before | - |`).join("\n");
  const ledger = `| 1 | ${materials.title} | title | FORM_TITLE | - | 1 | - | - |\n` +
    `| 2 | - | hidden | HIDDEN_FIELDS | hidden-q | 1 | before | ac5b8ee5-5b1a-42b0-a8bb-3bdbc573b816=teracSubmissionId |\n${questionRows}`;
  let study: TallyStudy | null = null;
  const db = { from: (table: string) => {
    assert.equal(table, "human_studies");
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: study, error: null }) }) }),
      insert: (values: Partial<TallyStudy>) => ({ select: () => ({ single: async () => {
        study = { id: "study-new", ...values } as TallyStudy;
        return { data: study, error: null };
      } }) }),
      update: (changes: Partial<TallyStudy>) => ({ eq: () => ({ select: () => ({ single: async () => {
        study = { ...study!, ...changes };
        return { data: study, error: null };
      } }) }) }),
    };
  } };
  const sequence: string[] = [];
  const tally = {
    listWorkspaces: async () => [{ id: "workspace", name: "My workspace" }],
    listForms: async () => [],
    createForm: async (title: string) => {
      assert.ok(title.includes(newRun.id));
      sequence.push("create");
      return { id: "new-form", ledger: "" };
    },
    setFormTitle: async (_formId: string, title: string) => {
      assert.equal(study?.materials.tallyFormId, "new-form");
      assert.equal(title, materials.title);
      sequence.push("public-title");
    },
    loadForm: async () => ({ ledger, status: "DRAFT" }),
    setCompletionRedirect: async () => undefined,
    publishForm: async () => { sequence.push("publish"); return "https://tally.so/r/new-form"; },
  } as unknown as TallyMcp;
  const store = { db, assertLease: () => undefined } as unknown as ResearchStore;
  const saved = await ensureDeepStudyForm(store, newRun, tally);
  assert.equal(saved.materials.tallyUrl, "https://tally.so/r/new-form");
  assert.deepEqual(sequence, ["create", "public-title", "publish"]);
});
