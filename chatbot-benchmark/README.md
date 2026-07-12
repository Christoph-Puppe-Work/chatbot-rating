# Chatbot Product Benchmark

> **Test the _products_, not the models.**

A Chrome extension that benchmarks the **consumer chat interfaces** of Claude, ChatGPT, Gemini, and Grok — not their APIs. It sends real questions through the actual web UIs, captures streamed answers via DOM observation, and has the responses judged by two independent LLMs (Gemini 3.1 Pro + Claude Opus 4.7). Optional human override lets you add your own scores in a blind side-by-side comparison.

---

## Why This Exists

API benchmarks measure _model_ capability. But what users actually experience is the _product_ — system prompts, tool use, web search, streaming latency, and UI quirks all included. This extension captures that full picture by automating the real browser experience.

---

## How It Works

```
┌─────────────┐     START_BENCHMARK      ┌──────────────┐
│  Dashboard  │ ──────────────────────── │  Background  │
│  (UI/port)  │ ◄── LOG, PHASE, RESULT ─│  (service    │
│             │                          │   worker)    │
└─────────────┘                          └──────┬───────┘
                                                │
          ┌────────────────┬────────────────┬────┴───────────┐
          ▼                ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │ claude.ai   │  │ chatgpt.com │  │ gemini.      │  │ grok.com    │
   │ tab         │  │ tab         │  │ google.com   │  │ tab         │
   │             │  │             │  │ tab          │  │             │
   │ cs-shared + │  │ cs-shared + │  │ cs-shared +  │  │ cs-shared + │
   │ cs-claude   │  │ cs-chatgpt  │  │ cs-gemini    │  │ cs-grok     │
   └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
```

### Pipeline

1. **Fetch headlines** — Pulls front-page stories from Hacker News (via `hn.algolia.com`).
2. **Generate questions** — Gemini 3.1 Pro converts each headline into a self-contained factual question (JSON output, structured schema).
3. **Ask the chatbots** — For each question, the background worker opens a _fresh tab_ per chatbot (fresh-tab strategy: one question per tab, DOM starts empty). Content scripts type the question into the composer, click send, and poll for stream completion.
4. **Judge answers** — Each answer is scored 0–10 on _completeness_ and _precision_ by both Gemini 3.1 Pro and Claude Opus 4.7 (with web search enabled).
5. **Display results** — Partial results stream into the dashboard in real time.

### Custom Questions

Instead of generating questions from news, you can upload a `.txt` or `.csv` file with one question per line. The file upload skips the news-fetch and question-generation phases entirely.

---

## Architecture

| File | Role |
|---|---|
| `manifest.json` | MV3 Chrome extension manifest — permissions, content script registration, service worker |
| `background.js` | **Orchestrator** — runs the full benchmark pipeline, talks to external APIs (Gemini, Claude, Hacker News), manages tab lifecycle, dispatches `ASK` messages to content scripts |
| `cs-shared.js` | **Shared utilities** loaded into every chatbot tab — DOM helpers (`waitForSelector`, `pickOne`, `setComposerText`, `realClick`), universal response capture, and the `chrome.runtime.onMessage` handler that bridges `ASK`/`PING` messages to the per-site adapter |
| `cs-chatgpt.js` | **ChatGPT adapter** — locates the composer (`#prompt-textarea`), submits via send button or Enter key, detects stream completion by tracking the `#f8aa74` SVG send-icon disappearance→reappearance cycle |
| `cs-claude.js` | **Claude adapter** — uses `data-is-streaming` attribute on wrapper divs as the primary done signal, with a targeted container selector to skip "Thinking" blocks |
| `cs-gemini.js` | **Gemini adapter** — uses the `aria-busy` attribute on `.markdown-main-panel` as the completion signal |
| `cs-grok.js` | **Grok adapter** — detects completion via `.action-buttons.last-response` class appearance |
| `dashboard.html` | **Dashboard UI** — glassmorphic dark-mode interface with aurora background, progress bars, results table, log console, answer detail modal, user rating sliders, and blind judge mode |
| `dashboard.js` | **Dashboard logic** — port-based messaging with background worker, results rendering, CSV/infographic export, user rating persistence (`chrome.storage.local`), blind judge mode with randomized column order |
| `questions.txt` | Sample custom questions file (cybersecurity-themed) |

