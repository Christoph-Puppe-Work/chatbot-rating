// ===== state =====
const $ = id => document.getElementById(id);
const state = {
  running: false,
  results: [],          // accumulated per-question
  questions: [],
  logCount: 0,
  autoscroll: true,
  port: null,
  userRatings: {},      // key -> { completeness, precision, notes, savedAt }
  modal: null,          // { question, chatbot, ans, key } while open
  blindIndex: 0,        // current index for blind judge mode
  blindMapping: [],     // shuffled array of chatbot names
};

// Default judge prompt template — editable in the UI textarea.
// {{QUESTION}} and {{ANSWER}} are replaced at judge time.
const DEFAULT_JUDGE_PROMPT = `You are an expert evaluator of AI chatbot answers.

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
{{QUESTION}}

ANSWER:
{{ANSWER}}

Output JSON only:
{"completeness": <int 0-10>, "precision": <int 0-10>, "reasoning": "<one or two sentence justification>"}`;

const DEFAULT_QUESTION_PROMPT = `You are generating benchmark questions for testing AI chatbots on tech news comprehension.

Given a news headline, produce ONE specific factual question that:
1. A knowledgeable reader would actually want answered after seeing the headline
2. Is self-contained — the chatbot will not see the article
3. Asks for substantive content, not the article's existence ("what does X claim about Y?", not "is there an article about X?")
4. Is answerable in a few paragraphs by a strong AI

HEADLINE: {{HEADLINE}}
URL: {{URL}}

Output JSON with one key: question (string).`;

const DEFAULT_SYSTEM_MESSAGE = ``;


// Stable key for a (question, chatbot) pair. Same question + chatbot = same key
// across runs, so user ratings survive re-runs and dashboard reloads.
function ratingKey(question, chatbot) {
  // simple djb2-ish hash; doesn't need to be cryptographic
  let h = 5381;
  const s = "v1|" + chatbot + "|" + question;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "ur_" + (h >>> 0).toString(36) + "_" + chatbot;
}

async function loadUserRatings() {
  const v = await chrome.storage.local.get("userRatings");
  state.userRatings = v.userRatings || {};
}
async function persistUserRatings() {
  await chrome.storage.local.set({ userRatings: state.userRatings });
}

// ===== logging =====
function nowTs() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}
function log(level, msg) {
  const body = $("log-body");
  const line = document.createElement("div");
  line.className = "log-line " + level;
  line.innerHTML = `<span class="ts">${nowTs()}</span><span class="lvl">${level}</span><span class="msg"></span>`;
  line.querySelector(".msg").textContent = msg;
  body.appendChild(line);
  state.logCount++;
  $("log-count").textContent = `${state.logCount} lines`;
  if (state.autoscroll) body.scrollTop = body.scrollHeight;
}

$("log-clear").addEventListener("click", () => {
  $("log-body").innerHTML = "";
  state.logCount = 0;
  $("log-count").textContent = "0 lines";
});
$("autoscroll").addEventListener("change", e => state.autoscroll = e.target.checked);

// ===== api key persistence =====
async function loadKeys() {
  const v = await chrome.storage.local.get(["geminiKey", "claudeKey"]);
  if (v.geminiKey) $("gemini-key").value = v.geminiKey;
  if (v.claudeKey) $("claude-key").value = v.claudeKey;
}
async function saveKeys() {
  await chrome.storage.local.set({
    geminiKey: $("gemini-key")?.value?.trim() || "",
    claudeKey: $("claude-key")?.value?.trim() || "",
  });
}
$("gemini-key").addEventListener("change", saveKeys);
$("claude-key").addEventListener("change", saveKeys);
loadKeys();
loadUserRatings();
$('judge-prompt').value = DEFAULT_JUDGE_PROMPT;
$('question-prompt').value = DEFAULT_QUESTION_PROMPT;
$('system-message').value = DEFAULT_SYSTEM_MESSAGE;

// ===== status pill =====
function setStatus(text, cls) {
  const p = $("status-pill");
  p.textContent = text;
  p.className = "status-pill" + (cls ? " " + cls : "");
}

// ===== phase progress =====
function updatePhase(phase, done, total) {
  const row = document.querySelector(`.phase-row[data-phase="${phase}"]`);
  if (!row) return;
  const pct = total > 0 ? (done / total) * 100 : 0;
  const fill = row.querySelector(".progress-fill");
  fill.style.width = pct + "%";
  row.querySelector(".phase-count").textContent = `${done} / ${total}`;
  const nameEl = row.querySelector(".phase-name");
  if (done === total && total > 0) {
    fill.classList.add("done");
    nameEl.classList.remove("active");
    nameEl.classList.add("done");
  } else if (done > 0 || total > 0) {
    nameEl.classList.add("active");
  }
}

// ===== results table =====
const CHATBOTS = ["claude", "chatgpt", "gemini", "grok"];

function avgScore(s) {
  if (!s || s.error) return null;
  if (typeof s.completeness !== "number" || typeof s.precision !== "number") return null;
  return ((s.completeness + s.precision) / 2);
}

