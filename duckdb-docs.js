import { escapeRegExp } from "./duckdb-utils.js";

// ---------------------------------------------------------------------------
// Bundled DuckDB manual search (duckdb-docs.txt + duckdb-docs-index.json)
// ---------------------------------------------------------------------------

const DOCS_URL = "./duckdb-docs.txt";
const DOCS_INDEX_URL = "./duckdb-docs-index.json";
const DOCS_MAX_RESULTS = 4;
const DOCS_SNIPPET_CHARS = 1600;

// Short or ambiguous terms are checked against every section so arbitrary
// substring queries behave exactly like the original full scan. Longer,
// unambiguous terms use the postings index instead.
const DOCS_INDEX_TERM_SCAN = 5;
const DOCS_INDEX_SHORT_TERM_SCAN = 6;
const DOCS_INDEX_SHORT_UNDERSCORE_SCAN = 10;
const DOCS_TOKEN_RE = /^[a-z0-9_]+$/;

let docsPromise = null;

const docsCount = (haystack, needle) => {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
};

const docsTerms = (query) => {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = re.exec(String(query || ""))) !== null) {
    const term = (match[1] || match[2] || "").trim().toLowerCase();
    if (term) terms.push(term);
  }
  return [...new Set(terms)].slice(0, 8);
};

