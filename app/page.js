"use client";

// Copia — interface "copie d'étudiant".
// Logique identique à la v2.3 (lots dynamiques, recompression, replis 429/503/réseau).

import { useMemo, useRef, useState } from "react";
import { buildCorrectionPrompt } from "../lib/prompts";

const MODES = [
  { key: "resume", label: "Résumé structuré du cours" },
  { key: "fiche", label: "Fiche de révision" },
  { key: "quiz", label: "Quiz d'entraînement" },
  { key: "question", label: "Questions / réponses" },
  { key: "libre", label: "Instruction libre" },
];

const PROVIDERS = [
  { key: "gemini", label: "Gemini Flash (Google)" },
  { key: "groq", label: "Llama 3.3 70B (Groq)" },
  { key: "mistral", label: "Mistral Small" },
  { key: "openrouter", label: "Modèle gratuit (OpenRouter)" },
];

const BATCH_SIZE = 2;
const DELAY_MS = 4500;
const TARGET_WIDTH = 2000;
const MAX_PAYLOAD = 3_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shrinkImage(dataUrl, factor = 0.8, quality = 0.78) {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Image illisible"));
    im.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * factor);
  canvas.height = Math.round(img.height * factor);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/* Icônes minimales (SVG inline : zéro dépendance) */
const I = {
  up: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17V5M6 11l6-6 6 6" /><path d="M4 19h16" />
    </svg>
  ),
  copy: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  ),
  dl: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 4v12M6 12l6 6 6-6" /><path d="M4 20h16" />
    </svg>
  ),
  out: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  ),
};

