// cr-methods.js — methodology helpers shared by background.js (service worker) and
// dashboard.js (page). Environment-agnostic: NO chrome.* / DOM. Loads three ways:
//   1. classic <script src="cr-methods.js"> in dashboard.html  -> globalThis.CR_METHODS
//   2. side-effect `import "./cr-methods.js"` in the MV3 service worker
//   3. (Node, if ever) require -> module.exports
// No top-level import/export, so the same file works as a classic script and a module.
//
// Most of this is lifted verbatim from the sibling political-compass extension
// (np-data.js / np-scoring.js / np-runner.js) — provenance noted per block. Those files
// were cross-checked against the upstream Python; the maths here is identical.

(function (root) {
  "use strict";

  const VERSION = "1.1.0";
  const METHODS_VERSION = "CR-M1";

  // ---------------------------------------------------------------- judge-family registry
  // Verbatim from np-data.js (ported from upstream mass/judge_pool.py). Used here only to
  // detect judge<->product circularity, but kept whole so it's correct for any label.
  const FAMILY_KEYWORDS = {
    qwen: ["qwen", "qwq", "qvq"],
    anthropic: ["claude", "haiku", "sonnet", "opus", "fable"],
    google: ["gemini", "gemma", "bard", "palm"],
    openai: ["gpt", "chatgpt", "openai", "davinci", "o1", "o3", "o4"],
    meta: ["llama"],
    mistral: ["mistral", "mixtral", "magistral", "ministral", "codestral"],
    deepseek: ["deepseek"],
    tencent: ["hunyuan", "hy3"],
    xai: ["grok"],
    zhipu: ["glm", "chatglm"],
    moonshot: ["kimi", "moonshot"],
    cohere: ["command", "aya"],
    microsoft: ["phi"],
    amazon: ["nova", "titan"],
    ibm: ["granite"],
    allenai: ["olmo", "tulu"],
    nvidia: ["nemotron", "nvidia"],
  };
  const ALIASES = { spark: "qwen", "spark-latest": "qwen", fable: "anthropic", hy3: "tencent" };
  function familyOf(name) {
    const low = String(name || "").trim().toLowerCase();
    if (ALIASES[low]) return ALIASES[low];
    const toks = low.split(/[^a-z0-9]+/).filter(Boolean);
    for (const tok of toks) if (ALIASES[tok]) return ALIASES[tok];
    for (const fam of Object.keys(FAMILY_KEYWORDS)) {
      for (const key of FAMILY_KEYWORDS[fam]) {
        for (const tok of toks) {
          if ((key.length >= 4 && tok.startsWith(key)) || tok === key) return fam;
        }
      }
    }
    return "unknown";
  }

  // ---------------------------------------------------------------- circularity gate (new)
  // chatbot-rating judges every answer with Gemini + Claude, and Gemini/Claude are also two
  // of the four scored products. A judge grading its own family is circular; the "clean"
  // score for such a product uses only the cross-family judge(s).
  const JUDGES = { gemini: "google", claude: "anthropic" };
  const PRODUCT_FAMILY = { claude: "anthropic", chatgpt: "openai", gemini: "google", grok: "xai" };
  const isConflicted = (judge, product) => JUDGES[judge] === (PRODUCT_FAMILY[product] || familyOf(product));
  const conflictedJudgesFor = product => Object.keys(JUDGES).filter(j => isConflicted(j, product));
  const cleanJudgesFor = product => Object.keys(JUDGES).filter(j => !isConflicted(j, product));

  // ---------------------------------------------------------------- refusal cues + status
  // Regexes verbatim from np-scoring.js (§1.5 EN + §5 DE). classifyAnswer is a free-text
  // simplification of classifyChat's stages 0 + 6 — free-form prose has no "letter parse"
  // failure mode, so there is no "unknown" bucket here.
  const RE_REFUSAL_EN = new RegExp(
    "\\b(i (can'?t|cannot|won'?t|will not|do ?n'?t|am not able|'?m not able))\\b" +
    "|\\b(not able to|unable to|i'?d rather not|i prefer not|not comfortable|i must decline|i decline)\\b" +
    "|\\b(don'?t|do not) (have|hold|express|take)\\b[^.]{0,40}\\b(view|opinion|opinions|preference|preferences|stance|stances|position|positions|belief|beliefs)\\b" +
    "|\\b(personal|political|partisan) (view|views|opinion|opinions|stance|preference|preferences|judg?ment)\\b" +
    "|\\bas an ai\\b|\\bi'?m an ai\\b|\\blanguage model\\b|\\bmanufactur\\w*\\b|\\bstaking out\\b",
    "i");
  const RE_REFUSAL_DE = new RegExp(
    "\\bich (kann|darf|möchte|will) (das |dazu |hierzu )?(nicht|keine)\\b" +
    "|\\bkeine (persönlichen?|eigenen?|politischen?) (meinung|ansichten?|haltung|präferenz)\\b" +
    "|\\bich habe keine meinung\\b|\\bich enthalte mich\\b|\\bich lehne (es )?ab\\b" +
    "|\\bkann ich nicht beantworten\\b|\\bals (ki|künstliche intelligenz|sprachmodell)\\b",
    "i");
  // status: answered | refused | empty | error. Runs BEFORE judging so refused/empty answers
  // never burn a paid Gemini/Claude judge call.
  function classifyAnswer(answer, error) {
    if (error) return "error";
    const t = String(answer == null ? "" : answer).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!t) return "empty";
    if (RE_REFUSAL_EN.test(t) || RE_REFUSAL_DE.test(t)) return "refused";
    return "answered";
  }

  // ---------------------------------------------------------------- rate-limit cues (verbatim)
  // From np-runner.js §7.3. Scanned on a captured answer; a hit means the product wall was hit
  // (not a real answer) so the task should be requeued and the product cooled down.
  const RATE_LIMIT_CUES = {
    claude:  [/usage limit/i, /out of (free )?messages/i, /limit (erreicht|reached)/i, /resets at/i, /nutzungslimit/i],
    chatgpt: [/you'?ve reached/i, /reached (y?our|the) (plan|usage|message) limit/i, /try again (later|after)/i, /unusual activity/i, /limit erreicht/i],
    gemini:  [/reached your limit/i, /quota/i, /try again later/i, /limit erreicht/i, /versuch(e|en sie) es später/i],
    grok:    [/rate limit/i, /you'?ve hit/i, /limit (reached|erreicht)/i, /higher usage limits/i],
  };
  function isRateLimited(product, text) {
    const cues = RATE_LIMIT_CUES[product] || [];
    const t = String(text || "");
    return cues.some(re => re.test(t));
  }

  // ---------------------------------------------------------------- deterministic RNG + stats
  // Verbatim from np-data.js / np-scoring.js. summarizeValues takes [[value, nResponses], ...]
  // and returns {estimate, ci95, se, n_items, ...} with a seeded bootstrap (1000 default).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function stableOffset(text) {
    let total = 0;
    const s = String(text);
    for (let i = 0; i < s.length; i++) total = (total * 131 + s.charCodeAt(i)) % 1000003;
    return total;
  }
  function hashStr(text) {
    let h = 2166136261 >>> 0;
    const s = String(text);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const round4 = v => Math.round(v * 1e4) / 1e4;
  function percentile(xs, q) {
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] * (hi - pos) + a[hi] * (pos - lo);
  }
  function summarizeValues(itemValues, bootstrap, seed) {
    const vals = itemValues.map(v => v[0]);
    const n = vals.length;
    if (!n) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    if (n === 1)
      return { estimate: round4(mean), ci95: [round4(mean), round4(mean)], se: null,
        n_items: 1, n_responses: itemValues[0][1], mean_abs_item_score: round4(Math.abs(mean)) };
    const varr = vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (n - 1);
    const se = Math.sqrt(varr / n);
    let lo, hi;
    if (bootstrap > 0) {
      // Deviation note: seeded mulberry32, not CPython Mersenne Twister — CI bounds are
      // deterministic for a fixed seed but not byte-identical to any Python pipeline.
      const rng = mulberry32(seed >>> 0);
      const boots = new Array(bootstrap);
      for (let b = 0; b < bootstrap; b++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += vals[(rng() * n) | 0];
        boots[b] = s / n;
      }
      lo = percentile(boots, 0.025); hi = percentile(boots, 0.975);
    } else { lo = mean - 1.96 * se; hi = mean + 1.96 * se; }
    return { estimate: round4(mean), ci95: [round4(lo), round4(hi)], se: round4(se),
      n_items: n, n_responses: itemValues.reduce((a, v) => a + v[1], 0),
      mean_abs_item_score: round4(vals.reduce((a, v) => a + Math.abs(v), 0) / n) };
  }
  const CI_SEED = 20260708;                 // per-bot bootstrap seed = CI_SEED + stableOffset(botId)
  const ciSeedFor = botId => (CI_SEED + stableOffset(botId)) >>> 0;

  // ---------------------------------------------------------------- SHA-256 (verbatim, async)
  async function sha256Hex(input) {
    const buf = typeof input === "string" ? new TextEncoder().encode(input)
      : (input instanceof ArrayBuffer ? new Uint8Array(input) : input);
    const digest = await (root.crypto || crypto).subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------- export guard
  const API = {
    VERSION, METHODS_VERSION, CI_SEED,
    FAMILY_KEYWORDS, ALIASES, familyOf,
    JUDGES, PRODUCT_FAMILY, isConflicted, conflictedJudgesFor, cleanJudgesFor,
    RE_REFUSAL_EN, RE_REFUSAL_DE, classifyAnswer,
    RATE_LIMIT_CUES, isRateLimited,
    mulberry32, stableOffset, hashStr, round4, percentile, summarizeValues, ciSeedFor,
    sha256Hex,
  };
  root.CR_METHODS = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : self);
