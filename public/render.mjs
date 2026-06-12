export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function inlineMarkdown(value, fileUrl = (f) => f) {
  const placeholders = [];
  const placeholder = (html) => {
    const token = `@@PH${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let text = String(value)
    .replace(
      /!?\[\[([^#|\]]+)(?:#([^|\]]+))?(?:\|([^\]]+))?\]\]/g,
      (match, file, heading = "", label = "") => {
        const target = file.trim();
        if (match.startsWith("!") && IMAGE_EXT.test(target)) {
          return placeholder(
            `<img class="embed-image" src="${escapeHtml(fileUrl(target))}" alt="${escapeHtml((label || target).trim())}" loading="lazy">`,
          );
        }
        return placeholder(
          `<a class="wiki-link" href="#" data-wiki-file="${escapeHtml(target)}" data-wiki-heading="${escapeHtml(heading.trim())}">${escapeHtml((label || heading || file).trim())}</a>`,
        );
      },
    )
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, url) => {
      const src = /^https?:\/\//.test(url) ? url : fileUrl(url);
      return placeholder(
        `<img class="embed-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`,
      );
    });

  text = escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );

  placeholders.forEach((html, index) => {
    text = text.split(`@@PH${index}@@`).join(html);
  });
  return text;
}

function renderListItemBody(text, fileUrl) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return {
      task: true,
      html: `<label class="task-item"><input type="checkbox" disabled${checked}> ${inlineMarkdown(task[2], fileUrl)}</label>`,
    };
  }
  return { task: false, html: inlineMarkdown(text, fileUrl) };
}