---

## Content Script Completion Detection

Each chatbot adapter uses a different strategy to know when streaming is finished, because each product has a different DOM structure:

| Chatbot | Primary Signal | Safety Fallback |
|---|---|---|
| **ChatGPT** | SVG send-icon (`#f8aa74`) disappears on submit, reappears when done | Text stable for 60 s |
| **Claude** | `data-is-streaming="true"` → `"false"` on wrapper div | Text stable for 60 s |
| **Gemini** | `aria-busy="false"` on `.markdown-main-panel` | Text stable for 60 s |
| **Grok** | `.action-buttons.last-response` class appears | Text stable for 60 s |

All adapters share a common stability buffer (1.5–2.5 s of stable text after the primary signal fires) to avoid exiting during brief UI transition gaps.

---

## Installation

1. Clone this repo (or download the `chatbot-benchmark/` folder).
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in the top-right).
4. Click **Load unpacked** and select the `chatbot-benchmark/` directory.
5. The extension icon appears in the toolbar — click it to open the dashboard.

### Prerequisites

- **Chrome** (or Chromium-based browser with MV3 support)
- **Logged-in sessions** for all four chatbots in the same browser profile:
  - [claude.ai](https://claude.ai)
  - [chatgpt.com](https://chatgpt.com)
  - [gemini.google.com](https://gemini.google.com)
  - [grok.com](https://grok.com)
- **API keys** (entered in the dashboard, stored in `chrome.storage.local` — never leave the browser):
  - Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) — used for question generation + judge #1
  - Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) — used for judge #2

---

## Dashboard Settings

| Setting | Default | Description |
|---|---|---|
| **Question count** | 10 | Number of Hacker News headlines to fetch and convert to questions |
| **Max wait per answer** | 300 s | Hard timeout if a chatbot stalls — all adapters and the background worker respect this value |
| **Max concurrent tabs** | 8 | Cap on how many chatbot tabs are open simultaneously. Lower = safer (less memory), higher = faster |
| **Autoclose tabs** | ✓ | Automatically close each tab after it returns an answer |
| **Custom questions file** | — | Upload a `.txt`/`.csv` file (one question per line) to bypass news fetching entirely |

---

## Scoring & Methodology (v1.1.0)

Adapted from the sibling **political-compass benchmark** (`political-compass-benchmark/web-tools/chatbot-neutrality-extension`). The shared, environment-agnostic helpers live in **`cr-methods.js`** (family registry, refusal cues, bootstrap CI, rate-limit cues).

**Answer status.** Every captured answer is classified *before* judging: `answered | refused | empty | error`. **Refused / empty / error answers are never sent to the paid judges** (they don't burn Gemini + Claude calls), and per-product **refusal counts are a first-class metric** rather than scored 0 or silently dropped.

**Two scores per answered response** (0–10 completeness + precision, by Gemini 3.1 Pro and Claude Opus 4.7):

- **Raw** — mean of both judges.
- **Clean (headline)** — mean of only the **cross-family** judges. Gemini and Claude are *also* two of the four products, so a judge grading its own family is circular: **Gemini does not grade the Gemini product, Claude does not grade the Claude product.** For those two the clean score rests on the single cross-family judge; for ChatGPT and Grok, clean = raw. Conflicted judgements are flagged (struck through) and kept in exports — nothing is discarded.

**Confidence.** The summary row shows **clean ± CI95** — a 1000-sample bootstrap over the per-question clean means, seeded `20260708 + stableOffset(product)`. Deterministic for a fixed seed, but a JS `mulberry32` PRNG, not CPython's Mersenne Twister.

**Reps.** *Reps per (question × chatbot)* > 1 resamples each cell; the score is the mean over answered reps and the CI narrows. Multiplies tab + judge cost.

**Human override.** Clicking a cell shows the answer + each judge's reasoning + sliders for your own rating; **your rating overrides both judges** in the table and all exports.

**Pre-flight product discipline.** The measurand is the product a signed-in user experiences, so each product's config (model label, plan, **memory OFF**, web-search state, UI language) is captured in the *pre-flight* card and snapshotted into every export's manifest. Web search may legitimately stay **ON** for a news benchmark — it is *recorded*, not mandated; memory/personalization OFF is the one that matters (it prevents cross-run leakage).

**Reproducibility & resilience.** All run state lives in `chrome.storage.local`; a 1-minute alarm rehydrates an interrupted run and it never re-fires a paid call on resume. A per-product **rate-limit cue scan** cools a product 15 min and requeues the task on a hit (giving up after 3). **Re-run transient** rebuilds the queue from `empty`/`error` (optionally `refused`) cells. Export the **question set** (`.txt`, re-runnable via the Custom Questions input) or the whole **run bundle** (`.json`: manifest + questions + results, **no API keys**) for later re-render / re-judge.

---

## Blind Judge Mode

After a run completes, click **▶ Blind Judge** to enter a full-screen side-by-side comparison. All four answers are shown in randomized columns labeled "Model A" through "Model D" — you don't see which chatbot produced which answer. Rate each column on completeness and precision, then save. The mapping is revealed in the results table, and your scores feed into the summary averages.

---

## Exports

| Export | Format | Contents |
|---|---|---|
| **CSV** | `.csv` (UTF-8 BOM) | One row per (question, rep); per‑chatbot raw + **clean** avg, `status`, `excluded_judge`, both judge scores, user scores, duration, chars, errors. Prefixed with `#`‑comment metadata rows (run id, methods version, question‑set SHA‑256, per‑product config) |
| **Infographic** | Standalone `.html` | Dark‑mode report ranked by the **clean** score, with refusal counts, per‑question heatmap, circularity method footnote, and a reproducibility stamp |
| **Questions** | `.txt` | One question per line — re‑runnable via the Custom Questions file input |
| **Run bundle** | `.json` | Manifest + questions + results + your ratings (no API keys) — re‑import to re‑render, re‑judge, or re‑export |

---

## Concurrency Model

The extension uses a **full-parallel, fresh-tab** strategy:

- Every `(question, chatbot)` pair gets its own tab, opened to a fresh URL (e.g. `https://claude.ai/new`).
- A configurable concurrency limiter (`runWithConcurrency`) caps the number of simultaneously open tabs.
- After each tab returns its answer, it is closed (if autoclose is enabled) and the slot is freed for the next task.
- The background worker dispatches `ASK` messages and collects responses via `chrome.tabs.sendMessage`.

This avoids conversation-history contamination between questions and sidesteps DOM caching issues from prior answers.

---

## Background Tab Resilience

Chrome aggressively throttles background tabs (timers, animations, DOM updates). The adapters handle this with:

- **No reliance on `innerText` layout** — text extraction walks `node.textContent` recursively (works even when the tab is not painted).
- **Long safety-fallback timeouts** — if the primary completion signal is missed due to throttling, a 60-second stable-text fallback ensures the answer is still captured.
- **State-machine detection** (ChatGPT) — the `#f8aa74` send-icon must be observed to _disappear_ before its _reappearance_ counts as a completion signal, preventing false positives from the initial page state.

---

## Limitations

- **Small N** — With 10–20 questions per run, results are directional snapshots, not statistically significant benchmarks.
- **Tech-news scope** — Questions are sourced from Hacker News, so scores reflect tech/news comprehension specifically — not coding, math, creative writing, or other dimensions.
- **UI fragility** — Content scripts depend on DOM selectors that can break when chatbot UIs are updated. The multi-selector fallback chains mitigate this, but periodic maintenance is expected.
- **Rate limits** — Judging uses two API calls per answer (Gemini + Claude). The extension throttles to 2 concurrent judge tasks to stay within typical API rate limits.

---

## Version

**v1.1.0** — Judge‑family circularity gate (clean cross‑family score), answer status taxonomy + refusal metric, bootstrap CI95, reps, per‑product rate‑limit cooldown, re‑run transient, pre‑flight product config, run manifest + question/bundle exports. Built on the v1.0.x MV3 checkpoint/resume engine. Methodology shared with the political‑compass benchmark via `cr-methods.js`.

## License

Not specified — please add a license file if you plan to distribute.
