const snippetsApi = globalThis.StudyReaderSnippetStorage || globalThis.StudyReaderSnippets;

const els = {
  summary: document.getElementById("summary"),
  status: document.getElementById("status"),
  exportButton: document.getElementById("exportSnippets"),
  clearButton: document.getElementById("clearSnippets"),
  list: document.getElementById("snippetList")
};

const noteSaveTimers = new Map();

init();

async function init() {
  els.exportButton.addEventListener("click", exportSnippets);
  els.clearButton.addEventListener("click", clearSnippets);

  if (chrome?.storage?.onChanged && snippetsApi?.STORAGE_KEY) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, snippetsApi.STORAGE_KEY)) {
        render().catch(handleRenderError);
      }
    });
  }

  await render().catch(handleRenderError);
}

async function render() {
  if (!snippetsApi?.getSnippets) {
    const diagnostics = getSnippetDiagnostics("snippets-manager");
    console.error("Study Reader: snippets manager helper missing", diagnostics);
    throw new Error("Snippet storage helper is unavailable in the snippets manager.");
  }

  const snippets = (await snippetsApi.getSnippets()).filter((snippet) => snippet.sourceType === "pdf");

  if (snippets.length === 0) {
    els.summary.textContent = "No PDF snippets saved yet.";
    els.status.textContent = "No PDF snippets saved yet.";
    els.exportButton.disabled = true;
    els.clearButton.disabled = true;
    renderEmptyState();
    return;
  }

  const groups = snippetsApi.groupSnippetsBySource(snippets);
  els.summary.textContent = `${snippets.length} saved PDF snippet${snippets.length === 1 ? "" : "s"} across ${groups.length} PDF source${groups.length === 1 ? "" : "s"}.`;
  els.exportButton.disabled = false;
  els.clearButton.disabled = false;
  els.list.replaceChildren();

  groups.forEach((group) => {
    els.list.appendChild(renderSourceGroup(group));
  });
}

function renderSourceGroup(group) {
  const section = document.createElement("section");
  section.className = "snippet-card";

  const heading = document.createElement("h2");
  heading.className = "source-heading";
  heading.textContent = `PDF: ${group.pdfFileName || group.sourceTitle || "Untitled PDF"}`;

  const meta = document.createElement("p");
  meta.className = "source-line";
  meta.append(...buildGroupMeta(group));

  const entries = document.createElement("div");
  entries.className = "snippet-group-list";

  group.snippets.forEach((snippet) => {
    entries.appendChild(renderSnippetEntry(snippet));
  });

  section.append(heading, meta, entries);
  return section;
}

function renderSnippetEntry(snippet) {
  const entry = document.createElement("article");
  entry.className = "snippet-entry";
  entry.dataset.snippetId = snippet.id;

  const top = document.createElement("div");
  top.className = "snippet-top";

  const meta = document.createElement("p");
  meta.className = "snippet-meta";
  meta.textContent = buildSnippetMeta(snippet);

  const actions = document.createElement("div");
  actions.className = "snippet-actions";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    try {
      await snippetsApi.deleteSnippet(snippet.id);
      setStatus("Snippet deleted.");
      await render();
    } catch (error) {
      console.error("Study Reader: failed to delete snippet", error);
      setStatus(error.message || "Could not delete snippet.");
    }
  });

  actions.append(deleteButton);
  top.append(meta, actions);

  const text = document.createElement("p");
  text.className = "snippet-text";
  text.textContent = snippet.text;

  const noteField = document.createElement("label");
  noteField.className = "note-field";

  const noteLabel = document.createElement("span");
  noteLabel.className = "note-label";
  noteLabel.textContent = "Note";

  const noteInput = document.createElement("textarea");
  noteInput.value = snippet.note || "";
  noteInput.placeholder = "Add a short note for this snippet.";
  noteInput.addEventListener("input", () => scheduleNoteSave(snippet.id, noteInput.value));
  noteInput.addEventListener("blur", () => flushNoteSave(snippet.id, noteInput.value));

  noteField.append(noteLabel, noteInput);
  entry.append(top, text, noteField);

  return entry;
}

function renderEmptyState() {
  els.list.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "Save a sentence or paragraph from the PDF reader to collect it here.";
  els.list.appendChild(empty);
}

function buildGroupMeta(group) {
  const parts = [];

  if (group.sourceType === "web" && group.sourceUrl) {
    const link = document.createElement("a");
    link.href = group.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = group.sourceUrl;
    parts.push(link);
  }

  if (group.sourceType === "pdf" && group.pdfFileName) {
    parts.push(document.createTextNode(group.pdfFileName));
  }

  if (parts.length === 0) {
    parts.push(document.createTextNode("Source details unavailable."));
  }

  return parts;
}

function buildSnippetMeta(snippet) {
  const parts = [
    capitalize(snippet.snippetType),
    `Saved ${formatDateTime(snippet.createdAt)}`
  ];

  if (snippet.pageNumber) {
    parts.push(`Page ${snippet.pageNumber}`);
  }

  if (snippet.paragraphIndex !== null) {
    parts.push(`Paragraph ${snippet.paragraphIndex + 1}`);
  }

  if (snippet.sentenceIndex !== null) {
    parts.push(`Sentence ${snippet.sentenceIndex + 1}`);
  }

  return parts.join(" / ");
}

