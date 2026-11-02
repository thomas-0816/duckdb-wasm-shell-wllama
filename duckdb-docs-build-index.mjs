// Build the compact help-search index used by duckdb-docs.js.
//
// Run with: npm run build:docs-index
//
// The index keeps only section metadata and token postings. Section bodies
// stay in duckdb-docs.txt and are sliced lazily at query time, which keeps the
// first search fast and avoids lowercasing the whole manual up front.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsPath = resolve(here, "duckdb-docs.txt");
const indexPath = resolve(here, "duckdb-docs-index.json");

const headingRe = /^(#{1,6})\s+(.+?)(?:\s+\{#([^}]+)\})?\s*$/;

// A token such as read_csv_auto also contributes its underscore-separated
// forms (read_csv, read, csv, auto, csv_auto, ...). This lets the runtime
// find the manual's CSV pages from a function-name query.
const formsForToken = (token) => {
  const forms = [token];
  if (token.includes("_")) {
    const parts = token.split("_");
    for (let start = 0; start < parts.length; start++) {
      let form = "";
      for (let end = start; end < parts.length; end++) {
        form += (end > start ? "_" : "") + parts[end];
        if (form !== token && form.length >= 2) forms.push(form);
      }
    }
  }
  return forms;
};

const text = readFileSync(docsPath, "utf8");
const lines = text.split(/\r?\n/);
const sections = [];
let current = { title: "DuckDB Manual", anchor: "", level: 1, start: 0 };

for (let line = 0; line < lines.length; line++) {
  const match = headingRe.exec(lines[line]);
  if (!match) continue;
  current.end = line;
  sections.push(current);
  current = {
    title: match[2].trim(),
    anchor: match[3] || "",
    level: match[1].length,
    start: line,
  };
}
current.end = lines.length;
sections.push(current);

const postings = new Map();
for (let id = 0; id < sections.length; id++) {
  const section = sections[id];
  const body = lines.slice(section.start, section.end).join("\n");
  const lower = body.toLowerCase();
  const forms = new Set();
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    for (const form of formsForToken(match[0])) forms.add(form);
  }
  for (const form of forms) {
    let list = postings.get(form);
    if (!list) postings.set(form, (list = []));
    list.push(id);
  }
  section.lowerLength = lower.length;
  section.hasBody = lines
    .slice(section.start + 1, section.end)
    .some((line) => line.trim().length > 0);
}

const index = {
  version: 1,
  sections: sections.map((section) => [
    section.title,
    section.anchor,
    section.level,
    section.start,
    section.end - section.start,
    section.lowerLength,
    section.hasBody ? 1 : 0,
  ]),
  terms: [...postings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
};

const json = JSON.stringify(index);
writeFileSync(indexPath, `${json}\n`);

const postingCount = index.terms.reduce((total, [, list]) => total + list.length, 0);
console.log(
  `Wrote ${indexPath}: ${sections.length} sections, ${index.terms.length} terms, ` +
    `${postingCount} postings, ${(json.length / 1048576).toFixed(2)} MB`
);