// Returns the effective scores for a (question, chatbot) cell, with user rating
// overriding judge averages when present.
//   { display: number|null,  // single number to show in the table cell
//     overridden: bool,      // true if user-rating was used
//     gemini: avg|null,      // judge averages (always returned for reference)
//     claude: avg|null,
//     userRating: {...}|null }
function effectiveScores(question, chatbot, ans) {
  const k = ratingKey(question, chatbot);
  const ur = state.userRatings[k] || null;
  const gAvg = avgScore(ans?.scores?.gemini);
  const cAvg = avgScore(ans?.scores?.claude);
  if (ur && typeof ur.completeness === "number" && typeof ur.precision === "number") {
    return {
      display: (ur.completeness + ur.precision) / 2,
      overridden: true,
      gemini: gAvg, claude: cAvg, userRating: ur,
    };
  }
  const both = [gAvg, cAvg].filter(x => x !== null);
  return {
    display: both.length ? both.reduce((s, x) => s + x, 0) / both.length : null,
    overridden: false,
    gemini: gAvg, claude: cAvg, userRating: null,
  };
}

function renderResultRow(idx, result) {
  $("results-sec").style.display = "block";
  const tbody = $("results-body");

  // remove existing row with same index, if any
  const existing = tbody.querySelector(`tr[data-idx="${idx}"]:not(.summary-row)`);
  if (existing) existing.remove();

  const tr = document.createElement("tr");
  tr.dataset.idx = idx;
  const qShort = result.question.length > 140 ? result.question.slice(0, 140) + "…" : result.question;
  tr.innerHTML = `<td>${idx + 1}</td><td class="q"></td>` + CHATBOTS.map(() => `<td class="score"></td>`).join("");
  tr.children[1].textContent = qShort;

  CHATBOTS.forEach((cb, ci) => {
    const cell = tr.children[2 + ci];
    const a = result.answers.find(x => x.chatbot === cb);
    if (!a || a.error || !a.answer) {
      cell.classList.add("empty");
      cell.textContent = a?.error ? "✕" : "—";
      cell.title = a?.error || "no answer";
      return;
    }
    const eff = effectiveScores(result.question, cb, a);
    const g = a.scores?.gemini, c = a.scores?.claude;
    const fmtJCell = (j, prefix) => {
      if (!j || j.error) return `<span class="${prefix === 'G' ? 'gem' : 'cla'}">${prefix} ?/?</span>`;
      return `<span class="${prefix === 'G' ? 'gem' : 'cla'}">${prefix} ${j.completeness}/${j.precision}</span>`;
    };
    if (eff.overridden) {
      const u = eff.userRating;
      cell.innerHTML = `
        <span class="gem"><b>${u.completeness}/${u.precision}</b></span><span class="user-badge">YOU</span>
        <span class="ms">${(a.durationMs / 1000).toFixed(1)}s · ${a.answer.length} ch</span>
      `;
    } else {
      cell.innerHTML = `
        ${fmtJCell(g, 'G')} · ${fmtJCell(c, 'C')}
        <span class="ms">${(a.durationMs / 1000).toFixed(1)}s · ${a.answer.length} ch</span>
      `;
    }
    cell.style.cursor = "pointer";
    cell.addEventListener("click", () => openModal(result.question, cb, a));
  });

  // append in numeric order
  const rows = Array.from(tbody.querySelectorAll('tr[data-idx]:not(.summary-row)'));
  let inserted = false;
  for (const r of rows) {
    if (parseInt(r.dataset.idx) > idx) { tbody.insertBefore(tr, r); inserted = true; break; }
  }
  if (!inserted) tbody.appendChild(tr);
  renderSummary();
}

function renderSummary() {
  const tbody = $("results-body");
  const old = tbody.querySelector("tr.summary-row");
  if (old) old.remove();

  const valid = state.results.filter(Boolean);
  if (valid.length === 0) return;

  const totals = {};
  for (const cb of CHATBOTS) totals[cb] = { score: 0, ms: 0, n: 0, errors: 0, userN: 0 };

  for (const r of valid) {
    for (const a of r.answers) {
      const t = totals[a.chatbot]; if (!t) continue;
      if (a.error || !a.answer) { t.errors++; continue; }
      const eff = effectiveScores(r.question, a.chatbot, a);
      if (eff.display === null) { t.errors++; continue; }
      t.score += eff.display;
      t.ms += a.durationMs;
      t.n++;
      if (eff.overridden) t.userN++;
    }
  }

  const tr = document.createElement("tr");
  tr.className = "summary-row";
  tr.innerHTML = `<td></td><td class="q">avg across ${valid.length} q</td>` +
    CHATBOTS.map(cb => {
      const t = totals[cb];
      if (t.n === 0) return `<td class="score empty">—</td>`;
      const avg = (t.score / t.n).toFixed(2);
      const sec = (t.ms / t.n / 1000).toFixed(1);
      const errs = t.errors > 0 ? ` <span class="ms" style="color:var(--red)">${t.errors} err</span>` : "";
      const userTag = t.userN > 0 ? ` <span class="ms" style="color:var(--amber)">${t.userN}× you</span>` : "";
      return `<td class="score"><b>${avg}</b><span class="ms">${sec}s avg${errs}${userTag}</span></td>`;
    }).join("");
  tbody.appendChild(tr);
}