function buildList(items, position, indent, fileUrl) {
  const ordered = items[position].ordered;
  let html = `<${ordered ? "ol" : "ul"}>`;
  let pos = position;
  while (pos < items.length && items[pos].indent >= indent) {
    const item = items[pos];
    const body = renderListItemBody(item.text, fileUrl);
    pos += 1;
    let children = "";
    if (pos < items.length && items[pos].indent > item.indent) {
      const result = buildList(items, pos, items[pos].indent, fileUrl);
      children = result.html;
      pos = result.pos;
    }
    html += `<li${body.task ? ' class="task-li"' : ""}>${body.html}${children}</li>`;
  }
  html += `</${ordered ? "ol" : "ul"}>`;
  return { html, pos };
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function renderMarkdown(markdown = "", options = {}) {
  const { preserveLineBreaks = false } = options;
  const fileUrl = options.fileUrl || ((f) => f);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let index = 0;

  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index].trim() !== "---") index += 1;
    index += 1;
  }

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed || /^<!--.*-->$/.test(trimmed)) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      output.push(`<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const title = heading[2].replace(/\s+\^[A-Za-z0-9_-]+\s*$/, "");
      output.push(`<h${level}>${inlineMarkdown(title, fileUrl)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (trimmed.startsWith("> [!")) {
      const marker = trimmed.match(/^>\s*\[!([^\]]+)\]\s*(.*)$/);
      const body = [];
      if (marker?.[2]) body.push(marker[2]);
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(
        `<div class="callout"><div class="callout-title">${escapeHtml(marker?.[1] || "Note")}</div><div>${body.map((b) => inlineMarkdown(b, fileUrl)).join("<br>")}</div></div>`,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const body = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${body.map((b) => inlineMarkdown(b, fileUrl)).join("<br>")}</blockquote>`);
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      output.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell, fileUrl)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell, fileUrl)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!item) break;
        items.push({
          indent: item[1].replace(/\t/g, "    ").length,
          ordered: /\d+\./.test(item[2]),
          text: item[3],
        });
        index += 1;
      }
      output.push(buildList(items, 0, items[0].indent, fileUrl).html);
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith(">") &&
      !lines[index].trim().startsWith("```") &&
      !(lines[index].includes("|") && isTableDivider(lines[index + 1] || ""))
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(
      `<p>${paragraph.map((p) => inlineMarkdown(p, fileUrl)).join(preserveLineBreaks ? "<br>" : " ")}</p>`,
    );
  }

  return output.join("\n");
}

export function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function meterColor(ratio) {
  return `hsl(${(Math.round(96 - 111 * ratio) + 360) % 360} 100% 60%)`;
}

export function clockSvg(max, value) {
  const cx = 50;
  const cy = 50;
  const r = 42;
  const gap = max > 1 ? Math.min(0.09, 1.4 / max) : 0.0002;
  let paths = "";
  for (let i = 0; i < max; i++) {
    const a0 = -Math.PI / 2 + (i / max) * Math.PI * 2 + gap;
    const a1 = -Math.PI / 2 + ((i + 1) / max) * Math.PI * 2 - gap;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = (cx + r * Math.cos(a0)).toFixed(2);
    const y0 = (cy + r * Math.sin(a0)).toFixed(2);
    const x1 = (cx + r * Math.cos(a1)).toFixed(2);
    const y1 = (cy + r * Math.sin(a1)).toFixed(2);
    paths += `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" class="clock-seg${i < value ? " filled" : ""}"></path>`;
  }
  return `<svg class="clock-svg" viewBox="0 0 100 100" role="img" aria-label="${value} of ${max}">${paths}<text x="50" y="55" class="clock-count">${value}/${max}</text></svg>`;
}

export function trackerHtml(tracker) {
  if (tracker.type === "initiative") {
    const entries = tracker.entries || [];
    const turn = Number.isInteger(tracker.turn) ? tracker.turn : 0;
    const list = entries.length
      ? `<ol class="init-list">${entries
          .map((entry, i) => `<li class="init-entry${i === turn ? " current" : ""}">${escapeHtml(entry)}</li>`)
          .join("")}</ol>`
      : '<div class="init-empty">No combatants yet.</div>';
    const count = entries.length ? `${turn + 1} / ${entries.length}` : "—";
    return `<div class="tracker tracker-initiative"><div class="tracker-head"><span class="tracker-name">${escapeHtml(tracker.name)}</span><span class="tracker-count">${count}</span></div>${list}</div>`;
  }
  if (tracker.type === "meter") {
    const ratio = tracker.max ? tracker.value / tracker.max : 0;
    const color = meterColor(ratio);
    return `<div class="tracker tracker-meter"><div class="tracker-head"><span class="tracker-name">${escapeHtml(tracker.name)}</span><span class="tracker-count" style="color:${color}">${tracker.value} / ${tracker.max}</span></div><div class="meter-bar"><div class="meter-fill" style="width:${Math.round(ratio * 100)}%;background:${color}"></div></div></div>`;
  }
  return `<div class="tracker tracker-clock">${clockSvg(tracker.max, tracker.value)}<span class="tracker-name">${escapeHtml(tracker.name)}</span></div>`;
}

export function feedEntryHtml(item, options = {}) {
  const imageUrl = options.imageUrl || (() => "");
  const fileUrl = options.fileUrl || (() => "");
  const icon = item.type === "image" ? "🖼" : item.type === "text" ? "✎" : "✦";
  const head = `<header class="feed-head"><span class="feed-icon">${icon}</span><span class="feed-title">${escapeHtml(item.title || "Untitled")}</span><time class="feed-time">${formatTime(item.ts)}</time></header>`;
  let body;
  if (item.type === "card") {
    body = `<div class="feed-body markdown-body">${renderMarkdown(item.markdown || "", { fileUrl })}</div>`;
  } else if (item.type === "image") {
    body = `<div class="feed-body"><img class="feed-image" src="${escapeHtml(imageUrl(item))}" alt="${escapeHtml(item.title || "Shared image")}" loading="lazy"></div>`;
  } else {
    body = `<div class="feed-body feed-text">${escapeHtml(item.text || "")}</div>`;
  }
  return `<article class="feed-entry feed-${item.type}">${head}${body}</article>`;
}

export function rollHtml(roll) {
  if (!roll || !Array.isArray(roll.parts)) return "";
  const detail = roll.parts
    .map((part, index) => {
      const sign = index === 0 ? (part.sign < 0 ? "−" : "") : part.sign < 0 ? " − " : " + ";
      if (part.kind === "dice") {
        return `${sign}[${(part.rolls || []).join(", ")}]`;
      }
      return `${sign}${part.value}`;
    })
    .join("");
  return `<span class="roll-result"><span class="roll-dice">🎲</span><span class="roll-expr">${escapeHtml(roll.expr || "")}</span><span class="roll-detail">${escapeHtml(detail)}</span><span class="roll-total">${roll.total}</span></span>`;
}
