// Parse SAP-C02-categorized.md into structured JSON for the quiz app
const fs = require('fs');
const path = require('path');

const SRC = String.raw`D:\ObsidianVault\SAP-C02-categorized.md`;
const OUT = String.raw`D:\workspace\ai_docs\sap-c02-quiz.json`;

let raw = fs.readFileSync(SRC, 'utf8');
// Normalize: drop private-use-area glyphs (PDF extraction artifacts) and other invisible junk.
raw = raw
  .replace(/[-]/g, '')
  .replace(/ /g, ' ')
  .replace(/﻿/g, '');

// Split by question header
const parts = raw.split(/^### Question #/m);
const intro = parts.shift();

// Find current category by scanning preceding text
// Strategy: walk through file by lines, track latest ## heading, then parse questions
const lines = raw.split(/\r?\n/);
const items = [];
let currentCategory = null;
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const catMatch = line.match(/^##\s+(.+?)\s*$/);
  if (catMatch && !line.startsWith('### ')) {
    const catTitle = catMatch[1].trim();
    // Skip the index/header section
    if (!catTitle.toLowerCase().startsWith('category index')) {
      currentCategory = catTitle.replace(/\s*\(\d+\s+questions?\)\s*$/, '').trim();
    }
    i++;
    continue;
  }
  const qMatch = line.match(/^### Question #(\d+)/);
  if (qMatch) {
    const qnum = parseInt(qMatch[1], 10);
    // Find ```text block start
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('```text')) j++;
    const codeStart = j + 1;
    let k = codeStart;
    while (k < lines.length && lines[k] !== '```') k++;
    const block = lines.slice(codeStart, k).join('\n');
    items.push({ qnum, category: currentCategory, raw: block });
    i = k + 1;
    continue;
  }
  i++;
}

console.log('Parsed question blocks:', items.length);

function parseQuestion(item) {
  const text = item.raw;
  // Split structure:
  //   [question text]
  //   A. ...
  //   B. ...
  //   ...
  //   Correct Answer: X
  //   Community vote distribution
  //   <vote line(s)>
  //   <comments>
  const correctIdx = text.search(/^\s*Correct Answer:\s*[A-Z]+/m);
  const beforeCorrect = correctIdx >= 0 ? text.slice(0, correctIdx) : text;
  const afterCorrect = correctIdx >= 0 ? text.slice(correctIdx) : '';

  // Find first option marker (A. or A))
  const optRegex = /^\s{0,6}([A-F])\.\s+/m;
  const optStart = beforeCorrect.search(optRegex);
  const questionText = optStart >= 0 ? beforeCorrect.slice(0, optStart).trim() : beforeCorrect.trim();

  // Parse options - find each "X. " at start of (indented) line, then take content until next option or end
  const options = {};
  if (optStart >= 0) {
    const optBody = beforeCorrect.slice(optStart);
    // Find each option boundary
    const matches = [];
    const re = /^\s{0,6}([A-F])\.\s+/gm;
    let m;
    while ((m = re.exec(optBody)) !== null) {
      matches.push({ letter: m[1], start: m.index, headerEnd: m.index + m[0].length });
    }
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1].start : optBody.length;
      let body = optBody.slice(cur.headerEnd, end);
      // collapse leading indentation per line
      body = body.split('\n').map(l => l.replace(/^\s{3,}/, '')).join(' ').replace(/\s+/g, ' ').trim();
      options[cur.letter] = body;
    }
  }

  // Parse correct answer
  let correctAnswer = '';
  const ca = afterCorrect.match(/Correct Answer:\s*([A-Z]+)/);
  if (ca) correctAnswer = ca[1];

  // Parse community vote distribution
  const cv = {};
  const cvIdx = afterCorrect.indexOf('Community vote distribution');
  let commentsBlock = '';
  if (cvIdx >= 0) {
    const cvRest = afterCorrect.slice(cvIdx + 'Community vote distribution'.length);
    // Take next non-empty line as vote line
    const cvLines = cvRest.split('\n');
    let voteLine = '';
    let lineConsumed = 0;
    for (let i = 0; i < cvLines.length; i++) {
      const t = cvLines[i];
      if (t.trim() === '') { lineConsumed = i + 1; continue; }
      voteLine = t;
      lineConsumed = i + 1;
      break;
    }
    // Parse "X (NN%)" or "XY (NN%)" tokens
    const voteRe = /([A-F]{1,3})\s*\((\d+)%\)/g;
    let vm;
    while ((vm = voteRe.exec(voteLine)) !== null) {
      cv[vm[1]] = parseInt(vm[2], 10);
    }
    // Check for "Other" or trailing percentages like "12%"
    const otherPct = voteLine.match(/(?:\b)(\d+)%\s*$/);
    // we ignore "Other" — already captured all key options
    commentsBlock = cvLines.slice(lineConsumed).join('\n');
  } else {
    // No community vote
    commentsBlock = afterCorrect.replace(/Correct Answer:.*?\n/, '');
  }

  // Compute community answer: option(s) with highest percentage
  let communityAnswer = '';
  let topPct = -1;
  for (const [k, v] of Object.entries(cv)) {
    if (v > topPct) { topPct = v; communityAnswer = k; }
  }
  // If no community vote, fall back to correct answer
  if (!communityAnswer) communityAnswer = correctAnswer;

  // Parse comments — keep raw text but trim and split into entries
  // A new top-level comment begins with "username Highly Voted" or "username Most Recent" or just username then "<time> ago"
  // For simplicity, just return cleaned text preserving paragraphs
  const comments = parseComments(commentsBlock);

  return {
    qnum: item.qnum,
    category: item.category,
    question: questionText,
    options,
    correctAnswer,
    communityVotes: cv,
    communityAnswer,
    comments,
  };
}