// ===== modal =====
function openModal(question, chatbot, ans) {
  const k = ratingKey(question, chatbot);
  state.modal = { question, chatbot, ans, key: k };

  $("modal-eyebrow").textContent = `// ${chatbot} answer`;
  $("modal-title").textContent = chatbot;
  $("modal-meta").textContent = `${(ans.durationMs / 1000).toFixed(1)}s · ${ans.answer.length} chars`;
  $("modal-q").textContent = question;
  $("modal-pre").textContent = ans.answer || "(no answer)";

  const g = ans.scores?.gemini, c = ans.scores?.claude;

  // Compute averaged completeness and precision across both judges
  const compScores = [g, c].filter(j => j && !j.error && typeof j.completeness === 'number').map(j => j.completeness);
  const precScores = [g, c].filter(j => j && !j.error && typeof j.precision === 'number').map(j => j.precision);
  const avgComp = compScores.length ? (compScores.reduce((a, b) => a + b, 0) / compScores.length).toFixed(1) : '—';
  const avgPrec = precScores.length ? (precScores.reduce((a, b) => a + b, 0) / precScores.length).toFixed(1) : '—';

  const fmtJ = (j, who) => {
    if (!j) return `<b>${who}:</b> —`;
    if (j.error) return `<b>${who}:</b> error — ${j.error}`;
    return `<b>${who}:</b> completeness ${j.completeness}/10 · precision ${j.precision}/10 — ${j.reasoning || ""}`;
  };
  $("modal-judges").innerHTML = `
    <div style="font-size:16px;margin-bottom:12px;color:var(--text-primary)">
      <b>Avg Completeness:</b> ${avgComp}/10 &nbsp;·&nbsp; <b>Avg Precision:</b> ${avgPrec}/10
    </div>
    ${fmtJ(g, "Gemini 3.1 Pro")}<br><br>${fmtJ(c, "Claude Opus 4.7")}`;

  // populate user-rating fields
  const existing = state.userRatings[k];
  const cVal = existing?.completeness ?? avgScoreToInt(g) ?? 5;
  const pVal = existing?.precision ?? avgScoreToInt(c) ?? 5;
  $("ur-completeness").value = cVal;
  $("ur-completeness-val").textContent = cVal;
  $("ur-precision").value = pVal;
  $("ur-precision-val").textContent = pVal;
  $("ur-notes").value = existing?.notes || "";
  updateRatingStatus(existing);

  $("modal-bg").classList.add("open");
}

function avgScoreToInt(j) {
  if (!j || j.error) return null;
  const a = avgScore(j);
  return a === null ? null : Math.round(a);
}

function updateRatingStatus(ur) {
  const el = $("user-rating-status");
  if (ur && ur.savedAt) {
    const d = new Date(ur.savedAt);
    el.textContent = `your rating saved · ${d.toLocaleString()}`;
    el.classList.add("saved");
  } else {
    el.textContent = "not yet rated";
    el.classList.remove("saved");
  }
}

$("ur-completeness").addEventListener("input", e => $("ur-completeness-val").textContent = e.target.value);
$("ur-precision").addEventListener("input", e => $("ur-precision-val").textContent = e.target.value);

$("ur-save").addEventListener("click", async () => {
  if (!state.modal) return;
  const k = state.modal.key;
  const rating = {
    completeness: parseInt($("ur-completeness").value),
    precision: parseInt($("ur-precision").value),
    notes: $("ur-notes").value.trim(),
    savedAt: Date.now(),
  };
  state.userRatings[k] = rating;
  await persistUserRatings();
  updateRatingStatus(rating);
  // re-render the affected row + summary
  const idx = state.results.findIndex(r => r && r.question === state.modal.question);
  if (idx >= 0) renderResultRow(idx, state.results[idx]);
});

$("ur-clear").addEventListener("click", async () => {
  if (!state.modal) return;
  const k = state.modal.key;
  if (!state.userRatings[k]) return;
  delete state.userRatings[k];
  await persistUserRatings();
  updateRatingStatus(null);
  const idx = state.results.findIndex(r => r && r.question === state.modal.question);
  if (idx >= 0) renderResultRow(idx, state.results[idx]);
});

$("modal-close").addEventListener("click", () => {
  $("modal-bg").classList.remove("open");
  state.modal = null;
});
$("modal-bg").addEventListener("click", e => {
  if (e.target === $("modal-bg")) {
    $("modal-bg").classList.remove("open");
    state.modal = null;
  }
});

