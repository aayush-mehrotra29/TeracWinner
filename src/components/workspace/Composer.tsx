"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowUp, Check, ChevronDown, ImagePlus, Link2, Plus, SlidersHorizontal, X } from "lucide-react";
import type { ResearchMode } from "./types";

export type StartInput = {
  idea: string;
  mode: ResearchMode;
  concepts: string[];
  urls: string[];
  files: File[];
  audience?: string;
  economics?: { unitCost: number; minGrossMargin: number; priceUnit: string };
};

export type FollowupInput = { content: string; mode: ResearchMode; urls: string[]; files: File[] };

type ComposerProps = { busy: boolean } & (
  | { kind?: "new"; onStart: (input: StartInput) => Promise<void> }
  | { kind: "followup"; onFollowup: (input: FollowupInput) => Promise<boolean>; initialMode: ResearchMode; canAddResearch: boolean; existingUrls: string[]; existingImageCount: number }
);

type Panel = "add" | "source" | "context" | "model" | null;

const modes: { id: ResearchMode; title: string; description: string }[] = [
  { id: "light_research", title: "Light research", description: "Evidence, competitors, pricing, and objections." },
  { id: "light_simulation", title: "Light simulation", description: "Research plus eight synthetic buying contexts." },
  { id: "deep_simulation", title: "Deep simulation", description: "Terac survey first. Agent simulation starts after a matched response." },
];