function parseComments(text) {
  if (!text || !text.trim()) return [];
  // Normalize lines - keep indentation to detect replies
  const lines = text.split('\n');
  // A comment header line looks like:
  //   "<username> [Highly Voted | Most Recent] <NN> <unit>(s)?, <NN> <unit>(s)? ago"
  // The username is the first token; "Highly Voted" or "Most Recent" are optional markers.
  const headerRe = /^(\s*)(\S+)\s+(?:(Highly Voted|Most Recent)\s+)?(\d+\s+(?:year|month|week|day|hour|minute)s?(?:,\s*\d+\s+(?:year|month|week|day|hour|minute)s?)?\s+ago)\s*$/;
  const result = [];
  let cur = null;
  let buf = [];

  function flush() {
    if (cur) {
      cur.text = buf.join('\n').replace(/\n\s*upvoted\s+\d+\s+times?\s*$/i, '').trim();
      // Extract "Selected Answer: X"
      const sa = cur.text.match(/Selected Answer:\s*([A-Z]+)/);
      if (sa) cur.selected = sa[1];
      // Extract upvotes
      const up = buf.join('\n').match(/upvoted\s+(\d+)\s+times?/i);
      if (up) cur.upvotes = parseInt(up[1], 10);
      else cur.upvotes = 0;
      result.push(cur);
    }
    cur = null; buf = [];
  }

  for (const line of lines) {
    const hm = line.match(headerRe);
    if (hm) {
      flush();
      cur = {
        indent: hm[1].length,
        user: hm[2],
        badge: hm[3] || '',
        when: hm[4],
        text: '',
        selected: '',
        upvotes: 0,
      };
    } else {
      if (cur) buf.push(line);
    }
  }
  flush();

  // Clean up: drop obvious spam (XSS payload attempts, very short)
  const filtered = result.filter(c => {
    const t = c.text || '';
    if (!t.trim()) return false;
    if (/<script|onerror=|onclick=|onselectstart=|alert\(/i.test(t)) return false;
    if (t.length < 4) return false;
    return true;
  });

  // Re-indent: convert to nested structure based on indent
  // For UI simplicity we'll keep flat with indent value (clamped)
  for (const c of filtered) {
    // Indentation values commonly: 3, 6, 9 etc.
    c.depth = Math.min(3, Math.max(0, Math.floor((c.indent - 3) / 3)));
    delete c.indent;
  }
  return filtered;
}

const parsed = items.map(parseQuestion);

// Group by category
const byCategory = {};
for (const q of parsed) {
  const c = q.category || 'Uncategorized';
  if (!byCategory[c]) byCategory[c] = [];
  byCategory[c].push(q);
}

// Sort questions within categories by qnum
for (const k of Object.keys(byCategory)) byCategory[k].sort((a, b) => a.qnum - b.qnum);

const summary = {
  total: parsed.length,
  categories: Object.keys(byCategory).map(c => ({ name: c, count: byCategory[c].length })),
};

console.log('Summary:', JSON.stringify(summary, null, 2));
// Spot-check first question
console.log('\nSample question 1:');
console.log(JSON.stringify(parsed[0], null, 2).slice(0, 2000));

fs.writeFileSync(OUT, JSON.stringify({ summary, questions: parsed }, null, 0));
console.log('\nWrote', OUT, (fs.statSync(OUT).size / 1024 / 1024).toFixed(2), 'MB');