// ===== CSV export =====
function toCsv() {
  const head = ["#", "question", "url"];
  for (const cb of CHATBOTS) {
    head.push(
      `${cb}_gemini_completeness`, `${cb}_gemini_precision`,
      `${cb}_claude_completeness`, `${cb}_claude_precision`,
      `${cb}_user_completeness`, `${cb}_user_precision`, `${cb}_user_notes`,
      `${cb}_avg`, `${cb}_avg_source`,
      `${cb}_duration_ms`, `${cb}_chars`, `${cb}_error`
    );
  }
  const rows = [head];
  state.results.forEach((r, i) => {
    if (!r) return;
    const row = [i + 1, r.question, r.article?.url || ""];
    for (const cb of CHATBOTS) {
      const a = r.answers.find(x => x.chatbot === cb);
      if (!a) { row.push("", "", "", "", "", "", "", "", "", "", "", ""); continue; }
      const g = a.scores?.gemini, c = a.scores?.claude;
      const eff = effectiveScores(r.question, cb, a);
      const ur = eff.userRating;
      row.push(
        g?.completeness ?? "", g?.precision ?? "",
        c?.completeness ?? "", c?.precision ?? "",
        ur?.completeness ?? "", ur?.precision ?? "", ur?.notes ?? "",
        eff.display !== null ? eff.display.toFixed(2) : "",
        eff.overridden ? "user" : (eff.display !== null ? "judges" : ""),
        a.durationMs ?? "", a.answer?.length ?? 0, a.error || ""
      );
    }
    rows.push(row);
  });
  return rows.map(r => r.map(csvCell).join(",")).join("\n");
}
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
$("btn-export").addEventListener("click", () => {
  const csv = toCsv();
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = url; a.download = `chatbot-bench-${stamp}.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ===== infographic export =====

const CHATBOT_LABELS = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Median of an array (returns null for empty).
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
}

function buildInfographicData() {
  const valid = state.results.filter(Boolean);
  if (valid.length === 0) return null;

  const perBot = {};
  for (const cb of CHATBOTS) {
    perBot[cb] = { scores: [], times: [], lengths: [], errors: 0, userN: 0, cells: [] };
  }

  for (const r of valid) {
    for (const cb of CHATBOTS) {
      const a = r.answers.find(x => x.chatbot === cb);
      const t = perBot[cb];
      if (!a || a.error || !a.answer) {
        t.errors++;
        t.cells.push({ score: null, error: a?.error || "no answer" });
        continue;
      }
      const eff = effectiveScores(r.question, cb, a);
      if (eff.display === null) {
        t.errors++;
        t.cells.push({ score: null, error: "no scores" });
        continue;
      }
      t.scores.push(eff.display);
      t.times.push(a.durationMs);
      t.lengths.push(a.answer.length);
      if (eff.overridden) t.userN++;
      t.cells.push({ score: eff.display, overridden: eff.overridden });
    }
  }

  // build ranking
  const ranking = CHATBOTS.map(cb => {
    const t = perBot[cb];
    const avg = t.scores.length ? t.scores.reduce((s, x) => s + x, 0) / t.scores.length : null;
    const medTime = median(t.times);
    const medLen = median(t.lengths);
    return {
      id: cb,
      label: CHATBOT_LABELS[cb],
      avg,
      medTimeMs: medTime,
      medLength: medLen,
      errors: t.errors,
      userN: t.userN,
      n: t.scores.length,
    };
  }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));

  return {
    runDate: new Date().toISOString().slice(0, 10),
    questionCount: valid.length,
    source: "Hacker News front page",
    ranking,
    perBot,
    questions: valid.map(r => ({
      question: r.question,
      url: r.article?.url || "",
      cells: CHATBOTS.map(cb => {
        const idx = valid.indexOf(r);
        return perBot[cb].cells[idx];
      }),
    })),
  };
}

// Render the infographic as a standalone HTML document.
function buildInfographicHtml(data) {
  // Per-chatbot accent shades — all violet-spectrum, distinguishable, harmonious
  // with the system accent. Built in oklch so they share lightness/chroma.
  const cbColors = {
    claude: "oklch(0.72 0.16 305)",   // violet — system accent
    chatgpt: "oklch(0.70 0.16 240)",   // complementary blue (allowed by skill)
    gemini: "oklch(0.74 0.14 280)",   // violet-blue midpoint
    grok: "oklch(0.76 0.14 330)",   // violet-pink lean
  };

  // Heatmap cell colors — single-hue violet ramp by score, no rainbow.
  const scoreColor = (s) => {
    if (s === null || s === undefined) return "oklch(0.95 0.005 280 / 0.04)";
    if (s >= 8.5) return "oklch(0.72 0.18 300 / 0.85)";
    if (s >= 7) return "oklch(0.68 0.16 300 / 0.65)";
    if (s >= 5.5) return "oklch(0.60 0.13 300 / 0.45)";
    if (s >= 4) return "oklch(0.50 0.10 300 / 0.30)";
    return "oklch(0.40 0.08 300 / 0.20)";
  };
  const scoreTextColor = (s) => {
    if (s === null || s === undefined) return "oklch(0.55 0.02 280)";
    return s >= 7 ? "oklch(0.13 0.02 280)" : "oklch(0.95 0.005 280)";
  };

  // Section icons — geometric Unicode glyphs from the skill, no emoji
  const ICONS = { rank: "◬", speed: "⌕", heat: "▣" };

  const podium = data.ranking.map((r, i) => {
    const w = r.avg !== null ? Math.max(8, (r.avg / 10) * 100) : 0;
    const pos = String(i + 1).padStart(2, "0");
    return `
      <div class="rank-row">
        <div class="rank-pos">${pos}</div>
        <div class="rank-bar-wrap">
          <div class="rank-name" style="color:${cbColors[r.id]}">${r.label}</div>
          <div class="rank-track">
            <div class="rank-fill" style="width:${w}%; background:${cbColors[r.id]}">
              ${r.avg !== null ? `<span class="rank-val">${r.avg.toFixed(2)}</span>` : ""}
            </div>
          </div>
          <div class="rank-meta">
            <span>${r.n} answered</span>
            ${r.errors > 0 ? `<span class="rank-meta-err">${r.errors} failed</span>` : ""}
            ${r.userN > 0 ? `<span class="rank-meta-you">${r.userN}× you</span>` : ""}
            <span>${r.medTimeMs !== null ? (r.medTimeMs / 1000).toFixed(1) + "s median" : "—"}</span>
            <span>${r.medLength !== null ? Math.round(r.medLength) + " chars median" : "—"}</span>
          </div>
        </div>
      </div>`;
  }).join("");

  const validTimes = data.ranking.filter(r => r.medTimeMs !== null);
  const slowest = validTimes.reduce((m, x) => x.medTimeMs > m ? x.medTimeMs : m, 0);
  const speedRows = validTimes
    .sort((a, b) => a.medTimeMs - b.medTimeMs)
    .map(r => {
      const w = slowest > 0 ? (r.medTimeMs / slowest) * 100 : 0;
      return `
        <div class="speed-row">
          <span class="speed-name" style="color:${cbColors[r.id]}">${r.label}</span>
          <div class="speed-track"><div class="speed-fill" style="width:${w}%; background:${cbColors[r.id]}"></div></div>
          <span class="speed-val">${(r.medTimeMs / 1000).toFixed(1)}s</span>
        </div>`;
    }).join("");

  const heatRows = data.questions.map((q, i) => {
    const cells = q.cells.map((c, ci) => {
      const cb = CHATBOTS[ci];
      if (c.score === null) {
        return `<td class="heat-cell empty" title="${escapeHtml(c.error)}">—</td>`;
      }
      const badge = c.overridden ? `<span class="heat-badge">YOU</span>` : "";
      return `<td class="heat-cell" style="background:${scoreColor(c.score)}; color:${scoreTextColor(c.score)}" title="${cb}: ${c.score.toFixed(1)}">${c.score.toFixed(1)}${badge}</td>`;
    }).join("");
    const qShort = q.question.length > 110 ? q.question.slice(0, 110) + "…" : q.question;
    const num = String(i + 1).padStart(2, "0");
    return `<tr><td class="heat-q"><span class="heat-q-num">${num}</span> ${escapeHtml(qShort)}</td>${cells}</tr>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chatbot Benchmark — ${data.runDate}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>
:root {
  --bg-deep:        oklch(0.13 0.02 280);
  --bg-elev-1:      oklch(0.95 0.005 280 / 0.04);
  --bg-elev-2:      oklch(0.95 0.005 280 / 0.06);
  --bg-elev-3:      oklch(0.95 0.005 280 / 0.08);
  --border-1:       oklch(0.95 0.005 280 / 0.06);
  --border-2:       oklch(0.95 0.005 280 / 0.10);
  --text-primary:   oklch(0.95 0.005 280);
  --text-secondary: oklch(0.75 0.02 280);
  --text-tertiary:  oklch(0.65 0.02 280);
  --text-quiet:     oklch(0.55 0.02 280);
  --accent:         oklch(0.7  0.18 300);
  --accent-soft:    oklch(0.7  0.18 300 / 0.15);
  --accent-glow:    oklch(0.7  0.18 300 / 0.4);
  --sans:           'Inter', system-ui, sans-serif;
  --mono:           'JetBrains Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--bg-deep);
  color: var(--text-primary);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.55;
  min-height: 100vh;
}
body { position: relative; overflow-x: hidden; padding: 56px 32px 80px; }

/* Aurora atmosphere — required by the skill, no exceptions */
.aurora-1, .aurora-2, .noise {
  position: fixed; pointer-events: none; z-index: 0;
}
.aurora-1 {
  width: 600px; height: 600px; top: -200px; left: -100px;
  border-radius: 50%;
  background: radial-gradient(circle, oklch(0.4 0.18 300 / 0.5), transparent 70%);
  filter: blur(60px);
}
.aurora-2 {
  width: 700px; height: 700px; bottom: -300px; right: -200px;
  border-radius: 50%;
  background: radial-gradient(circle, oklch(0.4 0.16 240 / 0.4), transparent 70%);
  filter: blur(80px);
}
.noise {
  inset: 0; opacity: 0.03;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22><filter id=%22n%22><feTurbulence baseFrequency=%220.9%22/></filter><rect width=%22100%22 height=%22100%22 filter=%22url(%23n)%22/></svg>");
}

.wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; }

::selection { background: oklch(0.7 0.18 300 / 0.35); color: var(--text-primary); }

/* mono nano labels */
.kicker {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-quiet);
}
.kicker-accent { color: var(--accent); }

