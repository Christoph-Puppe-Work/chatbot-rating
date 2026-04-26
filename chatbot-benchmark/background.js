// background.js — orchestrator for the benchmark run.
//
// Lifecycle:
//   1. Dashboard sends START_BENCHMARK with config (API keys, source, count).
//   2. We fetch news headlines from the configured source.
//   3. We ask Gemini 3.1 Pro to turn each headline into a self-contained question.
//   4. We open a tab per chatbot, wait for content scripts to be reachable.
//   5. For each question, we dispatch ASK to all 4 tabs in parallel,
//      collect ANSWER messages, and judge each with Gemini + Claude.
//   6. Partial results stream back to the dashboard so the UI feels alive.
//
// Everything that talks to external APIs runs here, not in content scripts —
// content scripts inherit page CORS, the service worker does not.

const GEMINI_MODEL = "gemini-3.1-pro-preview";
const CLAUDE_MODEL = "claude-opus-4-7";

const CHATBOTS = [
  { id: "claude",  url: "https://claude.ai/new",            label: "Claude" },
  { id: "chatgpt", url: "https://chatgpt.com/",             label: "ChatGPT" },
  { id: "gemini",  url: "https://gemini.google.com/app",    label: "Gemini" },
  { id: "grok",    url: "https://grok.com/",                label: "Grok" },
];

// ---------- open dashboard when the toolbar icon is clicked ----------

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// ---------- dashboard ↔ background message bus ----------

let dashboardPort = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dashboard") return;
  dashboardPort = port;
  port.onMessage.addListener(async msg => {
    if (msg.type === "START_BENCHMARK") {
      try {
        await runBenchmark(msg.config);
      } catch (e) {
        send("ERROR", { message: String(e?.message || e) });
      } finally {
        send("DONE", {});
      }
    }
  });
  port.onDisconnect.addListener(() => { dashboardPort = null; });
});

function send(type, payload) {
  try { dashboardPort?.postMessage({ type, payload }); } catch {}
}

// ---------- main run ----------

async function runBenchmark(config) {
  send("LOG", { level: "info", msg: `starting run · ${config.count} questions · source=${config.source}` });

  // 1. fetch news
  send("PHASE", { phase: "news", done: 0, total: 1 });
  const articles = await fetchNews(config.source, config.count);
  send("LOG", { level: "ok", msg: `fetched ${articles.length} articles` });
  send("PHASE", { phase: "news", done: 1, total: 1 });

  // 2. generate questions in parallel
  send("PHASE", { phase: "questions", done: 0, total: articles.length });
  const questions = [];
  let qDone = 0;
  await Promise.all(articles.map(async (a, i) => {
    try {
      const q = await generateQuestion(a, config.geminiKey);
      questions[i] = { article: a, question: q };
      send("LOG", { level: "debug", msg: `Q${i+1}: ${q.slice(0, 80)}…` });
    } catch (e) {
      send("LOG", { level: "err", msg: `Q${i+1} gen failed: ${e.message}` });
      questions[i] = { article: a, question: null };
    } finally {
      qDone++;
      send("PHASE", { phase: "questions", done: qDone, total: articles.length });
    }
  }));

  const validQuestions = questions.filter(q => q.question);
  if (validQuestions.length === 0) throw new Error("no questions generated");
  send("QUESTIONS_READY", { questions: validQuestions });

  // 3. FULL-PARALLEL: spawn one tab per (question, chatbot) pair, all at once.
  // Each tab is opened, used for exactly ONE question, then closed.
  const totalTasks = validQuestions.length * CHATBOTS.length;
  send("PHASE", { phase: "asking", done: 0, total: totalTasks });
  const concurrency = Math.max(1, Math.min(40, config.concurrency || 8));
  send("LOG", { level: "info", msg: `dispatching ${totalTasks} tasks (${validQuestions.length} questions × ${CHATBOTS.length} chatbots) · max ${concurrency} concurrent tabs` });

  let completed = 0;
  const allTasks = [];

  for (let qi = 0; qi < validQuestions.length; qi++) {
    for (const cb of CHATBOTS) {
      allTasks.push({ qi, cb, question: validQuestions[qi].question });
    }
  }

  const taskResults = await runWithConcurrency(allTasks, concurrency, async (task) => {
    const { qi, cb, question } = task;
    const t0 = performance.now();
    let tabId = null;
    try {
      // open a fresh tab for this question
      const tab = await chrome.tabs.create({ url: cb.url, active: false });
      tabId = tab.id;
      send("LOG", { level: "debug", msg: `Q${qi+1}/${cb.label}: tab ${tabId} opened` });

      // wait for content script to load — poll PING with backoff
      let alive = false;
      const tWait = Date.now();
      while (Date.now() - tWait < 30000) {
        await sleep(1000);
        alive = await pingTab(tabId);
        if (alive) break;
      }
      if (!alive) throw new Error("content script never became reachable");

      // additional 2s settle time after content script is ready
      await sleep(2000);

      // dispatch ASK
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "ASK",
        question,
        maxWaitMs: config.maxWaitMs ?? 180_000,
      });
      if (!resp?.ok) throw new Error(resp?.error || "no response");

      const ms = Math.round(performance.now() - t0);
      send("LOG", { level: "ok", msg: `Q${qi+1}/${cb.label}: ${resp.answer.length} chars in ${resp.durationMs ?? ms}ms` });
      return { qi, chatbot: cb.id, answer: resp.answer, durationMs: resp.durationMs ?? ms, error: null };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      send("LOG", { level: "err", msg: `Q${qi+1}/${cb.label} failed: ${e.message}` });
      return { qi, chatbot: cb.id, answer: "", durationMs: ms, error: String(e.message) };
    } finally {
      // always close the tab when done
      if (tabId !== null) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      completed++;
      send("PHASE", { phase: "asking", done: completed, total: totalTasks });
    }
  });

  // group results back by question
  const askResultsByQ = validQuestions.map(() => []);
  for (const tr of taskResults) {
    askResultsByQ[tr.qi].push({
      chatbot: tr.chatbot,
      answer: tr.answer,
      durationMs: tr.durationMs,
      error: tr.error,
    });
  }

  // 4. judge each answer (also fully parallel across all answers)
  send("LOG", { level: "info", msg: "all answers in, judging…" });
  const results = [];
  const judgePromises = [];
  for (let qi = 0; qi < validQuestions.length; qi++) {
    const { question, article } = validQuestions[qi];
    judgePromises.push((async () => {
      const judged = await Promise.all(askResultsByQ[qi].map(async ar => {
        if (ar.error || !ar.answer) {
          return { ...ar, scores: { gemini: null, claude: null }, errored: true };
        }
        const [gScore, cScore] = await Promise.all([
          judgeWithGemini(question, ar.answer, config.geminiKey).catch(e => ({ error: e.message })),
          judgeWithClaude(question, ar.answer, config.claudeKey).catch(e => ({ error: e.message })),
        ]);
        send("LOG", { level: "debug", msg: `  Q${qi+1}/${ar.chatbot}: gemini=${fmtScore(gScore)} claude=${fmtScore(cScore)}` });
        return { ...ar, scores: { gemini: gScore, claude: cScore } };
      }));
      const result = { question, article, answers: judged };
      results[qi] = result;
      send("PARTIAL_RESULT", { index: qi, result });
    })());
  }
  await Promise.all(judgePromises);

  send("RESULTS", { results });
  send("LOG", { level: "ok", msg: "run complete" });
}

