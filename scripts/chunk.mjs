// Splits a Markdown document into retrieval-sized pieces.
//
// Strategy: split on headings first, because our source pages are already
// organised by topic ("## Redundancy pay", "## Notice periods"). A heading
// boundary is a topic boundary, which is exactly where we want to cut.
// Sections longer than MAX_CHARS are split again at paragraph/sentence
// boundaries, with an overlap so an answer spanning a cut isn't lost.

const MAX_CHARS = 1000;
const OVERLAP = 150;
// Sections shorter than this are merged into the next one rather than dropped.
// Short does not mean unimportant: "Sick and carer's leave isn't paid out when
// employment ends" is 57 characters and is the whole answer to a common question.
// It is still too small to retrieve reliably on its own, so it rides along with
// the following section instead of becoming its own chunk.
const MIN_SECTION_CHARS = 200;
const MIN_CHARS = 40; // after merging, anything this small is a true stub

/** Pulls the `---` frontmatter block written by fetch-sources.mjs. */
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("File has no frontmatter block");
  const meta = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  return { meta, body: raw.slice(match[0].length).trim() };
}

/** Splits long text at the latest paragraph, then sentence, then space boundary. */
function splitLongText(text) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      // Only honour a boundary past the halfway mark, so chunks don't get tiny.
      if (boundary > MAX_CHARS * 0.5) end = start + boundary + 1;
    }
    pieces.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - OVERLAP;
  }
  return pieces;
}

/**
 * Rolls sections shorter than MIN_SECTION_CHARS into the one that follows,
 * keeping the absorbed section's own heading inline so no wording is lost.
 * A trailing short section attaches to the previous chunk instead.
 * Returns [{ heading, text }].
 */
function mergeShortSections(sections) {
  const out = [];
  let pending = null;

  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;

    if (pending) {
      // Keep the absorbed heading visible so the merged chunk still reads well.
      const inline = section.heading ? `${section.heading}\n\n` : "";
      pending = { heading: pending.heading, text: `${pending.text}\n\n${inline}${text}` };
    } else {
      pending = { heading: section.heading, text };
    }

    if (pending.text.length >= MIN_SECTION_CHARS) {
      out.push(pending);
      pending = null;
    }
  }

  if (pending) {
    if (out.length) out[out.length - 1].text += `\n\n${pending.heading ? `${pending.heading}\n\n` : ""}${pending.text}`;
    else out.push(pending);
  }
  return out;
}

/**
 * Returns [{ heading, content }]. `content` is prefixed with the document title
 * and heading path — so a chunk reading "4 weeks" carries "Annual leave > How
 * much annual leave an employee gets" with it. Without that prefix the chunk is
 * ambiguous to the embedding model and retrieval gets noticeably worse.
 */
export function chunkDocument(title, body) {
  const lines = body.split("\n");
  const sections = [];
  let current = { heading: "", lines: [] };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      if (current.lines.length) sections.push(current);
      // h1 is the document title, already captured; treat h2/h3 as section headings.
      current = { heading: heading[1] === "#" ? "" : heading[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);

  const chunks = [];
  for (const section of mergeShortSections(sections)) {
    const text = section.text;
    const path = section.heading ? `${title} > ${section.heading}` : title;
    for (const piece of splitLongText(text)) {
      if (piece.length < MIN_CHARS) continue;
      chunks.push({ heading: section.heading, content: `${path}\n\n${piece}` });
    }
  }
  return chunks;
}
