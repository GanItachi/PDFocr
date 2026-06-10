// app/api/chat/route.js
// Envoie le document transcrit + la question à l'IA choisie.
// Astuce : les 4 fournisseurs gratuits exposent un endpoint compatible OpenAI,
// donc un seul code suffit. La réponse est streamée (SSE) vers le client.

import { buildSystemPrompt } from "../../../lib/prompts";

export const maxDuration = 60;

const PROVIDERS = {
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    keyEnv: "MISTRAL_API_KEY",
    defaultModel: "mistral-small-latest",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    // Les modèles ":free" d'OpenRouter changent souvent ; à ajuster via la variable d'env.
    defaultModel: "deepseek/deepseek-r1:free",
  },
};

export async function POST(req) {
  try {
    const { provider, markdown, mode, question, history } = await req.json();

    const conf = PROVIDERS[provider];
    if (!conf) {
      return Response.json({ error: "Fournisseur inconnu." }, { status: 400 });
    }
    const apiKey = process.env[conf.keyEnv];
    if (!apiKey) {
      return Response.json(
        { error: `Clé ${conf.keyEnv} manquante : ajoutez-la dans les variables d'environnement Vercel.` },
        { status: 500 }
      );
    }
    if (!markdown || !question) {
      return Response.json({ error: "Document ou question manquant." }, { status: 400 });
    }

    const model =
      process.env[`${provider.toUpperCase()}_CHAT_MODEL`] || conf.defaultModel;

    const messages = [
      { role: "system", content: buildSystemPrompt(markdown, mode) },
      ...(Array.isArray(history) ? history.slice(-10) : []), // garder un court historique
      { role: "user", content: question },
    ];

    const upstream = await fetch(conf.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.3 }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return Response.json(
        { error: `Erreur ${provider} (${upstream.status})`, detail: detail.slice(0, 500) },
        { status: 502 }
      );
    }

    // On relaie le flux SSE tel quel ; le client parse les lignes "data:".
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