/* Hero */
.hero {
  background: var(--bg-elev-1);
  border: 1px solid var(--border-1);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  padding: 40px 44px;
  margin-bottom: 24px;
}
.hero-kicker { margin-bottom: 28px; }
.hero h1 {
  font-size: 48px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.05;
  margin-bottom: 20px;
}
.hero h1 .accent { color: var(--accent); }
.lede {
  font-size: 15px;
  line-height: 1.65;
  color: var(--text-secondary);
  max-width: 680px;
}
.lede em { color: var(--text-primary); font-style: normal; font-weight: 500; }
.meta-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 24px;
  margin-top: 36px;
  padding-top: 28px;
  border-top: 1px solid var(--border-1);
}
.meta-item .meta-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-quiet);
  margin-bottom: 8px;
}
.meta-item .meta-val {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.3px;
}
.meta-item.winner .meta-val { color: var(--accent); }

/* Sections */
.section {
  background: var(--bg-elev-1);
  border: 1px solid var(--border-1);
  backdrop-filter: blur(20px);
  border-radius: 12px;
  padding: 32px 36px;
  margin-bottom: 24px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-1);
}
.section-icon {
  color: var(--accent);
  font-size: 16px;
}
.section-num {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--text-quiet);
}
.section-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.section-aside {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-quiet);
}

/* Ranking */
.rank-row {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 18px;
  align-items: center;
  margin-bottom: 22px;
}
.rank-row:last-child { margin-bottom: 0; }
.rank-pos {
  font-family: var(--mono);
  font-size: 28px;
  font-weight: 500;
  color: var(--text-quiet);
  letter-spacing: -1px;
}
.rank-bar-wrap { display: flex; flex-direction: column; gap: 8px; }
.rank-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.rank-track {
  height: 28px;
  background: var(--bg-elev-1);
  border: 1px solid var(--border-2);
  border-radius: 8px;
  overflow: hidden;
  backdrop-filter: blur(10px);
}
.rank-fill {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 14px;
  border-radius: 7px;
  transition: width .6s ease;
}
.rank-val {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--bg-deep);
}
.rank-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
}
.rank-meta-err { color: oklch(0.7 0.16 30); }
.rank-meta-you { color: var(--accent); }

