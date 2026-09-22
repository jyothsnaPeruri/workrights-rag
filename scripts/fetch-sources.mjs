// Step 0 of the RAG pipeline: build the knowledge base.
// Downloads each page listed in sources.json from fairwork.gov.au, keeps only
// the main article text, and saves it as a Markdown file with metadata on top.
// Re-run this any time to refresh the knowledge base (rules and pay rates change).

import { readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const SITE = "https://www.fairwork.gov.au";
const OUT_DIR = new URL("../knowledge-base/", import.meta.url);
const sources = JSON.parse(await readFile(new URL("./sources.json", import.meta.url), "utf8"));

// Sections that are navigation, not knowledge. Left in, they would be chunked and
// embedded like real content and pollute the search results.
const SKIP_SECTIONS = /^(on this page|video|tools and resources|related information)/i;

const clean = (text) => text.replace(/\s+/g, " ").trim();

function toMarkdown($, body) {
  // 1. Remove noise elements.
  body
    .find(".definition_preview, .industry-filter, article.media, .link-list, script, style, img, iframe, form, select, button")
    .remove();
  // Leftovers from interactive widgets that render as plain text in the HTML.
  const NOISE_TEXT = /selecting from the list below|embedded filter placeholder/i;
  body.find("p, div, span").each((_, el) => {
    const text = clean($(el).text());
    if (text && text.length < 200 && NOISE_TEXT.test(text)) $(el).remove();
  });

  // 2. Remove whole navigation sections (the heading and everything up to the next h2).
  body.find("h2").each((_, h2) => {
    if (!SKIP_SECTIONS.test(clean($(h2).text()))) return;
    $(h2).nextUntil("h2").remove();
    $(h2).remove();
  });

  // 3. Convert what is left to simple Markdown, keeping headings: the chunker
  //    will use them later to keep each chunk about one topic.
  const lines = [];
  const list = (el, depth) => {
    $(el).children("li").each((_, li) => {
      const own = $(li).clone();
      own.find("ul, ol").remove();
      const text = clean(own.text());
      if (text) lines.push(`${"  ".repeat(depth)}- ${text}`);
      $(li).children("ul, ol").each((_, nested) => list(nested, depth + 1));
    });
  };
  const walk = (el) => {
    $(el).children().each((_, child) => {
      const tag = child.tagName.toLowerCase();
      const text = clean($(child).text());
      if (/^h[2-5]$/.test(tag)) {
        if (text) lines.push("", `${"#".repeat(Number(tag[1]))} ${text}`, "");
      } else if (tag === "p") {
        if (text) lines.push(text, "");
      } else if (tag === "ul" || tag === "ol") {
        list(child, 0);
        lines.push("");
      } else if (tag === "table") {
        $(child).find("tr").each((_, row) => {
          lines.push(`| ${$(row).children().map((_, cell) => clean($(cell).text())).get().join(" | ")} |`);
        });
        lines.push("");
      } else {
        walk(child);
      }
    });
  };
  walk(body);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const today = new Date().toISOString().slice(0, 10);
const summary = [];

for (const { file, path } of sources) {
  const url = SITE + path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);

  const $ = cheerio.load(await response.text());
  const title = clean($("title").text()).replace(/ - Fair Work Ombudsman$/, "");
  const body = $("article .field--name-body").first();
  const text = toMarkdown($, body);
  if (text.length < 500) throw new Error(`Suspiciously little text (${text.length} chars) for ${url}`);

  const frontmatter = ["---", `title: ${title}`, `url: ${url}`, `saved: ${today}`, "---"].join("\n");
  await writeFile(new URL(`${file}.md`, OUT_DIR), `${frontmatter}\n\n# ${title}\n\n${text}\n`);

  summary.push({ file: `${file}.md`, title, url, chars: text.length });
  console.log(`saved ${file}.md (${text.length} chars)`);
  await new Promise((resolve) => setTimeout(resolve, 1000)); // be polite: one request per second
}

// SOURCES.md is the attribution record required by the CC BY-NC 4.0 licence.
const rows = summary.map((s, i) => `| ${i + 1} | [${s.title}](${s.url}) | ${s.file} | ${s.chars} |`);
await writeFile(
  new URL("SOURCES.md", OUT_DIR),
  `# Knowledge base sources

All documents in this folder are adapted from the Fair Work Ombudsman website.

© Fair Work Ombudsman www.fairwork.gov.au — licensed under the
[Creative Commons Attribution-NonCommercial 4.0 International Licence](https://creativecommons.org/licenses/by-nc/4.0/legalcode).

**Changes made:** navigation menus, videos, glossary pop-ups, interactive tools and "related links"
sections were removed, and the remaining text was converted to Markdown. The wording is unchanged.

This project is an independent, non-commercial learning demo. It is not connected to, sponsored by
or endorsed by the Fair Work Ombudsman or the Commonwealth of Australia.

Saved on: ${today}

| # | Page (official link) | File | Characters |
|---|---|---|---|
${rows.join("\n")}
`,
);
console.log(`\n${summary.length} documents, ${summary.reduce((n, s) => n + s.chars, 0)} characters in total`);