export default function Home() {
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [verifyPass, setVerifyPass] = useState(true);
  const [markdown, setMarkdown] = useState("");
  const [over, setOver] = useState(false);

  const [provider, setProvider] = useState("gemini");
  const [mode, setMode] = useState("resume");
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState([]);
  const [streaming, setStreaming] = useState(false);

  const [subject, setSubject] = useState("mathématiques avancées, statistiques et économie");
  const [attempt, setAttempt] = useState("");
  const [copied, setCopied] = useState(false);

  const fileRef = useRef(null);

  const correctionPrompt = useMemo(
    () => (markdown ? buildCorrectionPrompt(markdown, { attempt, subject }) : ""),
    [markdown, attempt, subject]
  );

  /* ---------- fichier -> images ---------- */
  async function fileToImages(file, onPage) {
    if (file.type === "application/pdf") {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const images = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, TARGET_WIDTH / base.width);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        images.push(canvas.toDataURL("image/jpeg", 0.85));
        onPage?.(i, pdf.numPages);
      }
      return images;
    }
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1.5, TARGET_WIDTH / bmp.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return [canvas.toDataURL("image/jpeg", 0.85)];
  }

  /* ---------- pipeline OCR ---------- */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy(true);
    setMarkdown("");
    setChat([]);
    setProgress(0);
    try {
      setStatus("Préparation des pages…");
      let images = [];
      for (const f of files) {
        images = images.concat(
          await fileToImages(f, (i, n) => setStatus(`Rendu : page ${i}/${n} de ${f.name}`))
        );
      }

      for (let i = 0; i < images.length; i++) {
        let guard = 0;
        while (images[i].length > MAX_PAYLOAD && guard < 3) {
          setStatus(`Page ${i + 1} trop lourde, recompression…`);
          images[i] = await shrinkImage(images[i]);
          guard++;
        }
      }

      const batches = [];
      let cur = [];
      let curSize = 0;
      for (const img of images) {
        if (cur.length && (cur.length >= BATCH_SIZE || curSize + img.length > MAX_PAYLOAD)) {
          batches.push(cur);
          cur = [];
          curSize = 0;
        }
        cur.push(img);
        curSize += img.length;
      }
      if (cur.length) batches.push(cur);

      const total = images.length;
      let done = 0;
      let result = "";
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const label = `pages ${done + 1}–${done + batch.length} / ${total}`;

        setStatus(`Transcription : ${label}…`);
        let md = await ocrWithRetry({ images: batch });

        if (verifyPass) {
          await sleep(DELAY_MS);
          setStatus(`Relecture des formules : ${label}…`);
          const verified = await ocrWithRetry({ images: batch, draft: md });
          if (verified.trim()) md = verified;
        }

        result += (result ? "\n\n---\n\n" : "") + md.trim();
        setMarkdown(result);
        done += batch.length;
        setProgress(done / total);
        if (b < batches.length - 1) await sleep(DELAY_MS);
      }
      setStatus(`Terminé : ${total} page(s). Relis les formules avant de réviser.`);
    } catch (e) {
      setStatus(`Erreur : ${e.message || e}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function ocrWithRetry(payload, attemptNo = 0, useFallback = false) {
    let r;
    try {
      r = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, useFallback }),
      });
    } catch {
      if (attemptNo < 5) {
        setStatus(`Connexion interrompue — nouvelle tentative dans 8 s… (${attemptNo + 1}/5)`);
        await sleep(8000);
        return ocrWithRetry(payload, attemptNo + 1, useFallback);
      }
      throw new Error("Échec réseau répété. Vérifie ta connexion et garde l'onglet ouvert.");
    }

    if (r.status === 429 && attemptNo < 5) {
      const info = await r.json().catch(() => ({}));
      if (info.daily) {
        if (!useFallback) {
          setStatus("Quota journalier du modèle principal épuisé — bascule sur Flash-Lite…");
          await sleep(2000);
          return ocrWithRetry(payload, attemptNo + 1, true);
        }
        throw new Error(
          "Quota journalier gratuit épuisé sur les deux modèles (réinitialisation vers 7h-8h)."
        );
      }
      setStatus(`Quota par minute atteint, nouvelle tentative dans 30 s… (${attemptNo + 1}/5)`);
      await sleep(30000);
      return ocrWithRetry(payload, attemptNo + 1, useFallback);
    }

    if (r.status === 503 && attemptNo < 5) {
      const nextFallback = useFallback || attemptNo >= 2;
      const wait = Math.min(40000, 10000 * 2 ** Math.min(attemptNo, 2));
      setStatus(
        `Serveurs surchargés (503) — tentative ${attemptNo + 1}/5 dans ${wait / 1000} s` +
          (nextFallback ? " (modèle de repli)" : "")
      );
      await sleep(wait);
      return ocrWithRetry(payload, attemptNo + 1, nextFallback);
    }

    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Erreur OCR (${r.status})`);
    return data.markdown || "";
  }

  /* ---------- analyse intégrée ---------- */
  async function ask(presetQuestion) {
    const q = (presetQuestion ?? question).trim();
    if (!q || !markdown.trim() || streaming) return;
    setQuestion("");
    setChat((c) => [...c, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider, mode, markdown, question: q,
          history: chat.filter((m) => m.content),
        }),
      });
      if (!r.ok || !r.body) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `Erreur (${r.status})`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || "";
            if (delta) {
              setChat((c) => {
                const copy = [...c];
                copy[copy.length - 1] = {
                  role: "assistant",
                  content: copy[copy.length - 1].content + delta,
                };
                return copy;
              });
            }
          } catch { /* fragment incomplet */ }
        }
      }
    } catch (e) {
      setChat((c) => {
        const copy = [...c];
        copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${e.message || e}` };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  function download(name, content, type = "text/markdown") {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyPrompt() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(correctionPrompt);
      } else {
        // Contexte non sécurisé (http hors localhost) : l'API clipboard est désactivée.
        // Méthode de secours : zone de texte temporaire + execCommand.
        const ta = document.createElement("textarea");
        ta.value = correctionPrompt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("copy refusée");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Dernier recours : on aide l'utilisateur à copier manuellement.
      alert(
        "Copie automatique indisponible dans ce contexte. Le texte va être sélectionné : fais Ctrl+C (ou Cmd+C)."
      );
      const box = document.querySelector(".promptbox");
      if (box) {
        box.focus();
        box.select();
      }
    }
  }

  /* ---------- rendu ---------- */
  return (
    <main>
      <header className="hero">
        <div className="hero-inner">
          <p className="tag">Copia · atelier de révision</p>
          <h1>
            Tes cours scannés, prêts à être <em>travaillés</em>.
          </h1>
          <p>
            Dépose un poly ou des photos de TD — même mal scannés. Copia les transcrit en
            Markdown (formules comprises), puis t'aide à réviser : résumé, fiche, quiz, et
            corrigés d'expert pour les sujets sans correction.
          </p>
          <div className="meta">
            <span>OCR double passe</span>
            <span>LaTeX préservé</span>
            <span>100 % gratuit</span>
          </div>
        </div>
      </header>

      <div className="sheet">
        {/* 01 — Import */}
        <section className="copy">
          <div className="ex">
            <span className="num">01</span>
            <h2>Dépose ton document</h2>
          </div>
          <p className="sub">PDF scanné ou photos de pages — plusieurs fichiers possibles.</p>

          <div
            className={`drop ${over ? "over" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && !busy && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (!busy) handleFiles(e.dataTransfer.files);
            }}
          >
            {I.up}
            <p className="big">{busy ? "Traitement en cours…" : "Clique ou glisse tes fichiers ici"}</p>
            <p className="small">PDF · JPG · PNG · WebP</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => handleFiles(e.target.files)}
          />

          <label className="check">
            <input
              type="checkbox"
              checked={verifyPass}
              disabled={busy}
              onChange={(e) => setVerifyPass(e.target.checked)}
            />
            <span>
              Relecture des formules (2ᵉ passe) — recommandé pour les scans de qualité moyenne.
              Deux fois plus lent, deux fois plus fiable sur les maths.
            </span>
          </label>

          {(busy || status) && (
            <div className="status" aria-live="polite">
              <div className="bar"><div className="fill" style={{ width: `${progress * 100}%` }} /></div>
              <p className="mono">{status}</p>
            </div>
          )}
        </section>

        {/* 02 — Markdown */}
        {markdown && (
          <section className="copy">
            <div className="toolbar">
              <div className="ex">
                <span className="num">02</span>
                <h2>Ta transcription</h2>
              </div>
              <button className="ghost" onClick={() => download("cours.md", markdown)}>
                {I.dl} Télécharger le .md
              </button>
            </div>
            <p className="sub">Relis surtout les formules — corrige directement ici si besoin.</p>
            <textarea
              className="mdbox"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={15}
              spellCheck={false}
            />
          </section>
        )}

        {/* 03 — Réviser */}
        {markdown && (
          <section className="copy">
            <div className="ex">
              <span className="num">03</span>
              <h2>Révise avec l'IA</h2>
            </div>
            <p className="sub">Résumé, fiche, quiz — générés à partir de ton document uniquement.</p>

            <div className="fields">
              <label className="field">
                <span>Modèle</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Que veux-tu générer ?</span>
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>
              <div className="field" style={{ display: "flex", alignItems: "flex-end" }}>
                <button
                  className="primary"
                  disabled={streaming}
                  onClick={() => ask("Lance-toi : applique le mode sélectionné à l'ensemble du document.")}
                >
                  Générer
                </button>
              </div>
            </div>

            <div className="chat">
              {chat.length === 0 && (
                <p className="empty">Choisis un mode et clique sur « Générer », ou pose une question.</p>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <pre>{m.content || "…"}</pre>
                </div>
              ))}
            </div>

            <div className="askrow">
              <input
                type="text"
                value={question}
                placeholder="Pose une question sur ton cours…"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
              />
              <button className="primary" onClick={() => ask()} disabled={streaming || !question.trim()}>
                {streaming ? "…" : "Envoyer"}
              </button>
            </div>
          </section>
        )}

        {/* 04 — Correction experte (copie "professeur") */}
        {markdown && (
          <section className="copy prof">
            <div className="ex">
              <span className="num">04</span>
              <h2>Corrige un sujet sans corrigé</h2>
            </div>
            <p className="sub">
              Pour la fiabilité des calculs, la correction passe par DeepSeek (mode DeepThink)
              ou Claude — gratuits via leur site, bien plus forts que les API gratuites.
              Le prompt ci-dessous contient déjà ton sujet et la méthode de correction.
            </p>

            <div className="fields">
              <label className="field">
                <span>Matière (précise le rôle de l'expert)</span>
                <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
            </div>
            <label className="field" style={{ display: "block", marginBottom: 18 }}>
              <span>Ta tentative (optionnel — elle sera évaluée avant le corrigé)</span>
              <textarea
                value={attempt}
                onChange={(e) => setAttempt(e.target.value)}
                rows={4}
                placeholder="Colle ton brouillon de solution ici…"
              />
            </label>

            <textarea className="promptbox" value={correctionPrompt} readOnly rows={8} />

            <div className="btnrow">
              <button className="ghost" onClick={copyPrompt}>
                {I.copy} {copied ? "Copié ✓" : "Copier le prompt"}
              </button>
              <button
                className="ghost"
                onClick={() => download("prompt-correction.txt", correctionPrompt, "text/plain")}
              >
                {I.dl} Télécharger (.txt)
              </button>
              <a className="btn ghost" href="https://chat.deepseek.com" target="_blank" rel="noreferrer">
                DeepSeek {I.out}
              </a>
              <a className="btn ghost" href="https://claude.ai/new" target="_blank" rel="noreferrer">
                Claude {I.out}
              </a>
            </div>
            <p className="mono" style={{ marginTop: 14 }}>
              Astuce : active DeepThink (R1) dans DeepSeek pour les calculs. Prompt trop long
              pour le collage ? Télécharge le .txt et joins-le comme fichier.
            </p>
          </section>
        )}
      </div>

      <footer>
        Quotas gratuits variables selon les fournisseurs. Les offres gratuites peuvent utiliser
        tes données pour l'entraînement : pas de documents sensibles. Et vérifie toujours un
        corrigé d'IA — même les meilleurs modèles se trompent parfois.
      </footer>
    </main>
  );
}