/* Speed */
.speed-row {
  display: grid;
  grid-template-columns: 100px 1fr 70px;
  gap: 16px;
  align-items: center;
  margin-bottom: 16px;
  font-size: 13px;
}
.speed-row:last-child { margin-bottom: 0; }
.speed-name {
  font-weight: 600;
  letter-spacing: 0.2px;
}
.speed-track {
  height: 8px;
  background: var(--bg-elev-1);
  border: 1px solid var(--border-2);
  border-radius: 4px;
  overflow: hidden;
}
.speed-fill {
  height: 100%;
  border-radius: 3px;
  opacity: 0.85;
  transition: width .6s ease;
}
.speed-val {
  font-family: var(--mono);
  font-size: 12px;
  text-align: right;
  color: var(--text-secondary);
  font-weight: 500;
}

/* Heatmap */
.heat-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 4px 4px;
}
.heat-table th {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  text-align: center;
  padding: 8px 4px 14px;
  color: var(--text-quiet);
  font-weight: 500;
}
.heat-table th:first-child { text-align: left; }
.heat-q {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary);
  padding: 10px 14px 10px 0 !important;
  max-width: 480px;
  border-bottom: 1px solid var(--border-1);
}
.heat-q-num {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-quiet);
  margin-right: 8px;
  letter-spacing: 1px;
}
.heat-cell {
  text-align: center;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  padding: 10px 4px;
  min-width: 70px;
  position: relative;
}
.heat-cell.empty {
  border: 1px dashed var(--border-2);
  background: transparent !important;
}
.heat-badge {
  display: inline-block;
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.5px;
  padding: 1px 5px;
  margin-left: 5px;
  background: var(--bg-deep);
  color: var(--text-primary);
  border-radius: 3px;
  vertical-align: 1px;
  font-weight: 500;
}
.legend {
  display: flex;
  gap: 18px;
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid var(--border-1);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-tertiary);
  align-items: center;
  flex-wrap: wrap;
}
.legend-swatch {
  display: inline-block;
  width: 14px; height: 14px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 7px;
}

/* Footer */
footer {
  margin-top: 48px;
  padding: 32px 36px;
  background: var(--bg-elev-1);
  border: 1px solid var(--border-1);
  backdrop-filter: blur(20px);
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.7;
}
footer p { margin-bottom: 12px; max-width: 720px; }
footer p:last-child { margin-bottom: 0; }
footer strong {
  color: var(--text-secondary);
  font-weight: 600;
}
footer .footer-stamp {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-quiet);
  text-transform: uppercase;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-1);
}
footer a { color: var(--accent); text-decoration: none; }

@media print {
  body { padding: 20px; }
  .aurora-1, .aurora-2 { display: none; }
  .section, .hero, footer { break-inside: avoid; }
}
</style>
</head>
<body>
<div class="aurora-1"></div>
<div class="aurora-2"></div>
<div class="noise"></div>
<div class="wrap">

<header class="hero">
  <div class="kicker hero-kicker">◐ &nbsp; CONSUMER CHATBOT PRODUCT BENCHMARK</div>
  <h1>${data.questionCount} questions, 4 chatbots,<br><span class="accent">one ranking.</span></h1>
  <p class="lede">Real questions sourced from <em>${data.source}</em>, sent through the consumer chat UIs of Claude, ChatGPT, Gemini and Grok. Answers judged by Gemini 3.1 Pro and Claude Opus 4.7 — with optional human override.</p>
  <div class="meta-row">
    <div class="meta-item"><div class="meta-label">run date</div><div class="meta-val">${data.runDate}</div></div>
    <div class="meta-item"><div class="meta-label">questions</div><div class="meta-val">${data.questionCount}</div></div>
    <div class="meta-item winner"><div class="meta-label">winner</div><div class="meta-val">${data.ranking[0].label}</div></div>
    <div class="meta-item"><div class="meta-label">winning score</div><div class="meta-val">${data.ranking[0].avg !== null ? data.ranking[0].avg.toFixed(2) : "—"}</div></div>
  </div>
</header>

<section class="section">
  <div class="section-head">
    <span class="section-icon">${ICONS.rank}</span>
    <span class="section-num">01 — RANKING</span>
    <span class="section-title">Quality</span>
    <span class="section-aside">avg(completeness, precision) · 0–10</span>
  </div>
  ${podium}
</section>

<section class="section">
  <div class="section-head">
    <span class="section-icon">${ICONS.speed}</span>
    <span class="section-num">02 — SPEED</span>
    <span class="section-title">Median response time</span>
    <span class="section-aside">submit → stream complete</span>
  </div>
  ${speedRows}
</section>

<section class="section">
  <div class="section-head">
    <span class="section-icon">${ICONS.heat}</span>
    <span class="section-num">03 — DETAIL</span>
    <span class="section-title">Per-question heatmap</span>
    <span class="section-aside">YOU = your override</span>
  </div>
  <table class="heat-table">
    <thead>
      <tr>
        <th>Question</th>
        ${CHATBOTS.map(cb => `<th style="color:${cbColors[cb]}">${CHATBOT_LABELS[cb]}</th>`).join("")}
      </tr>
    </thead>
    <tbody>${heatRows}</tbody>
  </table>
  <div class="legend">
    <span><span class="legend-swatch" style="background:oklch(0.72 0.18 300 / 0.85)"></span>≥ 8.5</span>
    <span><span class="legend-swatch" style="background:oklch(0.68 0.16 300 / 0.65)"></span>7–8.4</span>
    <span><span class="legend-swatch" style="background:oklch(0.60 0.13 300 / 0.45)"></span>5.5–6.9</span>
    <span><span class="legend-swatch" style="background:oklch(0.50 0.10 300 / 0.30)"></span>4–5.4</span>
    <span><span class="legend-swatch" style="background:oklch(0.40 0.08 300 / 0.20)"></span>&lt; 4</span>
    <span><span class="legend-swatch" style="background:transparent; border: 1px dashed var(--border-2)"></span>no answer</span>
  </div>
