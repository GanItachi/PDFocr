// app/api/ocr/route.js — v2
// Passe 1 : images -> Markdown. Passe 2 (optionnelle) : images + brouillon -> Markdown corrigé.

import { OCR_PROMPT, OCR_VERIFY_PROMPT } from "../../../lib/prompts";

export const maxDuration = 60;

const GEMINI_MODEL = process.env.GEMINI_OCR_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = process.env.GEMINI_OCR_FALLBACK_MODEL || "gemini-2.5-flash-lite";

export async function POST(req) {
  try {
    const { images, draft, useFallback } = await req.json();
    if (!Array.isArray(images) || images.length === 0 || images.length > 3) {
      return Response.json({ error: "Envoyer entre 1 et 3 images par requête." }, { status: 400 });
    }
    if (!process.env.GEMINI_API_KEY) {
      return Response.json({ error: "GEMINI_API_KEY manquante." }, { status: 500 });
    }

    const isVerify = typeof draft === "string" && draft.trim().length > 0;
    const parts = [{ text: isVerify ? OCR_VERIFY_PROMPT : OCR_PROMPT }];

    for (const dataUrl of images) {
      const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
      if (!match) return Response.json({ error: "Format d'image invalide." }, { status: 400 });
      parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    if (isVerify) {
      parts.push({ text: `BROUILLON À RELIRE :\n\n${draft}` });
    }

    const model = useFallback ? FALLBACK_MODEL : GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0 },
      }),
    });

    if (r.status === 429) {
      const detail = await r.text();
      const daily = /PerDay/i.test(detail); // Gemini indique le quota touché (PerMinute / PerDay)
      return Response.json(
        {
          error: daily
            ? "Quota JOURNALIER gratuit épuisé pour ce modèle (réinitialisation vers 7h-8h, heure d'Abidjan)."
            : "Quota par minute atteint (réessayer dans ~30 s).",
          retry: !daily,
          daily,
          detail: detail.slice(0, 300),
        },
        { status: 429 }
      );
    }
    if (r.status === 503 || r.status === 502 || r.status === 504) {
      return Response.json(
        { error: `Serveurs Gemini surchargés (${r.status}) — nouvelle tentative automatique.`, retry: true },
        { status: 503 }
      );
    }
    if (!r.ok) {
      const detail = await r.text();
      return Response.json(
        { error: `Erreur Gemini (${r.status})`, detail: detail.slice(0, 500) },
        { status: 502 }
      );
    }

    const data = await r.json();
    const markdown =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

    return Response.json({ markdown });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
