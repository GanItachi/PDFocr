# Scan → Markdown → IA (100 % gratuit, déployé sur Vercel)

Workflow : **PDF scanné → OCR en Markdown → analyse par l'IA de votre choix**, sans rien payer.

## Architecture (et pourquoi elle est faite ainsi)

```
Navigateur                          Vercel (Hobby, gratuit)        APIs gratuites
──────────                          ───────────────────────        ──────────────
PDF ──pdf.js──> images JPEG  ──>    /api/ocr  ────────────────>    Gemini Flash (OCR)
  (page par page, lots de 2)        (relais + prompt OCR)          palier gratuit

Markdown éditable            ──>    /api/chat ────────────────>    Gemini / Groq /
  + mode + question                 (prompt système + stream)      Mistral / OpenRouter
```

Deux contraintes du plan gratuit de Vercel dictent la conception :

1. **Limite de 4,5 Mo** par requête vers une fonction serverless → le PDF n'est
   **jamais envoyé entier au serveur**. Il est rendu en images **dans le navigateur**
   (pdf.js) et les pages partent par lots de 2 (~1–2 Mo).
2. **Timeout 10 s par défaut, 60 s max** sur Hobby → chaque appel ne traite que
   2 pages ; les routes exportent `maxDuration = 60`.

Côté IA, les 4 fournisseurs exposent un **endpoint compatible OpenAI**, donc une
seule route `/api/chat` suffit pour tous (streaming SSE inclus).

## Déploiement (≈ 10 minutes)

1. **Clés gratuites** (aucune carte bancaire pour Gemini et Groq) :
   - Gemini (obligatoire, sert à l'OCR) : https://aistudio.google.com/apikey
   - Groq (optionnel) : https://console.groq.com/keys
   - Mistral, palier Experiment (optionnel) : https://console.mistral.ai/
   - OpenRouter, modèles `:free` (optionnel) : https://openrouter.ai/keys
2. Poussez ce dossier sur un dépôt GitHub.
3. Sur https://vercel.com : **Add New → Project → Import** le dépôt
   (framework détecté : Next.js, rien à configurer).
4. Dans **Settings → Environment Variables**, ajoutez au minimum `GEMINI_API_KEY`
   (voir `.env.example`), puis redéployez.

En local : `npm install` puis `npm run dev` avec un fichier `.env.local`.

## Limites et hypothèses à connaître

- **Quotas gratuits (ordres de grandeur, ils changent régulièrement — vérifiez les
  pages officielles)** : Gemini Flash ≈ 10–15 requêtes/min et quelques centaines à
  ~1 500 requêtes/jour. À 2 pages par requête, comptez ≈ 20 pages/minute et
  plusieurs centaines de pages/jour. Le code attend 4,5 s entre les lots et
  réessaie automatiquement en cas de 429.
- **Confidentialité** : sur les paliers gratuits (Gemini notamment), les données
  envoyées **peuvent servir à l'entraînement des modèles**. Ne pas y mettre de
  documents sensibles ; passer au palier payant (ou à un OCR local type Tesseract)
  pour ces cas.
- **Plan Vercel Hobby** : réservé à un usage **personnel et non commercial**.
- **Qualité OCR** : excellente sur du texte imprimé propre ; le manuscrit, les
  scans très dégradés et les formules complexes restent les cas difficiles. Les
  passages douteux sont marqués `[illisible]` ou `⟦...⟧` — relisez l'étape 2
  avant d'interroger l'IA.
- **Très gros documents** : un document de 100+ pages produit un Markdown long ;
  les modèles gratuits à petit contexte (certains `:free` d'OpenRouter)
  peuvent saturer. Gemini Flash (contexte ~1 M tokens) est le choix sûr.

## Personnalisation

- Les prompts (OCR + modes "mettre l'IA dans les conditions") sont dans
  `lib/prompts.js` : ajoutez vos propres modes en quelques lignes.
- Les modèles se changent sans toucher au code via les variables d'environnement
  (`GEMINI_OCR_MODEL`, `GROQ_CHAT_MODEL`, etc.).