</section>

<footer>
  <p><strong>Method.</strong> Each question was generated from a Hacker News headline by Gemini 3.1 Pro, then sent through the actual consumer chat interfaces — not the API — to capture real product behaviour with system prompts, tools and web search included. Each answer was scored 0–10 on completeness and precision by two independent LLM judges (Gemini 3.1 Pro and Claude Opus 4.7); per-cell scores are the mean of both judges' average score, unless overridden by a human rating.</p>
  <p><strong>Caveats.</strong> N=${data.questionCount} is too small for strong statistical claims; consider this a directional snapshot. Speed includes streaming time, not just first-token latency. Quality scores reflect tech-news comprehension specifically, not coding, math, or other capability dimensions.</p>
  <div class="footer-stamp">Generated by <a href="#">Chatbot Product Benchmark v0.6.0</a> · ${new Date().toLocaleString()}</div>
</footer>

</div>
</body>
</html>`;
}

$("btn-infographic").addEventListener("click", () => {
  const data = buildInfographicData();
  if (!data) { log("err", "no results to render"); return; }
  const html = buildInfographicHtml(data);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = url; a.download = `chatbot-bench-infographic-${stamp}.html`; a.click();
  URL.revokeObjectURL(url);
  log("ok", "infographic exported");
});

// ===== run / messaging =====
$("btn-start").addEventListener("click", async () => {
  if (state.running) return;
  await saveKeys();

  const fileInput = $("question-file");
  let customQuestions = null;
  if (fileInput && fileInput.files.length > 0) {
    const file = fileInput.files[0];
    try {
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = e => reject(e);
        reader.readAsText(file);
      });
      customQuestions = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      if (customQuestions.length === 0) {
        log("err", "Uploaded file contains no valid questions.");
        return;
      }
    } catch (err) {
      log("err", "Failed to read custom questions file.");
      return;
    }
  }

  const config = {
    geminiKey: $("gemini-key")?.value?.trim() || "",
    claudeKey: $("claude-key")?.value?.trim() || "",
    source: $("source")?.value || "",
    count: parseInt($("count")?.value) || 10,
    maxWaitMs: (parseInt($("max-wait")?.value) || 300) * 1000,
    maxConcurrent: Math.max(1, Math.min(40, parseInt($("max-concurrent")?.value) || 8)),
    autoclose: $("autoclose") ? $("autoclose").checked : true,
    customQuestions,
    judgePrompt: $('judge-prompt')?.value?.trim() || DEFAULT_JUDGE_PROMPT,
    questionPrompt: $('question-prompt')?.value?.trim() || DEFAULT_QUESTION_PROMPT,
    systemMessage: $('system-message')?.value?.trim() || "",
  };
  if (!config.geminiKey) { log("err", "Gemini API key missing"); return; }
  if (!config.claudeKey) { log("err", "Anthropic API key missing"); return; }

  state.running = true;
  state.results = [];
  $("results-body").innerHTML = "";
  $("phases").classList.remove("hidden");
  $("btn-start").disabled = true;
  $("btn-export").classList.add("hidden");
  $("btn-infographic").classList.add("hidden");
  setStatus("running", "running");
  log("info", `starting · ${config.count} questions · source=${config.source}`);

  // open port
  const port = chrome.runtime.connect({ name: "dashboard" });
  state.port = port;
  port.onMessage.addListener(msg => handleBgMessage(msg));
  port.onDisconnect.addListener(() => {
    state.running = false;
    $("btn-start").disabled = false;
    if (state.results.length > 0) {
      $("btn-export").classList.remove("hidden");
      $("btn-infographic").classList.remove("hidden");
    }
  });
  port.postMessage({ type: "START_BENCHMARK", config });
});

function handleBgMessage(msg) {
  switch (msg.type) {
    case "LOG": log(msg.payload.level, msg.payload.msg); break;
    case "PHASE": updatePhase(msg.payload.phase, msg.payload.done, msg.payload.total); break;
    case "QUESTIONS_READY":
      state.questions = msg.payload.questions;
      log("ok", `${msg.payload.questions.length} questions ready`);
      break;
    case "PARTIAL_RESULT":
      state.results[msg.payload.index] = msg.payload.result;
      renderResultRow(msg.payload.index, msg.payload.result);
      break;
    case "RESULTS":
      log("ok", "all done");
      setStatus("done", "done");
      $("btn-export").classList.remove("hidden");
      $("btn-infographic").classList.remove("hidden");
      $("btn-blind-judge").classList.remove("hidden");
      $("btn-rejudge").classList.remove("hidden");
      break;
    case "DONE":
      state.running = false;
      $("btn-start").disabled = false;
      $("btn-export").classList.remove("hidden");
      $("btn-infographic").classList.remove("hidden");
      $("btn-blind-judge").classList.remove("hidden");
      $("btn-rejudge").classList.remove("hidden");
      break;
    case "ERROR":
      log("err", msg.payload.message);
      setStatus("error", "error");
      break;
  }
}

// ===== re-judge mode =====
$("btn-rejudge").addEventListener("click", async () => {
  if (state.running) return;
  const validResults = state.results.filter(Boolean);
  if (validResults.length === 0) { log("err", "no results to re-judge"); return; }

  await saveKeys();
  const config = {
    geminiKey: $("gemini-key")?.value?.trim() || "",
    claudeKey: $("claude-key")?.value?.trim() || "",
    judgePrompt: $("judge-prompt")?.value?.trim() || DEFAULT_JUDGE_PROMPT,
  };
  if (!config.geminiKey) { log("err", "Gemini API key missing"); return; }
  if (!config.claudeKey) { log("err", "Anthropic API key missing"); return; }

  state.running = true;
  $("btn-start").disabled = true;
  $("btn-rejudge").disabled = true;
  setStatus("re-judging", "running");
  log("info", `re-judging ${validResults.length} questions with current prompt`);

  const port = chrome.runtime.connect({ name: "dashboard" });
  state.port = port;
  port.onMessage.addListener(msg => handleBgMessage(msg));
  port.onDisconnect.addListener(() => {
    state.running = false;
    $("btn-start").disabled = false;
    $("btn-rejudge").disabled = false;
  });
  port.postMessage({ type: "REJUDGE", config, results: state.results });
});

// ===== blind judge mode =====
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function openBlindModal(index) {
  const validResults = state.results.filter(Boolean);
  if (validResults.length === 0) return;
  if (index < 0) index = 0;
  if (index >= validResults.length) index = validResults.length - 1;

  state.blindIndex = index;
  const r = validResults[index];

  // Create a new mapping for this question, or use an existing one if we want consistency
  // Here we re-shuffle every time we open a question to prevent guessing
  state.blindMapping = shuffleArray(CHATBOTS);

  $("blind-q-text").textContent = `[${index + 1}/${validResults.length}] ` + r.question;
  $("blind-status-msg").textContent = "";

  const container = $("blind-cols-container");
  container.innerHTML = "";

  state.blindMapping.forEach((cb, ci) => {
    const a = r.answers.find(x => x.chatbot === cb);
    const k = ratingKey(r.question, cb);
    const existing = state.userRatings[k];

    // Default to existing rating, or the judge average if we want a baseline, or just 5.
    // We'll use 5 as default to avoid biasing the human judge.
    const cVal = existing?.completeness ?? 5;
    const pVal = existing?.precision ?? 5;
    const notes = existing?.notes || "";
    const isSaved = !!existing?.savedAt;

    const ansText = (a && !a.error && a.answer) ? a.answer : `(No answer generated / Error: ${a?.error || "Unknown"})`;

    const colHtml = `
      <div class="blind-col">
        <div class="blind-col-head">Model ${String.fromCharCode(65 + ci)} ${isSaved ? '<span style="color:var(--green)">✓ saved</span>' : ''}</div>
        <div class="blind-col-pre">${escapeHtml(ansText)}</div>
        <div class="blind-col-rating">
          <div class="slider-row">
            <label>complete</label>
            <input type="range" id="b-comp-${ci}" min="0" max="10" step="1" value="${cVal}">
            <span class="slider-val" id="b-comp-val-${ci}">${cVal}</span>
          </div>
          <div class="slider-row">
            <label>precise</label>
            <input type="range" id="b-prec-${ci}" min="0" max="10" step="1" value="${pVal}">
            <span class="slider-val" id="b-prec-val-${ci}">${pVal}</span>
          </div>
          <textarea id="b-notes-${ci}" rows="2" placeholder="Notes (optional)"></textarea>
        </div>
      </div>
    `;
    container.insertAdjacentHTML("beforeend", colHtml);
    $("b-notes-" + ci).value = notes;

    // Live update slider values
    $("b-comp-" + ci).addEventListener("input", e => $("b-comp-val-" + ci).textContent = e.target.value);
    $("b-prec-" + ci).addEventListener("input", e => $("b-prec-val-" + ci).textContent = e.target.value);
  });

  $("blind-modal-bg").classList.add("open");
}

$("btn-blind-judge").addEventListener("click", () => openBlindModal(0));
$("btn-blind-prev").addEventListener("click", () => openBlindModal(state.blindIndex - 1));
$("btn-blind-next").addEventListener("click", () => openBlindModal(state.blindIndex + 1));
$("btn-blind-close").addEventListener("click", () => {
  $("blind-modal-bg").classList.remove("open");
});

$("btn-blind-save").addEventListener("click", async () => {
  const validResults = state.results.filter(Boolean);
  if (validResults.length === 0) return;
  const r = validResults[state.blindIndex];

  // Read and save all 4 columns
  state.blindMapping.forEach((cb, ci) => {
    const k = ratingKey(r.question, cb);
    const cVal = parseInt($("b-comp-" + ci).value);
    const pVal = parseInt($("b-prec-" + ci).value);
    const notes = $("b-notes-" + ci).value.trim();

    state.userRatings[k] = {
      completeness: cVal,
      precision: pVal,
      notes: notes,
      savedAt: Date.now()
    };
  });

  await persistUserRatings();

  // Re-render the affected row in the main table
  const origIdx = state.results.indexOf(r);
  if (origIdx >= 0) renderResultRow(origIdx, r);

  $("blind-status-msg").textContent = "✓ Ratings saved!";
  $("blind-status-msg").style.color = "var(--green)";

  // Auto-advance after a short delay
  setTimeout(() => {
    if (state.blindIndex < validResults.length - 1) {
      openBlindModal(state.blindIndex + 1);
    }
  }, 400);
});
