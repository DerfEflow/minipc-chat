/*
 * Safe assistant Markdown renderer.
 *
 * Model output is presentation text, not trusted HTML. This parser recognizes the Markdown people
 * expect from an AI response and builds DOM nodes with textContent/createTextNode only. Raw HTML is
 * never interpreted, so formatting support does not reopen an injection path.
 */
(() => {
  "use strict";

  const textToken = (value) => ({ type: "text", value });
  const addText = (tokens, value) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === "text") last.value += value;
    else tokens.push(textToken(value));
  };

  function parseInline(value) {
    const source = String(value ?? "");
    const tokens = [];
    let i = 0;

    while (i < source.length) {
      const rest = source.slice(i);
      let match;

      if (rest[0] === "\\" && rest.length > 1 && /[\\`*[\]()~#>+-]/.test(rest[1])) {
        addText(tokens, rest[1]);
        i += 2;
        continue;
      }

      match = /^`([^`\n]+)`/.exec(rest);
      if (match) {
        tokens.push({ type: "code", value: match[1] });
        i += match[0].length;
        continue;
      }

      match = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest);
      if (match) {
        tokens.push({ type: "strong", children: parseInline(match[1]) });
        i += match[0].length;
        continue;
      }

      match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (match) {
        tokens.push({ type: "del", children: parseInline(match[1]) });
        i += match[0].length;
        continue;
      }

      match = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(rest);
      if (match) {
        tokens.push({ type: "link", href: match[2], title: match[3] || "", children: parseInline(match[1]) });
        i += match[0].length;
        continue;
      }

      match = /^\*([^*\n]+)\*/.exec(rest);
      if (match) {
        tokens.push({ type: "em", children: parseInline(match[1]) });
        i += match[0].length;
        continue;
      }

      match = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
      if (match) {
        tokens.push({ type: "link", href: match[1], title: "", children: [textToken(match[1])] });
        i += match[0].length;
        continue;
      }

      match = /^https?:\/\/[^\s<]+/.exec(rest);
      if (match) {
        let href = match[0];
        const tail = /[),.;:!?]+$/.exec(href);
        const punctuation = tail ? tail[0] : "";
        if (punctuation) href = href.slice(0, -punctuation.length);
        tokens.push({ type: "link", href, title: "", children: [textToken(href)] });
        if (punctuation) addText(tokens, punctuation);
        i += match[0].length;
        continue;
      }

      addText(tokens, source[i]);
      i++;
    }

    return tokens;
  }

  const isFence = (line) => /^\s*```/.test(line);
  const isHeading = (line) => /^\s{0,3}#{1,6}\s+\S/.test(line);
  const isQuote = (line) => /^\s{0,3}>\s?/.test(line);
  const isBullet = (line) => /^\s{0,3}[-+*]\s+\S/.test(line);
  const isOrdered = (line) => /^\s{0,3}\d+[.)]\s+\S/.test(line);
  const isRule = (line) => /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  const isTableDivider = (line) => {
    const cells = splitTableRow(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  };
  const startsBlock = (line, next = "") =>
    !line.trim() || isFence(line) || isHeading(line) || isQuote(line) || isBullet(line) ||
    isOrdered(line) || isRule(line) || (line.includes("|") && isTableDivider(next));

  function splitTableRow(line) {
    let value = String(line || "").trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    return value.split("|").map((cell) => cell.trim());
  }

  function parse(value) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      if (isFence(line)) {
        const language = line.trim().slice(3).trim().replace(/[^\w#+.-]/g, "").slice(0, 30);
        const body = [];
        i++;
        while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        blocks.push({ type: "codeblock", language, value: body.join("\n") });
        continue;
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
        i++;
        continue;
      }

      if (isRule(line)) {
        blocks.push({ type: "rule" });
        i++;
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const headers = splitTableRow(line).map(parseInline);
        const alignment = splitTableRow(lines[i + 1]).map((cell) => {
          const value = cell.trim();
          return value.startsWith(":") && value.endsWith(":") ? "center" : value.endsWith(":") ? "right" : "left";
        });
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitTableRow(lines[i]).map(parseInline));
          i++;
        }
        blocks.push({ type: "table", headers, alignment, rows });
        continue;
      }

      if (isBullet(line) || isOrdered(line)) {
        const ordered = isOrdered(line);
        const items = [];
        const itemPattern = ordered ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-+*]\s+(.+)$/;
        while (i < lines.length) {
          const item = itemPattern.exec(lines[i]);
          if (!item) break;
          items.push(parseInline(item[1]));
          i++;
        }
        blocks.push({ type: "list", ordered, items });
        continue;
      }

      if (isQuote(line)) {
        const quote = [];
        while (i < lines.length && isQuote(lines[i])) {
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", children: parseInline(quote.join("\n")) });
        continue;
      }

      const paragraph = [line];
      i++;
      while (i < lines.length && !startsBlock(lines[i], lines[i + 1] || "")) paragraph.push(lines[i++]);
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    }

    return blocks;
  }

  const safeHref = (href) => {
    const value = String(href || "").trim();
    if (/^(?:https?:|mailto:)/i.test(value) || /^(?:\/|#)/.test(value)) return value;
    return "";
  };

  function renderInline(parent, tokens, doc) {
    for (const token of tokens || []) {
      if (token.type === "text") {
        const parts = token.value.split("\n");
        parts.forEach((part, index) => {
          if (index) parent.appendChild(doc.createElement("br"));
          if (part) parent.appendChild(doc.createTextNode(part));
        });
        continue;
      }
      if (token.type === "code") {
        const code = doc.createElement("code");
        code.textContent = token.value;
        parent.appendChild(code);
        continue;
      }
      const tag = token.type === "strong" ? "strong" : token.type === "em" ? "em" :
        token.type === "del" ? "del" : token.type === "link" ? "a" : "span";
      const el = doc.createElement(tag);
      if (token.type === "link") {
        const href = safeHref(token.href);
        if (!href) {
          renderInline(parent, token.children, doc);
          continue;
        }
        el.href = href;
        if (/^https?:/i.test(href)) {
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        }
        if (token.title) el.title = token.title;
      }
      renderInline(el, token.children, doc);
      parent.appendChild(el);
    }
  }

  function blockElement(block, doc) {
    let el;
    if (block.type === "heading") {
      el = doc.createElement("h" + block.level);
      renderInline(el, block.children, doc);
    } else if (block.type === "paragraph") {
      el = doc.createElement("p");
      renderInline(el, block.children, doc);
    } else if (block.type === "quote") {
      el = doc.createElement("blockquote");
      renderInline(el, block.children, doc);
    } else if (block.type === "rule") {
      el = doc.createElement("hr");
    } else if (block.type === "codeblock") {
      el = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.value;
      el.appendChild(code);
    } else if (block.type === "list") {
      el = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        renderInline(li, item, doc);
        el.appendChild(li);
      }
    } else if (block.type === "table") {
      el = doc.createElement("div");
      el.className = "md-table-wrap";
      const table = doc.createElement("table");
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      block.headers.forEach((tokens, index) => {
        const th = doc.createElement("th");
        th.style.textAlign = block.alignment[index] || "left";
        renderInline(th, tokens, doc);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        const count = Math.max(block.headers.length, row.length);
        for (let index = 0; index < count; index++) {
          const td = doc.createElement("td");
          td.style.textAlign = block.alignment[index] || "left";
          renderInline(td, row[index] || [], doc);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
    } else {
      el = doc.createElement("p");
    }
    el.classList.add("md-block");
    return el;
  }

  function renderInto(root, value) {
    if (!root) return;
    const doc = root.ownerDocument || document;
    while (root.firstChild) root.removeChild(root.firstChild);
    for (const block of parse(value)) root.appendChild(blockElement(block, doc));
    root.dataset.markdown = "true";
  }

  window.DominionMarkdown = Object.freeze({ parse, parseInline, renderInto });
})();
