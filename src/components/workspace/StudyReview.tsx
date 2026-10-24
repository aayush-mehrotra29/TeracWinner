"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";

type StudyResponse = {
  id: string;
  review_status?: string;
  reviewStatus?: string;
  provider_status?: string;
  answers?: unknown;
  response?: unknown;
  created_at?: string;
  [key: string]: unknown;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const data = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data as T;
}

function answerText(response: StudyResponse): string {
  const answer = response.answers ?? response.response;
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object") return JSON.stringify(answer, null, 2);
  return "No answer content was returned for this response.";
}

export default function StudyReview({ studyId, onReview }: { studyId: string; onReview: () => Promise<void> }) {
  const [responses, setResponses] = useState<StudyResponse[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    const result = await request<{ responses: StudyResponse[] }>(`/api/studies/${studyId}/responses`);
    setResponses(result.responses ?? []);
    setLoaded(true);
    setError(null);
  }, [studyId]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(refresh).catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Could not load responses."); setLoaded(true); } });
    const timer = window.setInterval(() => { if (active) refresh().catch(() => undefined); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  async function review(id: string, reviewStatus: "accepted" | "rejected") {
    setPendingId(id);
    setError(null);
    try {
      await request(`/api/studies/${studyId}/responses/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus }) });
      await refresh();
      await onReview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save review.");
    } finally { setPendingId(null); }
  }

  const unreviewed = responses.filter((response) => !["accepted", "rejected"].includes(response.review_status ?? response.reviewStatus ?? ""));
  return <section className="studio-review-queue"><div className="studio-review-head"><div><span className="studio-caps">Owner review</span><h3>Human response queue</h3></div><span>{unreviewed.length} to review</span></div><p>Review answers before they enter the human-feedback addendum. Submission IDs are for attribution and do not establish identity.</p>{error && <p className="studio-form-error" role="alert">{error}</p>}{!loaded ? <p className="studio-review-empty">Loading responses…</p> : responses.length === 0 ? <p className="studio-review-empty">No participant responses have been saved yet.</p> : <div className="studio-review-list">{responses.map((response, index) => { const status = response.review_status ?? response.reviewStatus ?? "pending"; return <div className="studio-review-item" key={response.id}><div className="studio-review-item-head"><span>Response {String(index + 1).padStart(2, "0")}</span><span className={`is-${status}`}>{status.replaceAll("_", " ")}</span></div><pre>{answerText(response)}</pre><p className="studio-review-provider">Terac attribution: {response.provider_status ?? "unconfirmed"}</p>{status !== "accepted" && status !== "rejected" && <div className="studio-review-actions"><button type="button" onClick={() => review(response.id, "rejected")} disabled={pendingId === response.id}><X size={15} /> Reject</button><button type="button" onClick={() => review(response.id, "accepted")} disabled={pendingId === response.id || response.provider_status !== "confirmed"} title={response.provider_status !== "confirmed" ? "Wait for Terac attribution" : undefined}><Check size={15} /> Accept</button></div>}</div>; })}</div>}</section>;
}