function scheduleNoteSave(id, note) {
  clearTimeout(noteSaveTimers.get(id));
  const timer = setTimeout(() => {
    flushNoteSave(id, note);
  }, 350);
  noteSaveTimers.set(id, timer);
}

async function flushNoteSave(id, note) {
  clearTimeout(noteSaveTimers.get(id));
  noteSaveTimers.delete(id);

  try {
    await snippetsApi.updateSnippet(id, { note });
    setStatus("Note saved.");
  } catch (error) {
    console.error("Study Reader: failed to save snippet note", error);
    setStatus(error.message || "Could not save note.");
  }
}

async function clearSnippets() {
  const shouldClear = window.confirm("Clear all saved PDF snippets?");
  if (!shouldClear) {
    return;
  }

  try {
    const snippets = await snippetsApi.getSnippets();
    const webSnippets = snippets.filter((snippet) => snippet.sourceType !== "pdf");
    await snippetsApi.clearSnippets();
    for (const snippet of webSnippets.slice().reverse()) {
      await snippetsApi.saveSnippet(snippet);
    }
    setStatus("All PDF snippets cleared.");
    await render();
  } catch (error) {
    console.error("Study Reader: failed to clear snippets", error);
    setStatus(error.message || "Could not clear PDF snippets.");
  }
}

async function exportSnippets() {
  try {
    const snippets = (await snippetsApi.getSnippets()).filter((snippet) => snippet.sourceType === "pdf");
    if (snippets.length === 0) {
      setStatus("No PDF snippets saved yet.");
      return;
    }

    const html = buildExportHtml(snippets);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `study-reader-saved-pdf-snippets-${formatDateForFile(Date.now())}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("PDF snippets exported.");
  } catch (error) {
    console.error("Study Reader: failed to export snippets", error);
    setStatus(error.message || "Could not export PDF snippets.");
  }
}

function buildExportHtml(snippets) {
  const groups = snippetsApi.groupSnippetsBySource(snippets);
  const exportDate = formatDateTime(Date.now());

  const sections = groups.map((group) => {
    const sourceHeading = escapeHtml(`PDF: ${group.pdfFileName || group.sourceTitle || "Untitled PDF"}`);
    const sourceMeta = group.pdfFileName ? `PDF file: ${escapeHtml(group.pdfFileName)}` : "";

    const items = group.snippets.map((snippet) => {
      const note = snippet.note
        ? `<p class="note"><strong>Note:</strong> ${escapeHtml(snippet.note)}</p>`
        : "";

      const meta = buildSnippetMeta(snippet);

      return `
        <article class="snippet">
          <p class="snippet-text">${escapeHtml(snippet.text)}</p>
          <p class="snippet-meta">${escapeHtml(meta)}</p>
          ${note}
        </article>
      `;
    }).join("");

    return `
      <section class="source-group">
        <h2>${sourceHeading}</h2>
        ${sourceMeta ? `<p class="source-meta">${sourceMeta}</p>` : ""}
        ${items}
      </section>
    `;
  }).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Study Reader Saved PDF Snippets</title>
    <style>
      body {
        font-family: Calibri, Arial, sans-serif;
        color: #1f2933;
        margin: 40px;
        line-height: 1.5;
      }
      h1 {
        margin-bottom: 8px;
      }
      .export-date,
      .source-meta,
      .snippet-meta {
        color: #5b6978;
        font-size: 12px;
      }
      .source-group {
        margin-top: 28px;
        padding-top: 10px;
        border-top: 1px solid #d7e0ea;
      }
      .snippet {
        margin-top: 16px;
        padding: 12px 14px;
        border: 1px solid #d7e0ea;
        border-radius: 10px;
        background: #fafcff;
      }
      .snippet-text,
      .note {
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h1>Study Reader Saved PDF Snippets</h1>
    <p class="export-date">Exported: ${escapeHtml(exportDate)}</p>
    ${sections}
  </body>
</html>`;
}

function handleRenderError(error) {
  console.error("Study Reader: failed to render snippets manager", error);
  els.summary.textContent = "Could not load saved PDF snippets.";
  els.exportButton.disabled = true;
  els.clearButton.disabled = true;
  setStatus(error.message || "Could not load saved PDF snippets.");
  renderEmptyState();
}

function getSnippetDiagnostics(context) {
  return {
    context,
    hasChromeStorage: Boolean(globalThis.chrome?.storage),
    hasChromeRuntime: Boolean(globalThis.chrome?.runtime),
    hasStudyReaderSnippetStorage: Boolean(globalThis.StudyReaderSnippetStorage),
    hasStudyReaderSnippets: Boolean(globalThis.StudyReaderSnippets),
    helperDiagnostics: snippetsApi?.getDiagnostics ? snippetsApi.getDiagnostics(context) : null
  };
}

function setStatus(message) {
  els.status.textContent = message;
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function formatDateForFile(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
}