function fmtScore(s) {
  if (!s || s.error) return "?";
  return `${s.completeness}/${s.precision}`;
}

async function pingTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return r?.ok === true;
  } catch { return false; }
}

// ---------- news fetching ----------

async function fetchNews(source, count) {
  if (source === "hackernews") {
    const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HN fetch failed: ${r.status}`);
    const j = await r.json();
    return j.hits.map(h => ({
      title: h.title || h.story_title || "(untitled)",
      url:   h.url   || h.story_url   || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      source: "hackernews",
    }));
  }
  throw new Error(`unknown source: ${source}`);
}

// ---------- Gemini API: question generation + judging ----------

async function geminiCall(apiKey, prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      thinkingConfig: { thinkingLevel: "low" }, // judging is fine on low
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

async function generateQuestion(article, geminiKey) {
  const prompt = `You are generating benchmark questions for testing AI chatbots on tech news comprehension.

Given a news headline, produce ONE specific factual question that:
1. A knowledgeable reader would actually want answered after seeing the headline
2. Is self-contained — the chatbot will not see the article
3. Asks for substantive content, not the article's existence ("what does X claim about Y?", not "is there an article about X?")
4. Is answerable in a few paragraphs by a strong AI

HEADLINE: ${article.title}
URL: ${article.url}

Output JSON with one key: question (string).`;

  const schema = {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  };
  const out = await geminiCall(geminiKey, prompt, schema);
  return out.question;
}

async function judgeWithGemini(question, answer, geminiKey) {
  const prompt = buildJudgePrompt(question, answer);
  const schema = {
    type: "object",
    properties: {
      completeness: { type: "integer", minimum: 0, maximum: 10 },
      precision:    { type: "integer", minimum: 0, maximum: 10 },
      reasoning:    { type: "string" },
    },
    required: ["completeness", "precision", "reasoning"],
  };
  return await geminiCall(geminiKey, prompt, schema);
}

// ---------- Claude API: judging ----------

async function judgeWithClaude(question, answer, claudeKey) {
  const prompt = buildJudgePrompt(question, answer);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt + "\n\nReply with ONLY a JSON object, no prose, no markdown fences." }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`claude ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("\n");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

function buildJudgePrompt(question, answer) {
  return `You are an expert evaluator of AI chatbot answers.

Score the ANSWER below 0–10 on two dimensions:

- COMPLETENESS: does it address all aspects of the question?
  0 = ignores most of what was asked
  5 = covers the main thrust but misses important angles
  10 = thoroughly addresses every part of the question

- PRECISION: how factually accurate, specific, and well-grounded is it?
  0 = mostly wrong, vague, or hedged into uselessness
  5 = mixed — some specifics, some hand-waving, possibly minor errors
  10 = accurate, specific, well-supported, no notable errors

QUESTION:
${question}

ANSWER:
${answer}

Output JSON only:
{"completeness": <int 0-10>, "precision": <int 0-10>, "reasoning": "<one or two sentence justification>"}`;
}

// ---------- utils ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run an async function over an array of items, with at most `limit`
// in-flight at any time. Returns results in the same order as the input.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