export default function Composer(props: ComposerProps) {
  const isFollowup = props.kind === "followup";
  const canAddResearch = !isFollowup || props.canAddResearch;
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState<ResearchMode>(isFollowup ? props.initialMode : "light_simulation");
  const [urls, setUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [conceptA, setConceptA] = useState("");
  const [conceptB, setConceptB] = useState("");
  const [audience, setAudience] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [margin, setMargin] = useState("");
  const [priceUnit, setPriceUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const modeTitle = modes.find((item) => item.id === mode)?.title ?? "Light simulation";
  const existingUrls = props.kind === "followup" ? props.existingUrls : [];
  const existingImageCount = props.kind === "followup" ? props.existingImageCount : 0;
  const urlCapacity = Math.max(0, 5 - existingUrls.length);
  const imageCapacity = Math.max(0, 4 - existingImageCount);

  useEffect(() => {
    if (!panel) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !formRef.current?.contains(event.target)) setPanel(null);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setPanel(null);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [panel]);

  useEffect(() => {
    if (panel === "source") urlField.current?.focus();
  }, [panel]);

  function addUrl() {
    const value = urlInput.trim();
    if (!value || urls.length >= urlCapacity) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") throw new Error();
      if (urls.includes(parsed.href) || existingUrls.includes(parsed.href)) { setUrlInput(""); return; }
      setUrls([...urls, parsed.href]);
      setUrlInput("");
      setError(null);
    } catch {
      setError("Use a complete public HTTPS URL.");
    }
  }

  function addFiles(selection: FileList | null) {
    if (!selection) return;
    const next = [...files];
    let invalid = false;
    let tooMany = false;
    for (const file of Array.from(selection)) {
      if (next.length >= imageCapacity) { tooMany = true; break; }
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
        invalid = true;
        continue;
      }
      if (!next.some((item) => item.name === file.name && item.size === file.size)) next.push(file);
    }
    setFiles(next);
    setError(invalid ? "Images must be PNG, JPEG, or WebP and at most 8 MB each."
      : tooMany ? "This run can include up to four images. The remaining files were not attached." : null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.busy) return;
    const content = idea.trim();
    if (content.length < (isFollowup ? 1 : 20)) {
      setError(isFollowup ? "Write a question or update first." : "Describe the product and decision in at least 20 characters.");
      return;
    }
    let submittedUrls = urls;
    if (urlInput.trim()) {
      try {
        const parsed = new URL(urlInput.trim());
        if (parsed.protocol !== "https:" || (urls.length >= urlCapacity && !urls.includes(parsed.href) && !existingUrls.includes(parsed.href))) throw new Error();
        submittedUrls = urls.includes(parsed.href) || existingUrls.includes(parsed.href) ? urls : [...urls, parsed.href];
      } catch {
        setError("Add up to five complete public HTTPS URLs.");
        return;
      }
    }
    if (isFollowup) {
      if (!props.canAddResearch && (submittedUrls.length || files.length || mode !== props.initialMode)) {
        setError("Complete this clarification before adding research material.");
        return;
      }
      setError(null);
      const sent = await props.onFollowup({ content, mode, urls: submittedUrls, files });
      if (sent) {
        setIdea(""); setUrls([]); setUrlInput(""); setFiles([]); setPanel(null);
      }
      return;
    }
    if (mode === "deep_simulation" && !audience.trim()) {
      setError("Add the target audience so the Terac survey can reach the right people.");
      setPanel("context");
      return;
    }
    if ((unitCost && (!margin || !priceUnit.trim())) || (!unitCost && (margin || priceUnit.trim()))) {
      setError("For a price test, enter unit cost, minimum gross margin, and price unit.");
      return;
    }
    const cost = Number(unitCost);
    const grossMargin = Number(margin);
    if (unitCost && (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(grossMargin) || grossMargin < 0 || grossMargin >= 100)) {
      setError("Use a nonnegative unit cost and a margin from 0% to under 100%.");
      return;
    }
    setError(null);
    await props.onStart({
      idea: content, mode, urls: submittedUrls, files,
      concepts: [conceptA.trim(), conceptB.trim()].filter(Boolean),
      audience: audience.trim() || undefined,
      economics: unitCost ? { unitCost: cost, minGrossMargin: grossMargin / 100, priceUnit: priceUnit.trim() } : undefined,
    });
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <form ref={formRef} className={`studio-composer studio-chat-composer ${isFollowup ? "is-followup" : ""}`} onSubmit={submit} noValidate>
    <label className="studio-visually-hidden" htmlFor="studio-idea">{isFollowup ? "Ask about this research" : "Describe your product idea"}</label>
    <textarea id="studio-idea" value={idea} onChange={(event) => { setIdea(event.target.value); if (error) setError(null); }} onKeyDown={submitOnEnter}
      rows={isFollowup ? 2 : 4} placeholder={isFollowup ? props.canAddResearch ? "Ask about this report or add new research…" : "Add the missing details…" : "Describe an idea or ask a research question…"}
      maxLength={isFollowup ? 4000 : 8000} aria-keyshortcuts="Enter" required />

    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; setPanel(null); }} />
    {(urls.length > 0 || files.length > 0 || urlInput.trim() || (!isFollowup && (audience || conceptA || conceptB || unitCost))) && <div className="studio-chips studio-composer-chips" aria-label="Research materials">
      {urls.map((url) => <span className="studio-chip" key={url}><Link2 size={13} /><span title={url}>{new URL(url).hostname}</span><button type="button" aria-label={`Remove ${url}`} onClick={() => setUrls(urls.filter((item) => item !== url))}><X size={13} /></button></span>)}
      {files.map((file) => <span className="studio-chip" key={`${file.name}-${file.size}`}><ImagePlus size={13} /><span title={file.name}>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((item) => item !== file))}><X size={13} /></button></span>)}
      {urlInput.trim() && <span className="studio-chip is-pending"><Link2 size={13} /><span>Source link being added</span></span>}
      {!isFollowup && (audience || conceptA || conceptB || unitCost) && <button type="button" className="studio-chip studio-context-chip" onClick={() => setPanel("context")}><SlidersHorizontal size={13} /> Research context <ChevronDown size={12} /></button>}
    </div>}

    {panel === "add" && <div className="studio-composer-panel" id="studio-composer-panel" aria-label="Add to research">
      <span className="studio-composer-panel-kicker">ADD TO RESEARCH</span>
      <button type="button" className="studio-composer-action" onClick={() => fileInput.current?.click()} disabled={files.length >= imageCapacity || props.busy}><ImagePlus size={18} /><span><strong>Images</strong><small>PNG, JPEG, or WebP · {existingImageCount + files.length}/4 in this run</small></span><Plus size={15} /></button>
      <button type="button" className="studio-composer-action" onClick={() => setPanel("source")} disabled={urls.length >= urlCapacity || props.busy}><Link2 size={18} /><span><strong>Source link</strong><small>Product pages, competitors, or articles · {existingUrls.length + urls.length}/5 in this run</small></span><Plus size={15} /></button>
      {!isFollowup && <button type="button" className="studio-composer-action" onClick={() => setPanel("context")}><SlidersHorizontal size={18} /><span><strong>Research context</strong><small>Audience, concepts, and unit economics</small></span><Plus size={15} /></button>}
    </div>}

    {panel === "source" && <div className="studio-composer-panel" id="studio-composer-panel" aria-label="Add a source link">
      <div className="studio-composer-panel-heading"><button type="button" onClick={() => setPanel("add")} aria-label="Back to add menu"><ArrowLeft size={17} /></button><span>Add a source link</span></div>
      <div className="studio-composer-url-row"><Link2 size={17} /><label className="studio-visually-hidden" htmlFor="studio-url">Public HTTPS URL</label><input ref={urlField} id="studio-url" type="url" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addUrl(); } }} placeholder="https://example.com/product" disabled={urls.length >= urlCapacity || props.busy} /><button type="button" onClick={addUrl} disabled={!urlInput.trim() || urls.length >= urlCapacity || props.busy}>Add</button></div>
      <p>Orit will inspect permitted public pages and cite saved excerpts.</p>
    </div>}

    {panel === "context" && !isFollowup && <div className="studio-composer-panel studio-context-panel" id="studio-composer-panel" aria-label="Research context">
      <div className="studio-composer-panel-heading"><button type="button" onClick={() => setPanel("add")} aria-label="Back to add menu"><ArrowLeft size={17} /></button><span>Research context</span><button type="button" onClick={() => setPanel(null)} aria-label="Done adding context"><Check size={17} /></button></div>
      <div className="studio-details-grid">
        <label className="studio-field studio-field-wide">Target audience{mode === "deep_simulation" ? " · required for Deep" : ""}<input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="e.g. US apartment renters aged 25–40" maxLength={500} /></label>
        <label className="studio-field">Concept A<textarea rows={2} value={conceptA} onChange={(event) => setConceptA(event.target.value)} placeholder="Optional first concept" maxLength={1000} /></label>
        <label className="studio-field">Concept B<textarea rows={2} value={conceptB} onChange={(event) => setConceptB(event.target.value)} placeholder="Optional second concept" maxLength={1000} /></label>
        <label className="studio-field">Unit cost (USD)<input type="number" inputMode="decimal" min="0" step="0.01" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} placeholder="Optional" /></label>
        <label className="studio-field">Minimum gross margin (%)<input type="number" inputMode="decimal" min="0" max="99.99" step="0.01" value={margin} onChange={(event) => setMargin(event.target.value)} placeholder="Optional" /></label>
        <label className="studio-field studio-field-wide">Price unit<input value={priceUnit} onChange={(event) => setPriceUnit(event.target.value)} placeholder="e.g. per item, monthly subscription" maxLength={80} /></label>
      </div>
    </div>}

    {panel === "model" && <div className="studio-composer-panel studio-model-panel" id="studio-composer-panel" aria-label="Research model and effort">
      <span className="studio-composer-panel-kicker">RESEARCH MODEL</span>
      <div className="studio-model-identity"><strong>Orit Research</strong><small>GPT-6 Luna extracts and evaluates. GPT-6.1 Sol plans, synthesizes, and reviews.</small></div>
      <fieldset className="studio-effort-options"><legend className="studio-composer-panel-kicker">EFFORT</legend>{modes.map((item) => <label key={item.id} className={mode === item.id ? "is-active" : ""}><input type="radio" name="research-mode" value={item.id} checked={mode === item.id} onChange={() => { setMode(item.id); setPanel(item.id === "deep_simulation" && !isFollowup && !audience.trim() ? "context" : null); }} /><span><strong>{item.title}</strong><small>{item.description}</small></span>{mode === item.id && <Check size={16} />}</label>)}</fieldset>
      {mode === "deep_simulation" && <p className="studio-approval-note">Orit creates a Tally survey for a Terac study. A paid launch needs your approval; synthetic agents wait for one matched participant response.</p>}
    </div>}

    {error && <p className="studio-form-error" role="alert">{error}</p>}
    <div className="studio-composer-toolbar">
      {canAddResearch && <button type="button" className={`studio-composer-icon-button studio-composer-add ${panel === "add" || panel === "source" || panel === "context" ? "is-active" : ""}`} onClick={() => setPanel(panel === "add" ? null : "add")} aria-label="Add images, sources, or research context" aria-expanded={panel === "add" || panel === "source" || panel === "context"} aria-controls={panel === "add" || panel === "source" || panel === "context" ? "studio-composer-panel" : undefined} disabled={props.busy}><Plus size={23} strokeWidth={1.8} /></button>}
      {canAddResearch ? <button type="button" className={`studio-model-toggle ${panel === "model" ? "is-active" : ""}`} onClick={() => setPanel(panel === "model" ? null : "model")} aria-label={`Research model: Orit Research. Effort: ${modeTitle}`} aria-expanded={panel === "model"} aria-controls={panel === "model" ? "studio-composer-panel" : undefined} disabled={props.busy}><span>Orit Research</span><em>{modeTitle}</em><ChevronDown size={16} /></button> : <span className="studio-composer-clarification-label">Clarification</span>}
      <button type="submit" className="studio-composer-send" disabled={props.busy || !idea.trim()} aria-label={isFollowup ? "Send message" : "Start research"}><ArrowUp size={20} strokeWidth={2.1} /></button>
    </div>
  </form>;
}
