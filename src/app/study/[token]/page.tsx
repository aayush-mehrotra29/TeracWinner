import { createHash } from "node:crypto";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/db/admin";
import { studyConceptOrder } from "@/lib/study/presentation";
import styles from "./study.module.css";

export const metadata: Metadata = {
  title: "Product feedback study | Orit",
  robots: { index: false, follow: false },
};

interface StudyMaterials {
  title?: string;
  description?: string;
  audience?: string;
  geography?: string;
  concepts?: string[];
  assetIds?: string[];
  questions?: Array<{ id: string; prompt: string; type?: string }>;
}

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function StudyPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) notFound();
  const hash = createHash("sha256").update(token).digest("hex");
  const admin = createAdminClient();
  const { data: study, error } = await admin
    .from("human_studies")
    .select("id,status,materials")
    .eq("response_token_hash", hash)
    .maybeSingle();
  if (error || !study) notFound();

  const materials = (study.materials ?? {}) as StudyMaterials;
  const active = ["launched", "collecting", "recruiting"].includes(study.status);
  const search = await searchParams;
  const submissionId = first(search.teracSubmissionId) || first(search.submissionId);
  const taskId = first(search.taskId);
  const validSubmission = /^[A-Za-z0-9_-]{1,128}$/.test(submissionId);
  const concepts = (materials.concepts ?? []).filter((concept): concept is string => typeof concept === "string").slice(0, 2);
  const orderedConcepts = validSubmission ? studyConceptOrder(study.id, submissionId, concepts) : concepts;
  const imageAssetIds = (materials.assetIds ?? []).filter((id): id is string =>
    typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
  ).slice(0, 4);
  const questions = (materials.questions ?? []).filter((question) =>
    typeof question.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(question.id) && typeof question.prompt === "string"
  ).slice(0, 10);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.eyebrow}>ORIT / PRODUCT FEEDBACK</div>
        <h1>{materials.title || "Tell us how you would evaluate this product"}</h1>
        <p className={styles.intro}>{materials.description || "Read the idea below and answer from your own experience. Honest concerns are as useful as positive reactions."}</p>

        {!active ? (
          <div className={styles.notice}>This study is not currently accepting responses.</div>
        ) : !validSubmission ? (
          <div className={styles.notice}>Open this study through your Terac invitation to submit a response.</div>
        ) : questions.length === 0 ? (
          <div className={styles.notice}>The study questions are unavailable. Please return to your Terac task page.</div>
        ) : (
          <>
            <section className={styles.materials} aria-labelledby="study-materials">
              <div className={styles.sectionNumber}>01 / MATERIALS</div>
              <h2 id="study-materials">The options under review</h2>
              <p>Consider the product information as presented. You can say that neither option works for you or that you need more information.</p>
              <div className={styles.concepts}>
                {orderedConcepts.map((concept, index) => (
                  <div className={styles.concept} key={`${index}-${concept.slice(0, 20)}`}>
                    <span>Option {index + 1}</span>
                    <p>{concept}</p>
                  </div>
                ))}
              </div>
              {imageAssetIds.length > 0 && (
                <div className={styles.images} aria-label="Product images supplied for this study">
                  {imageAssetIds.map((assetId, index) => (
                    <div className={styles.imageFrame} key={assetId}>
                      <Image
                        src={`/api/study/${encodeURIComponent(token)}/asset/${assetId}`}
                        alt={`Product material ${index + 1}`}
                        width={600}
                        height={600}
                        unoptimized
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <form method="post" action={`/api/study/${encodeURIComponent(token)}/submit`} className={styles.form}>
              <input type="hidden" name="teracSubmissionId" value={submissionId} />
              <input type="hidden" name="taskId" value={taskId} />
              <div className={styles.sectionNumber}>02 / YOUR VIEW</div>
              <h2>What do you think?</h2>
              <p className={styles.helper}>Please answer in your own words. There are no preferred answers.</p>
              {questions.map((question, index) => (
                <label className={styles.question} key={question.id}>
                  <span>{String(index + 1).padStart(2, "0")} / {question.prompt}</span>
                  <textarea name={`answer:${question.id}`} required maxLength={5000} rows={4} />
                </label>
              ))}
              <div className={styles.formFooter}>
                <p>Your responses are reviewed for completion and quality. A completion redirect does not automatically approve or pay a submission.</p>
                <button type="submit">Submit feedback <span aria-hidden="true">↗</span></button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