const titleHasTerm = (title, term) => {
  if (term.includes(" ")) return title.includes(term);
  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(term)}([^a-z0-9_]|$)`, "i");
  return pattern.test(title);
};

const lowerBound = (values, target) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const docsBody = (state, section) => {
  let body = state.bodyCache.get(section.id);
  if (body === undefined) {
    body = state.lines.slice(section.start, section.end).join("\n");
    state.bodyCache.set(section.id, body);
  }
  return body;
};

const docsLower = (state, section) => {
  let lower = state.lowerCache.get(section.id);
  if (lower === undefined) {
    lower = docsBody(state, section).toLowerCase();
    state.lowerCache.set(section.id, lower);
  }
  return lower;
};

// Return the section ids that can contain a term, or null to mean "scan every
// section". The runtime verifies candidates with indexOf, so postings and
// prefix expansion only need to be a superset of the actual matches.
const docsCandidates = (state, term, heuristic) => {
  const cacheKey = `${heuristic ? "h" : "b"}:${term}`;
  if (state.candidateCache.has(cacheKey)) {
    return state.candidateCache.get(cacheKey);
  }

  let scan = term.length < DOCS_INDEX_TERM_SCAN || !DOCS_TOKEN_RE.test(term);
  if (!scan && heuristic) {
    // These can be infixes of longer words (for example "elect" in "select"),
    // so exact results require the full scan.
    if (term.length <= DOCS_INDEX_SHORT_TERM_SCAN) scan = true;
    else if (/[0-9]/.test(term)) scan = true;
    else if (term.includes("_") && term.length <= DOCS_INDEX_SHORT_UNDERSCORE_SCAN) scan = true;
  }

  let candidates = null;
  if (!scan) {
    const ids = new Set();
    const addList = (list) => {
      if (list) for (const id of list) ids.add(id);
    };
    addList(state.termMap.get(term));

    let position = lowerBound(state.vocabulary, term);
    let hasLongerPrefix = false;
    while (
      position < state.vocabulary.length &&
      state.vocabulary[position].startsWith(term)
    ) {
      if (state.vocabulary[position] !== term) {
        addList(state.termMap.get(state.vocabulary[position]));
        hasLongerPrefix = true;
      }
      position++;
    }

    if (ids.size === 0 || (heuristic && hasLongerPrefix)) scan = true;
    else candidates = ids;
  }

  if (scan) candidates = null;
  state.candidateCache.set(cacheKey, candidates);
  return candidates;
};

const docsSnippet = (body, terms) => {
  const bodyLines = body.split("\n").slice(1);
  if (bodyLines.length === 0) return "";
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const lower = bodyLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score += term.includes(" ") ? 3 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  const isFence = (line) => /^\s*```/.test(line);
  const countFences = (from, to) => {
    let count = 0;
    for (let i = from; i < to; i++) if (isFence(bodyLines[i])) count++;
    return count;
  };

  let start = Math.max(0, bestIndex - 4);
  let end = Math.min(bodyLines.length, bestIndex + 12);

  // Keep fenced code blocks balanced. A snippet that starts or ends inside a
  // fence makes the renderer treat the following markdown as code.
  if (countFences(0, start) % 2 === 1) {
    for (let i = start - 1; i >= 0; i--) {
      if (isFence(bodyLines[i])) {
        start = i;
        break;
      }
    }
  }
  let closeFence = false;
  if (countFences(start, end) % 2 === 1) {
    let closed = false;
    for (let i = end; i < bodyLines.length; i++) {
      if (isFence(bodyLines[i])) {
        end = i + 1;
        closed = true;
        break;
      }
    }
    closeFence = !closed;
  }

  let snippet = bodyLines.slice(start, end).join("\n").trim();
  if (closeFence) snippet += "\n```";
  if (snippet.length > DOCS_SNIPPET_CHARS) {
    snippet = snippet.slice(0, DOCS_SNIPPET_CHARS).trimEnd();
    const fences = (snippet.match(/^\s*```/gm) || []).length;
    if (fences % 2 === 1) snippet += "\n```";
    snippet += "\n…";
  }
  return snippet;
};

async function loadDuckDBDocs() {
  if (!docsPromise) {
    docsPromise = (async () => {
      const [docsResponse, indexResponse] = await Promise.all([
        fetch(DOCS_URL, { cache: "force-cache" }),
        fetch(DOCS_INDEX_URL, { cache: "force-cache" }),
      ]);
      if (!docsResponse.ok) {
        throw new Error(`could not load ${DOCS_URL} (HTTP ${docsResponse.status})`);
      }
      if (!indexResponse.ok) {
        throw new Error(`could not load ${DOCS_INDEX_URL} (HTTP ${indexResponse.status})`);
      }

      const [text, index] = await Promise.all([
        docsResponse.text(),
        indexResponse.json(),
      ]);
      const lines = text.split(/\r?\n/);
      const sections = index.sections.map(
        ([title, anchor, level, start, lineCount, length, hasBody], id) => ({
          id,
          title,
          titleLower: title.toLowerCase(),
          anchor,
          level,
          start,
          end: start + lineCount,
          length,
          hasBody: !!hasBody,
        })
      );

      return {
        lines,
        sections,
        termMap: new Map(index.terms),
        vocabulary: index.terms.map(([term]) => term),
        bodyCache: new Map(),
        lowerCache: new Map(),
        candidateCache: new Map(),
      };
    })().catch((error) => {
      docsPromise = null;
      throw error;
    });
  }
  return docsPromise;
}

// Warm the manual and its index while the browser is idle. Failures are
// non-fatal: the next search retries because loadDuckDBDocs resets its promise.
export function preloadDuckDBDocs() {
  return loadDuckDBDocs().then(
    () => true,
    () => false
  );
}

export async function searchDuckDBDocs(query) {
  const baseTerms = docsTerms(query);
  if (baseTerms.length === 0) {
    return "Error: provide at least one keyword to search the DuckDB manual.";
  }
  const state = await loadDuckDBDocs();
  const { sections } = state;

  // Expand identifiers such as read_csv_auto into softer variants
  // (read_csv, read, csv, auto) so the manual's read_csv pages still match.
  const entryMap = new Map();
  const addEntry = (term, weight, source) => {
    const existing = entryMap.get(term);
    if (!existing || existing.weight < weight) {
      entryMap.set(term, { term, weight, source });
    }
  };
  for (const term of baseTerms) {
    addEntry(term, 1, term);
    if (term.endsWith("_auto")) addEntry(term.slice(0, -5), 0.4, term);
    if (term.includes("_")) {
      for (const part of term.split("_")) {
        if (part.length >= 3) addEntry(part, 0.25, term);
      }
    }
  }
  const entries = [...entryMap.values()];

  // Inverse document frequency: rare terms are more informative.
  const weights = new Map();
  const sectionHits = new Map();
  const coverage = new Map(baseTerms.map((term) => [term, new Map()]));

  for (const entry of entries) {
    const candidates = docsCandidates(
      state,
      entry.term,
      entry.source === entry.term
    );
    let documentFrequency = 0;
    const hits = [];
    const collect = (id) => {
      const count = docsCount(docsLower(state, sections[id]), entry.term);
      if (count === 0) return;
      documentFrequency++;
      hits.push(id, count);
    };

    if (candidates === null) {
      for (const section of sections) collect(section.id);
    } else {
      for (const id of candidates) collect(id);
    }

    weights.set(
      entry.term,
      Math.log((sections.length + 1) / (documentFrequency + 1)) + 1
    );
    const sourceCoverage = coverage.get(entry.source);

    for (let index = 0; index < hits.length; index += 2) {
      const id = hits[index];
      const count = hits[index + 1];
      const weight = weights.get(entry.term) * entry.weight;
      const accumulator = sectionHits.get(id) || { matchScore: 0 };
      accumulator.matchScore += weight * (1 + Math.log1p(count));
      if (titleHasTerm(sections[id].titleLower, entry.term)) {
        accumulator.matchScore += weight * 12;
      }
      sectionHits.set(id, accumulator);
      if (entry.weight > (sourceCoverage.get(id) || 0)) {
        sourceCoverage.set(id, entry.weight);
      }
    }
  }

  const phrase = baseTerms.join(" ");
  const scored = [];
  for (const [id, accumulator] of sectionHits) {
    const section = sections[id];
    if (!section.hasBody) continue;

    let coverageScore = 0;
    for (const term of baseTerms) {
      coverageScore += coverage.get(term).get(id) || 0;
    }
    if (coverageScore === 0) continue;

    // Favor sections that cover every keyword and are focused, not giant
    // API references that merely mention the words many times.
    coverageScore = (coverageScore / baseTerms.length) * 100;
    const lengthFactor = 1 / Math.sqrt(1 + section.length / 4000);
    let score = accumulator.matchScore * 10 * lengthFactor + coverageScore;
    if (section.titleLower.includes(phrase)) score += 300;
    else if (baseTerms.every((term) => titleHasTerm(section.titleLower, term))) {
      score += 150;
    }
    score += (6 - Math.min(section.level, 6)) * 10;
    if (!section.anchor) score -= 100;
    scored.push({ section, score });
  }

  scored.sort((a, b) => b.score - a.score || a.section.length - b.section.length);
  const top = scored.slice(0, DOCS_MAX_RESULTS);
  if (top.length === 0) {
    return `No matches for "${query}" in duckdb-docs.txt. Try a function name, a statement (e.g. PIVOT), or an error message.`;
  }

  const snippetTerms = [...new Set(entries.map((entry) => entry.term))];
  const parts = top.map(({ section }) => {
    const anchor = section.anchor ? ` {#${section.anchor}}` : "";
    const snippet = docsSnippet(docsBody(state, section), snippetTerms);
    return `### ${section.title}${anchor}\n\n${snippet || "(no body text)"}`;
  });

  return `DuckDB manual results for "${query}" (from duckdb-docs.txt):\n\n${parts.join("\n\n---\n\n")}`;
}
