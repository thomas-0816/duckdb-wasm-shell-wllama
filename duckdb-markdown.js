import { escapeHtml } from "./duckdb-utils.js";

// ---------------------------------------------------------------------------
// Tiny, safe Markdown renderer (enough for chat output)
// ---------------------------------------------------------------------------

function duckdbDocsUrl(href) {
  // The bundled manual uses internal anchors such as
  // "#docs:2.0:sql:statements:pivot::simplified-pivot-syntax".
  const body = href.slice("#docs:".length);
  const [pathPart, section] = body.split("::");
  const segments = pathPart.split(":");
  const page = segments[segments.length - 1];
  const anchor = section && section !== page ? `#${section}` : "";
  return `https://duckdb.org/docs/${segments.join("/")}${anchor}`;
}

function inlineMarkdown(text) {
  const codes = [];
  let s = escapeHtml(text);

  // Protect inline code before applying emphasis / links.
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // Links (http/https and DuckDB manual anchors, so no javascript: URLs).
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#docs:[^\s)]+)\)/g, (_, label, href) => {
    const url = href.startsWith("#docs:") ? duckdbDocsUrl(href) : href;
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  // Shell results use <br> inside table cells.
  s = s.replace(/&lt;br\s*\/?&gt;/gi, "<br>");

  // Restore inline code.
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);

  return s;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      current += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += s[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function renderMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1] || "";
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(`<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].replace(/\s*\{#[^}]+\}\s*$/, "");
      out.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    // Markdown table.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        `<div class="md-table-wrap"><table><thead><tr>${
          header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")
        }</tr></thead><tbody>${
          rows.map((row) => `<tr>${
            header.map((_, index) => `<td>${inlineMarkdown(row[index] ?? "")}</td>`).join("")
          }</tr>`).join("")
        }</tbody></table></div>`
      );
      continue;
    }

    // Lists.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    paragraph.push(line);
    i++;
  }

  flushParagraph();
  return out.join("\n");
}
