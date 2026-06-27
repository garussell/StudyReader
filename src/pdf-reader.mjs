import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");

const prefsApi = globalThis.StudyReaderPrefs;
const snippetsApi = globalThis.StudyReaderSnippetStorage || globalThis.StudyReaderSnippets;
const themeApi = globalThis.StudyReaderTheme;
const DEFAULT_PREFS = prefsApi?.DEFAULT_PREFS || {
  rate: 1,
  voiceName: ""
};
const PDF_LAYOUT_STORAGE_KEY = "studyReaderPdfLayoutMode";
const PDF_FOLLOW_STORAGE_KEY = "studyReaderPdfFollowReading";
const PDF_SPEECH_FILTERS_STORAGE_KEY = "studyReaderPdfSpeechFilters";
const PDF_LAYOUT_MODES = {
  AUTO: "auto",
  SINGLE: "single",
  TWO: "two"
};
const DEFAULT_SPEECH_FILTERS = {
  skipCitations: false,
  skipParentheticalText: false,
  skipBracketCitations: false,
  skipUrlsDois: false,
  skipFigureTableReferences: false,
  stopBeforeReferencesSection: false
};

const els = {
  fileInput: document.getElementById("pdfFile"),
  fileName: document.getElementById("fileName"),
  canvas: document.getElementById("pdfCanvas"),
  canvasWrap: document.getElementById("canvasWrap"),
  compactStatus: document.getElementById("compactStatus"),
  readerStatus: document.getElementById("readerStatus"),
  textChunks: document.getElementById("textChunks"),
  play: document.getElementById("play"),
  pause: document.getElementById("pause"),
  resume: document.getElementById("resume"),
  stop: document.getElementById("stop"),
  nextSentence: document.getElementById("nextSentence"),
  previousSentence: document.getElementById("previousSentence"),
  nextParagraph: document.getElementById("nextParagraph"),
  previousParagraph: document.getElementById("previousParagraph"),
  nextPage: document.getElementById("nextPage"),
  previousPage: document.getElementById("previousPage"),
  saveSentence: document.getElementById("saveSentence"),
  saveParagraph: document.getElementById("saveParagraph"),
  showPreview: document.getElementById("showPreview"),
  showNavigator: document.getElementById("showNavigator"),
  filterMenuWrap: document.getElementById("filterMenuWrap"),
  filterMenuButton: document.getElementById("filterMenuButton"),
  filterMenuSummary: document.getElementById("filterMenuSummary"),
  filterMenuPanel: document.getElementById("filterMenuPanel"),
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rateValue"),
  voice: document.getElementById("voice"),
  theme: document.getElementById("theme"),
  layoutMode: document.getElementById("layoutMode"),
  followReading: document.getElementById("followReading"),
  skipCitations: document.getElementById("skipCitations"),
  skipParentheticalText: document.getElementById("skipParentheticalText"),
  skipBracketCitations: document.getElementById("skipBracketCitations"),
  skipUrlsDois: document.getElementById("skipUrlsDois"),
  skipFigureTableReferences: document.getElementById("skipFigureTableReferences"),
  stopBeforeReferencesSection: document.getElementById("stopBeforeReferencesSection"),
  textPreviewDialog: document.getElementById("textPreviewDialog"),
  textPreviewMeta: document.getElementById("textPreviewMeta"),
  textPreviewContent: document.getElementById("textPreviewContent"),
  closePreview: document.getElementById("closePreview"),
  readingNavigatorDialog: document.getElementById("readingNavigatorDialog"),
  readingNavigatorMeta: document.getElementById("readingNavigatorMeta"),
  readingNavigatorList: document.getElementById("readingNavigatorList"),
  navigatorSearch: document.getElementById("navigatorSearch"),
  closeNavigator: document.getElementById("closeNavigator")
};

const state = {
  pdf: null,
  fileName: "",
  pdfTitle: "",
  fileByteLength: 0,
  currentPage: 1,
  pageCache: new Map(),
  currentChunkIndex: 0,
  currentSentenceIndex: 0,
  prefs: { ...DEFAULT_PREFS },
  layoutMode: getStoredLayoutMode(),
  followReadingPosition: getStoredFollowReading(),
  speechFilters: { ...DEFAULT_SPEECH_FILTERS },
  debugLayout: isPdfLayoutDebugEnabled(),
  status: "idle",
  utterance: null,
  speechRunId: 0,
  documentHasText: false,
  referencesStopPosition: null,
  filterMenuOpen: false,
  statusRestoreTimer: null,
  scrollFrameId: null,
  lastScrollAt: 0
};

init();

async function init() {
  state.prefs = prefsApi ? await prefsApi.getPrefs() : normalizePrefs(DEFAULT_PREFS);
  state.speechFilters = await loadSpeechFilters();
  if (themeApi?.getThemeMode) {
    els.theme.value = await themeApi.getThemeMode();
  }
  els.rate.value = String(state.prefs.rate);
  els.layoutMode.value = state.layoutMode;
  els.followReading.checked = state.followReadingPosition;
  syncSpeechFilterControls();
  updateFilterMenuSummary();
  setFilterMenuOpen(false);
  updateRateLabel();
  wireEvents();
  populateVoices();
  updateControls();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

  if (themeApi?.watchTheme) {
    themeApi.watchTheme(({ mode }) => {
      els.theme.value = mode;
    });
  }

  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeydown);

  const params = new URLSearchParams(location.search);
  if (params.get("load") === "last") {
    await loadLastPdfFromPopup();
  }
}

function wireEvents() {
  els.fileInput.addEventListener("change", openFileFromReader);
  els.play.addEventListener("click", playFromCurrentChunk);
  els.pause.addEventListener("click", pauseReading);
  els.resume.addEventListener("click", resumeReading);
  els.stop.addEventListener("click", stopReading);
  els.nextSentence.addEventListener("click", () => moveSentence(1, true));
  els.previousSentence.addEventListener("click", () => moveSentence(-1, true));
  els.nextParagraph.addEventListener("click", () => moveParagraph(1, true));
  els.previousParagraph.addEventListener("click", () => moveParagraph(-1, true));
  els.nextPage.addEventListener("click", () => movePage(1));
  els.previousPage.addEventListener("click", () => movePage(-1));
  els.saveSentence.addEventListener("click", () => saveCurrentSnippet("sentence"));
  els.saveParagraph.addEventListener("click", () => saveCurrentSnippet("paragraph"));
  els.showPreview.addEventListener("click", showExtractedTextPreview);
  els.showNavigator.addEventListener("click", openReadingNavigator);
  els.filterMenuButton.addEventListener("click", toggleFilterMenu);
  els.closePreview.addEventListener("click", closeExtractedTextPreview);
  els.closeNavigator.addEventListener("click", closeReadingNavigator);
  els.textPreviewDialog.addEventListener("click", (event) => {
    if (event.target === els.textPreviewDialog) {
      closeExtractedTextPreview();
    }
  });
  els.readingNavigatorDialog.addEventListener("click", (event) => {
    if (event.target === els.readingNavigatorDialog) {
      closeReadingNavigator();
    }
  });
  els.navigatorSearch.addEventListener("input", renderReadingNavigatorList);

  els.rate.addEventListener("input", async () => {
    state.prefs.rate = Number(els.rate.value);
    updateRateLabel();
    await savePrefs();
  });

  els.voice.addEventListener("change", async () => {
    state.prefs.voiceName = els.voice.value;
    await savePrefs();
  });

  els.theme.addEventListener("change", async () => {
    if (!themeApi?.saveThemeMode) {
      return;
    }

    els.theme.value = await themeApi.saveThemeMode(els.theme.value);
  });

  els.layoutMode.addEventListener("change", async () => {
    await applyLayoutModeChange(els.layoutMode.value);
  });

  els.followReading.addEventListener("change", () => {
    state.followReadingPosition = els.followReading.checked;
    storeFollowReading(state.followReadingPosition);
  });

  bindSpeechFilterToggle(els.skipCitations, "skipCitations");
  bindSpeechFilterToggle(els.skipParentheticalText, "skipParentheticalText");
  bindSpeechFilterToggle(els.skipBracketCitations, "skipBracketCitations");
  bindSpeechFilterToggle(els.skipUrlsDois, "skipUrlsDois");
  bindSpeechFilterToggle(els.skipFigureTableReferences, "skipFigureTableReferences");
  bindSpeechFilterToggle(els.stopBeforeReferencesSection, "stopBeforeReferencesSection");
}

function bindSpeechFilterToggle(input, key) {
  input.addEventListener("change", async () => {
    state.speechFilters = {
      ...state.speechFilters,
      [key]: input.checked
    };
    updateFilterMenuSummary();
    await saveSpeechFilters(state.speechFilters);
  });
}

async function openFileFromReader() {
  const [file] = els.fileInput.files || [];
  els.fileInput.value = "";

  if (!file) {
    return;
  }

  if (file.type && file.type !== "application/pdf") {
    setStatus("Choose a PDF file.");
    return;
  }

  const bytes = await file.arrayBuffer();
  await loadPdf(bytes, file.name);
}

async function loadLastPdfFromPopup() {
  try {
    const record = await readPdfFromIndexedDb();
    if (!record?.bytes) {
      setStatus("No PDF was provided from the popup.");
      return;
    }

    await loadPdf(record.bytes, record.name || "Local PDF");
  } catch (error) {
    setStatus(error.message);
  }
}

async function applyLayoutModeChange(nextMode) {
  state.layoutMode = normalizeLayoutMode(nextMode);
  els.layoutMode.value = state.layoutMode;
  storeLayoutMode(state.layoutMode);

  if (!state.pdf) {
    updateControls();
    return;
  }

  const targetPage = state.currentPage;
  stopReading();
  setStatus("Updating reading layout...");
  state.pageCache.clear();
  state.currentChunkIndex = 0;
  state.currentSentenceIndex = 0;
  state.documentHasText = false;
  state.referencesStopPosition = null;

  await preloadTextContent();
  await renderPage(targetPage);
  if (els.readingNavigatorDialog.open) {
    renderReadingNavigatorList();
  }
  setStatus("Ready");
  updateControls();
}

async function loadPdf(bytes, name) {
  stopReading();
  setStatus("Loading PDF...");
  clearCanvas();
  els.textChunks.innerHTML = "";
  state.fileName = name;
  state.pdfTitle = "";
  state.fileByteLength = bytes.byteLength || 0;
  state.currentPage = 1;
  state.pageCache.clear();
  state.currentChunkIndex = 0;
  state.currentSentenceIndex = 0;
  state.documentHasText = false;
  state.referencesStopPosition = null;

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdf = await loadingTask.promise;
  state.pdfTitle = await resolvePdfTitle(name);
  els.fileName.textContent = name;

  await preloadTextContent();
  await renderPage(1);
  if (els.readingNavigatorDialog.open) {
    renderReadingNavigatorList();
  }

  if (!state.documentHasText) {
    showImageOnlyMessage();
  } else {
    setStatus("Ready");
  }

  updateControls();
}

async function preloadTextContent() {
  state.referencesStopPosition = null;

  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
    const pageData = await extractPageData(pageNumber);
    if (pageData.chunks.length > 0) {
      state.documentHasText = true;
    }

    if (state.referencesStopPosition === null && pageData.referencesStartParagraphIndex !== null) {
      state.referencesStopPosition = {
        pageNumber,
        paragraphIndex: pageData.referencesStartParagraphIndex
      };
    }
  }
}

async function renderPage(pageNumber) {
  if (!state.pdf) {
    return;
  }

  state.currentPage = clamp(pageNumber, 1, state.pdf.numPages);
  const page = await state.pdf.getPage(state.currentPage);
  const unscaledViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(360, els.canvasWrap.clientWidth - 28);
  const scale = Math.min(1.7, Math.max(0.85, availableWidth / unscaledViewport.width));
  const viewport = page.getViewport({ scale });

  const context = els.canvas.getContext("2d");
  els.canvas.width = Math.floor(viewport.width);
  els.canvas.height = Math.floor(viewport.height);

  await page.render({
    canvasContext: context,
    viewport
  }).promise;

  if (!state.pageCache.has(state.currentPage)) {
    await extractPageData(state.currentPage);
  }

  state.currentChunkIndex = 0;
  state.currentSentenceIndex = 0;
  renderTextChunks();
  updateControls();
}

async function extractPageData(pageNumber) {
  if (state.pageCache.has(pageNumber)) {
    return state.pageCache.get(pageNumber);
  }

  const page = await state.pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const textItems = extractStructuredTextItems(textContent.items, pageNumber);
  const orderedPage = buildOrderedPageContent(textItems, pageNumber);
  const paragraphs = orderedPage.paragraphTexts.map((text, paragraphIndex) => ({
    text,
    paragraphIndex,
    sentences: splitSentences(text)
  }));
  const chunks = paragraphs.flatMap((paragraph) => paragraphToChunks(paragraph, pageNumber));
  const pageData = {
    pageNumber,
    layout: orderedPage.layout,
    orderedText: orderedPage.orderedText,
    paragraphs,
    chunks,
    paragraphCount: paragraphs.length,
    referencesStartParagraphIndex: findReferencesStartParagraphIndex(orderedPage.paragraphTexts)
  };

  state.pageCache.set(pageNumber, pageData);
  return pageData;
}

function extractStructuredTextItems(items, pageNumber) {
  return items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .map((item) => {
      const text = normalizeWhitespace(item.str);
      const x = Number(item.transform?.[4]) || 0;
      const y = Number(item.transform?.[5]) || 0;
      const height = Number(item.height) || Math.abs(Number(item.transform?.[3]) || 0) || 10;
      const width = Number(item.width) || Math.abs(Number(item.transform?.[0]) || 0) * Math.max(text.length, 1) || 0;

      return {
        text,
        x,
        y,
        width,
        height,
        endX: x + width,
        hasEOL: Boolean(item.hasEOL),
        pageNumber
      };
    })
    .filter((item) => item.text);
}

function buildOrderedPageContent(textItems, pageNumber) {
  if (textItems.length === 0) {
    return {
      layout: {
        mode: normalizeLayoutMode(state.layoutMode),
        requestedMode: normalizeLayoutMode(state.layoutMode),
        detectedMode: PDF_LAYOUT_MODES.SINGLE,
        splitX: null,
        minX: null,
        maxX: null,
        leftCount: 0,
        rightCount: 0
      },
      orderedText: "",
      paragraphTexts: []
    };
  }

  const bounds = getTextItemBounds(textItems);
  const layout = resolvePageLayout(textItems, pageNumber, bounds);
  const orderedColumns = layout.mode === PDF_LAYOUT_MODES.TWO
    ? buildForcedTwoColumnContent(textItems, layout, bounds, pageNumber)
    : buildSingleColumnContent(textItems);
  const paragraphTexts = orderedColumns.columnParagraphs.flat();
  const orderedText = paragraphTexts.join("\n\n");

  logPageProcessingDiagnostics(pageNumber, layout, bounds, textItems, orderedColumns);

  return {
    layout: {
      ...layout,
      minX: bounds.minX,
      maxX: bounds.maxX,
      leftCount: orderedColumns.leftItems.length,
      rightCount: orderedColumns.rightItems.length
    },
    orderedText,
    paragraphTexts
  };
}

function getTextItemBounds(textItems) {
  return {
    minX: Math.min(...textItems.map((item) => item.x)),
    maxX: Math.max(...textItems.map((item) => item.x))
  };
}

function resolvePageLayout(textItems, pageNumber, bounds) {
  const requestedMode = normalizeLayoutMode(state.layoutMode);

  if (requestedMode === PDF_LAYOUT_MODES.TWO) {
    const splitX = bounds.minX + ((bounds.maxX - bounds.minX) / 2);
    return {
      mode: PDF_LAYOUT_MODES.TWO,
      requestedMode,
      detectedMode: PDF_LAYOUT_MODES.TWO,
      splitX
    };
  }

  if (requestedMode === PDF_LAYOUT_MODES.SINGLE) {
    return {
      mode: PDF_LAYOUT_MODES.SINGLE,
      requestedMode,
      detectedMode: PDF_LAYOUT_MODES.SINGLE,
      splitX: null
    };
  }

  const detectedMode = detectAutomaticLayout(textItems, bounds);
  return {
    mode: detectedMode.mode,
    requestedMode,
    detectedMode: detectedMode.mode,
    splitX: detectedMode.splitX
  };
}

function detectAutomaticLayout(textItems, bounds) {
  const lines = groupTextItemsIntoLines(textItems);
  const candidateLines = lines
    .filter((line) => line.text.length >= 20)
    .filter((line) => line.width >= 80);

  if (candidateLines.length < 8) {
    return { mode: PDF_LAYOUT_MODES.SINGLE, splitX: null };
  }

  const sortedStarts = candidateLines.slice().sort((a, b) => a.startX - b.startX);
  let bestGap = null;

  for (let index = 0; index < sortedStarts.length - 1; index += 1) {
    const current = sortedStarts[index];
    const next = sortedStarts[index + 1];
    const gapWidth = next.startX - current.startX;
    const leftCount = index + 1;
    const rightCount = sortedStarts.length - leftCount;

    if (leftCount < 3 || rightCount < 3) {
      continue;
    }

    if (gapWidth < Math.max(36, (bounds.maxX - bounds.minX) * 0.12)) {
      continue;
    }

    if (!bestGap || gapWidth > bestGap.gapWidth) {
      bestGap = {
        gapWidth,
        splitX: current.startX + gapWidth / 2
      };
    }
  }

  if (!bestGap) {
    return { mode: PDF_LAYOUT_MODES.SINGLE, splitX: null };
  }

  return {
    mode: PDF_LAYOUT_MODES.TWO,
    splitX: bestGap.splitX
  };
}

function buildSingleColumnContent(textItems) {
  const lines = groupTextItemsIntoLines(textItems);
  return {
    leftItems: textItems,
    rightItems: [],
    columnParagraphs: [linesToParagraphs(lines)]
  };
}

function buildForcedTwoColumnContent(textItems, layout, bounds, pageNumber) {
  const splitX = layout.splitX ?? (bounds.minX + ((bounds.maxX - bounds.minX) / 2));
  const leftItems = textItems.filter((item) => item.x < splitX);
  const rightItems = textItems.filter((item) => item.x >= splitX);
  const leftLines = groupTextItemsIntoLines(leftItems);
  const rightLines = groupTextItemsIntoLines(rightItems);
  const leftParagraphs = linesToParagraphs(leftLines);
  const rightParagraphs = linesToParagraphs(rightLines);

  return {
    leftItems,
    rightItems,
    columnParagraphs: [leftParagraphs, rightParagraphs]
  };
}

function groupTextItemsIntoLines(items) {
  const textItems = items.slice().sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const lines = [];

  for (const item of textItems) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - item.y) > Math.max(4, Math.min(last.height, item.height) * 0.6)) {
      lines.push({
        pageNumber: item.pageNumber,
        y: item.y,
        height: item.height,
        items: [item],
        forceBreak: item.hasEOL
      });
      continue;
    }

    last.items.push(item);
    last.forceBreak = last.forceBreak || item.hasEOL;
    last.height = Math.max(last.height, item.height);
  }

  return lines
    .map((line) => finalizeLine(line))
    .filter((line) => line.text);
}

function finalizeLine(line) {
  const items = line.items.slice().sort((a, b) => a.x - b.x);
  const startX = Math.min(...items.map((item) => item.x));
  const endX = Math.max(...items.map((item) => item.endX));

  return {
    pageNumber: line.pageNumber,
    y: line.y,
    height: line.height,
    items,
    forceBreak: line.forceBreak,
    startX,
    endX,
    width: Math.max(0, endX - startX),
    text: joinLineText(items)
  };
}

function joinLineText(items) {
  return normalizeWhitespace(items.map((item) => item.text).join(" "));
}

function linesToParagraphs(lines) {
  const paragraphs = [];
  let current = [];
  let previousLine = null;

  for (const line of lines) {
    if (previousLine) {
      const gap = Math.abs(previousLine.y - line.y);
      const paragraphBreak = gap > Math.max(previousLine.height * 1.65, 16);
      const previousLooksEnded = /[.!?:;)"']$/.test(previousLine.text);

      if (paragraphBreak && previousLooksEnded) {
        pushParagraph(paragraphs, current);
        current = [];
      }
    }

    current.push(line.text);
    previousLine = line;
  }

  pushParagraph(paragraphs, current);
  return paragraphs;
}

function pushParagraph(paragraphs, lines) {
  const text = normalizeWhitespace(lines.join(" "));
  if (text) {
    paragraphs.push(text);
  }
}

function paragraphToChunks(paragraph, pageNumber) {
  const { paragraphIndex, sentences } = paragraph;
  const chunks = [];
  let currentSentences = [];
  let currentLength = 0;
  let paragraphSentenceStart = 0;

  for (const sentence of sentences) {
    const nextLength = currentLength + sentence.text.length;
    if (currentSentences.length > 0 && nextLength > 700) {
      chunks.push(makeChunk(
        currentSentences,
        pageNumber,
        paragraphIndex,
        paragraphSentenceStart,
        sentences.length
      ));
      paragraphSentenceStart += currentSentences.length;
      currentSentences = [];
      currentLength = 0;
    }

    currentSentences.push(sentence);
    currentLength += sentence.text.length;
  }

  if (currentSentences.length > 0) {
    chunks.push(makeChunk(
      currentSentences,
      pageNumber,
      paragraphIndex,
      paragraphSentenceStart,
      sentences.length
    ));
  }

  return chunks;
}

function makeChunk(sentences, pageNumber, paragraphIndex, paragraphSentenceStart, paragraphSentenceCount) {
  return {
    pageNumber,
    paragraphIndex,
    paragraphSentenceStart,
    paragraphSentenceCount,
    text: sentences.map((sentence) => sentence.text).join(" "),
    sentences
  };
}

function splitSentences(text) {
  const sentences = [];

  if ("Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    for (const segment of segmenter.segment(text)) {
      const sentence = segment.segment.trim();
      if (sentence) {
        sentences.push({ text: sentence });
      }
    }
  } else {
    const pattern = /[^.!?]+(?:[.!?]+["')\]]*)?/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const sentence = match[0].trim();
      if (sentence) {
        sentences.push({ text: sentence });
      }
    }
  }

  return sentences.length > 0 ? sentences : [{ text }];
}

function renderTextChunks() {
  const pageData = state.pageCache.get(state.currentPage);
  els.textChunks.innerHTML = "";

  if (!pageData || pageData.chunks.length === 0) {
    const message = document.createElement("div");
    message.className = "empty-state";
    message.textContent = state.documentHasText
      ? "No selectable text was found on this page."
      : "This PDF does not appear to contain selectable text. OCR support can be added later.";
    els.textChunks.appendChild(message);
    return;
  }

  pageData.chunks.forEach((chunk, chunkIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chunk";
    button.dataset.chunkIndex = String(chunkIndex);
    button.dataset.active = String(chunkIndex === state.currentChunkIndex);

    chunk.sentences.forEach((sentence, sentenceIndex) => {
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.sentenceIndex = String(sentenceIndex);
      span.dataset.active = String(
        chunkIndex === state.currentChunkIndex && sentenceIndex === state.currentSentenceIndex
      );
      span.textContent = sentence.text;
      button.appendChild(span);

      if (sentenceIndex < chunk.sentences.length - 1) {
        button.appendChild(document.createTextNode(" "));
      }
    });

    button.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const sentenceTarget = target?.closest(".sentence");
      state.currentChunkIndex = chunkIndex;
      state.currentSentenceIndex = sentenceTarget
        ? Number(sentenceTarget.dataset.sentenceIndex)
        : 0;
      renderTextChunks();
      playFromCurrentChunk();
    });

    els.textChunks.appendChild(button);
  });
}

function playFromCurrentChunk() {
  const pageData = state.pageCache.get(state.currentPage);
  const position = pageData
    ? findSpeakableSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, {
      direction: 1,
      includeCurrent: true
    })
    : null;

  if (!position) {
    setStatus("No speakable text remains on this page.");
    return;
  }

  state.currentChunkIndex = position.chunkIndex;
  state.currentSentenceIndex = position.sentenceIndex;
  startCurrentSentence();
}

function startCurrentSentence() {
  cancelCurrentSpeech();
  state.status = "speaking";
  speakCurrentSentence();
}

function speakCurrentSentence() {
  const sentence = getCurrentSentence();
  const speechText = sentence ? cleanForSpeech(sentence.text, state.speechFilters) : "";

  if (!sentence || !speechText) {
    const pageData = state.pageCache.get(state.currentPage);
    const nextPosition = pageData
      ? findSpeakableSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, {
        direction: 1,
        includeCurrent: false
      })
      : null;

    if (nextPosition) {
      state.currentChunkIndex = nextPosition.chunkIndex;
      state.currentSentenceIndex = nextPosition.sentenceIndex;
      speakCurrentSentence();
      return;
    }

    state.status = "idle";
    setStatus("Finished page.");
    updateControls();
    return;
  }

  const runId = ++state.speechRunId;
  renderTextChunks();
  scrollCurrentSentenceIntoView();
  setStatus(currentSentenceLabel());

  const utterance = new SpeechSynthesisUtterance(speechText);
  utterance.rate = state.prefs.rate;

  const voice = findPreferredVoice(state.prefs.voiceName);
  if (voice) {
    utterance.voice = voice;
  }

  utterance.onend = () => {
    if (runId !== state.speechRunId || state.status !== "speaking") {
      return;
    }

    if (!moveSentence(1, false)) {
      state.status = "idle";
      setStatus("Finished page.");
      updateControls();
    }
  };

  utterance.onerror = () => {
    if (runId !== state.speechRunId) {
      return;
    }

    state.status = "idle";
    setStatus("Speech stopped.");
    updateControls();
  };

  state.utterance = utterance;
  window.speechSynthesis.speak(utterance);
  updateControls();
}

function moveSentence(direction, shouldSpeak) {
  const pageData = state.pageCache.get(state.currentPage);
  if (!pageData || pageData.chunks.length === 0) {
    return false;
  }

  const nextPosition = findSpeakableSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, {
    direction,
    includeCurrent: false
  });

  if (!nextPosition) {
    renderTextChunks();
    updateControls();
    return false;
  }

  state.currentChunkIndex = nextPosition.chunkIndex;
  state.currentSentenceIndex = nextPosition.sentenceIndex;

  if (shouldSpeak || state.status === "speaking") {
    startCurrentSentence();
  } else {
    renderTextChunks();
    scrollCurrentSentenceIntoView();
    setStatus(currentSentenceLabel());
  }

  return true;
}

function moveParagraph(direction, shouldSpeak) {
  const pageData = state.pageCache.get(state.currentPage);
  const currentChunk = getCurrentChunk();
  if (!pageData || !currentChunk) {
    return false;
  }

  const nextPosition = findSpeakableParagraphPosition(pageData, currentChunk.paragraphIndex, direction);
  if (!nextPosition) {
    renderTextChunks();
    updateControls();
    return false;
  }

  state.currentChunkIndex = nextPosition.chunkIndex;
  state.currentSentenceIndex = nextPosition.sentenceIndex;

  if (shouldSpeak || state.status === "speaking") {
    startCurrentSentence();
  } else {
    renderTextChunks();
    scrollCurrentSentenceIntoView();
    setStatus(currentSentenceLabel());
    updateControls();
  }

  return true;
}

async function movePage(direction) {
  if (!state.pdf) {
    return;
  }

  const wasSpeaking = state.status === "speaking";
  cancelCurrentSpeech();
  await renderPage(state.currentPage + direction);

  if (wasSpeaking) {
    playFromCurrentChunk();
  }
}

function pauseReading() {
  window.speechSynthesis.pause();
  state.status = "paused";
  setStatus("Paused.");
  updateControls();
}

function resumeReading() {
  window.speechSynthesis.resume();
  state.status = "speaking";
  setStatus(currentSentenceLabel());
  updateControls();
}

function stopReading() {
  cancelCurrentSpeech();
  state.status = "idle";
  setStatus("Stopped.");
  updateControls();
}

function cancelCurrentSpeech() {
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending || window.speechSynthesis.paused) {
    state.speechRunId += 1;
    window.speechSynthesis.cancel();
  }
}

function getCurrentSentence() {
  const chunk = getCurrentChunk();
  return chunk?.sentences[state.currentSentenceIndex] || null;
}

function getCurrentChunk() {
  const pageData = state.pageCache.get(state.currentPage);
  return pageData?.chunks[state.currentChunkIndex] || null;
}

function getCurrentParagraph() {
  const pageData = state.pageCache.get(state.currentPage);
  const currentChunk = getCurrentChunk();
  if (!pageData || !currentChunk) {
    return null;
  }

  return pageData.paragraphs[currentChunk.paragraphIndex] || null;
}

function scrollCurrentSentenceIntoView() {
  const selector = `.chunk[data-chunk-index="${state.currentChunkIndex}"] .sentence[data-sentence-index="${state.currentSentenceIndex}"]`;
  const active = els.textChunks.querySelector(selector);
  if (!active || !state.followReadingPosition) {
    return;
  }

  queueFollowScroll(active);
}

function queueFollowScroll(activeElement) {
  const now = Date.now();
  const minDelayMs = 140;

  if (state.scrollFrameId) {
    cancelAnimationFrame(state.scrollFrameId);
  }

  if (now - state.lastScrollAt < minDelayMs) {
    state.scrollFrameId = requestAnimationFrame(() => {
      performFollowScroll(activeElement);
    });
    return;
  }

  performFollowScroll(activeElement);
}

function performFollowScroll(activeElement) {
  const container = els.textChunks;
  if (!container || !activeElement.isConnected || !state.followReadingPosition) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const activeRect = activeElement.getBoundingClientRect();
  const topSafe = containerRect.top + Math.min(96, containerRect.height * 0.22);
  const bottomSafe = containerRect.bottom - Math.min(56, containerRect.height * 0.14);
  const fullyVisible = activeRect.top >= topSafe && activeRect.bottom <= bottomSafe;

  if (fullyVisible) {
    return;
  }

  const stickyOffset = document.querySelector(".sticky-shell")?.getBoundingClientRect().height || 0;
  const targetTop = activeElement.offsetTop - Math.max(24, (container.clientHeight - activeElement.offsetHeight) * 0.32) - stickyOffset * 0.08;
  const nextTop = clamp(targetTop, 0, Math.max(0, container.scrollHeight - container.clientHeight));

  container.scrollTo({
    top: nextTop,
    behavior: "smooth"
  });

  state.lastScrollAt = Date.now();
  state.scrollFrameId = null;
}

function currentSentenceLabel() {
  const pageData = state.pageCache.get(state.currentPage);
  const chunk = getCurrentChunk();
  if (!pageData || !chunk) {
    return "Ready";
  }

  const sentenceNumber = chunk.paragraphSentenceStart + state.currentSentenceIndex + 1;
  return `Page ${state.currentPage}, paragraph ${chunk.paragraphIndex + 1} of ${pageData.paragraphCount}, sentence ${sentenceNumber} of ${chunk.paragraphSentenceCount}`;
}

function currentPositionLabel() {
  if (!state.pdf) {
    return "Ready";
  }

  const pageData = state.pageCache.get(state.currentPage);
  const chunk = getCurrentChunk();
  if (!pageData || !chunk) {
    return state.documentHasText
      ? `Page ${state.currentPage} of ${state.pdf.numPages}`
      : `Page ${state.currentPage} | No selectable text`;
  }

  const sentenceNumber = chunk.paragraphSentenceStart + state.currentSentenceIndex + 1;
  return `Page ${state.currentPage} | Paragraph ${chunk.paragraphIndex + 1}/${pageData.paragraphCount} | Sentence ${sentenceNumber}/${chunk.paragraphSentenceCount}`;
}

function updateControls() {
  const hasPdf = Boolean(state.pdf);
  const pageData = state.pageCache.get(state.currentPage);
  const hasText = Boolean(pageData?.chunks.length);
  const currentChunk = getCurrentChunk();
  const paragraphIndex = currentChunk?.paragraphIndex ?? 0;
  const hasPreviousSentence = Boolean(
    hasText && findSpeakableSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, {
      direction: -1,
      includeCurrent: false
    })
  );
  const hasNextSentence = Boolean(
    hasText && findSpeakableSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, {
      direction: 1,
      includeCurrent: false
    })
  );
  const hasPreviousParagraph = Boolean(hasText && findSpeakableParagraphPosition(pageData, paragraphIndex, -1));
  const hasNextParagraph = Boolean(hasText && findSpeakableParagraphPosition(pageData, paragraphIndex, 1));

  els.play.disabled = !hasText;
  els.pause.disabled = !hasText || state.status !== "speaking";
  els.resume.disabled = !hasText || state.status !== "paused";
  els.stop.disabled = !hasText;
  els.nextSentence.disabled = !hasText || !hasNextSentence;
  els.previousSentence.disabled = !hasText || !hasPreviousSentence;
  els.nextParagraph.disabled = !hasText || !hasNextParagraph;
  els.previousParagraph.disabled = !hasText || !hasPreviousParagraph;
  els.nextPage.disabled = !hasPdf || state.currentPage >= state.pdf.numPages;
  els.previousPage.disabled = !hasPdf || state.currentPage <= 1;
  els.saveSentence.disabled = !hasText;
  els.saveParagraph.disabled = !hasText;
  els.showNavigator.disabled = !hasPdf || !state.documentHasText;
  els.compactStatus.textContent = currentPositionLabel();
  syncNavigatorActiveState();
}

function showImageOnlyMessage() {
  setStatus("This PDF does not appear to contain selectable text. OCR support can be added later.");
  renderTextChunks();
}

function showExtractedTextPreview() {
  const pageData = state.pageCache.get(state.currentPage);
  const previewText = pageData
    ? pageData.orderedText.slice(0, 2000)
    : "No extracted text available for this page.";
  const layoutLabel = pageData?.layout?.mode || normalizeLayoutMode(state.layoutMode);

  els.textPreviewMeta.textContent = state.pdf
    ? `Page ${state.currentPage} / Layout ${layoutLabel}`
    : "No PDF loaded.";
  els.textPreviewContent.textContent = previewText;

  if (!els.textPreviewDialog.open) {
    els.textPreviewDialog.showModal();
  }
}

function closeExtractedTextPreview() {
  if (els.textPreviewDialog.open) {
    els.textPreviewDialog.close();
  }
}

function openReadingNavigator() {
  renderReadingNavigatorList();

  if (!els.readingNavigatorDialog.open) {
    els.readingNavigatorDialog.showModal();
  }

  els.navigatorSearch.focus();
  els.navigatorSearch.select();
}

function closeReadingNavigator() {
  if (els.readingNavigatorDialog.open) {
    els.readingNavigatorDialog.close();
  }
}

function clearCanvas() {
  const context = els.canvas.getContext("2d");
  context.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.canvas.width = 0;
  els.canvas.height = 0;
}

function setStatus(message) {
  clearTimeout(state.statusRestoreTimer);
  els.readerStatus.textContent = message;
}

async function saveCurrentSnippet(type) {
  if (!snippetsApi?.saveSnippet) {
    const diagnostics = getSnippetDiagnostics("pdf-reader");
    const error = new Error("Snippet storage helper is unavailable in the PDF reader. Reload the extension page.");
    console.error("Study Reader: PDF snippet helper missing", diagnostics);
    flashStatus(error.message);
    return;
  }

  const currentChunk = getCurrentChunk();
  const snippetText = type === "paragraph"
    ? getCurrentParagraph()?.text
    : getCurrentSentence()?.text;

  if (!snippetText) {
    flashStatus("Nothing to save yet.");
    return;
  }

  try {
    const result = await snippetsApi.saveSnippet({
      text: snippetText,
      snippetType: type,
      sourceType: "pdf",
      sourceId: buildPdfSourceId(),
      sourceTitle: state.pdfTitle || state.fileName || document.title || "PDF",
      sourceUrl: null,
      pdfFileName: state.fileName || null,
      pageNumber: state.currentPage,
      paragraphIndex: currentChunk?.paragraphIndex ?? null,
      sentenceIndex: type === "sentence" ? state.currentSentenceIndex : null,
      note: ""
    });

    flashStatus(result.duplicate
      ? `${capitalize(type)} already saved.`
      : `${capitalize(type)} saved.`);
  } catch (error) {
    console.error("Study Reader: failed to save PDF snippet", error);
    flashStatus(error.message || "Could not save snippet.");
  }
}

function flashStatus(message) {
  const restoreMessage = currentReaderStatus();
  setStatus(message);
  state.statusRestoreTimer = setTimeout(() => {
    els.readerStatus.textContent = restoreMessage;
  }, 1800);
}

function currentReaderStatus() {
  if (state.status === "paused") {
    return "Paused.";
  }

  if (state.status === "speaking") {
    return currentSentenceLabel();
  }

  if (!state.documentHasText) {
    return "This PDF does not appear to contain selectable text. OCR support can be added later.";
  }

  return "Ready";
}

function toggleFilterMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  setFilterMenuOpen(!state.filterMenuOpen);
}

function setFilterMenuOpen(isOpen) {
  state.filterMenuOpen = Boolean(isOpen);
  els.filterMenuPanel.hidden = !state.filterMenuOpen;
  els.filterMenuButton.setAttribute("aria-expanded", String(state.filterMenuOpen));
}

function handleDocumentPointerDown(event) {
  if (!state.filterMenuOpen) {
    return;
  }

  const target = event.target instanceof Node ? event.target : null;
  if (target && els.filterMenuWrap.contains(target)) {
    return;
  }

  setFilterMenuOpen(false);
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape" && state.filterMenuOpen) {
    setFilterMenuOpen(false);
  }
}

function syncSpeechFilterControls() {
  els.skipCitations.checked = state.speechFilters.skipCitations;
  els.skipParentheticalText.checked = state.speechFilters.skipParentheticalText;
  els.skipBracketCitations.checked = state.speechFilters.skipBracketCitations;
  els.skipUrlsDois.checked = state.speechFilters.skipUrlsDois;
  els.skipFigureTableReferences.checked = state.speechFilters.skipFigureTableReferences;
  els.stopBeforeReferencesSection.checked = state.speechFilters.stopBeforeReferencesSection;
}

function getActiveSpeechFilterCount(filters = state.speechFilters) {
  return Object.values(filters).filter(Boolean).length;
}

function updateFilterMenuSummary() {
  const activeCount = getActiveSpeechFilterCount();
  els.filterMenuSummary.textContent = activeCount > 0 ? `${activeCount} on` : "Off";
}

function getNavigatorParagraphRecords() {
  if (!state.pdf) {
    return [];
  }

  const records = [];

  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
    const pageData = state.pageCache.get(pageNumber);
    if (!pageData) {
      continue;
    }

    pageData.paragraphs.forEach((paragraph, paragraphIndex) => {
      records.push({
        id: `${pageNumber}:${paragraphIndex}`,
        pageNumber,
        paragraphIndex,
        text: paragraph.text,
        preview: formatParagraphPreview(paragraph.text)
      });
    });
  }

  return records;
}

function renderReadingNavigatorList() {
  const records = getNavigatorParagraphRecords();
  const query = normalizeWhitespace(els.navigatorSearch.value || "").toLowerCase();
  const filteredRecords = query
    ? records.filter((record) => buildNavigatorSearchText(record).includes(query))
    : records;

  if (!state.pdf) {
    els.readingNavigatorMeta.textContent = "No PDF loaded.";
  } else {
    els.readingNavigatorMeta.textContent = `${filteredRecords.length} of ${records.length} paragraphs shown.`;
  }

  els.readingNavigatorList.replaceChildren();

  if (!state.pdf) {
    els.readingNavigatorList.appendChild(makeNavigatorEmptyState("Open a PDF to browse paragraphs."));
    return;
  }

  if (records.length === 0) {
    els.readingNavigatorList.appendChild(makeNavigatorEmptyState("No extracted paragraphs are available for this PDF."));
    return;
  }

  if (filteredRecords.length === 0) {
    els.readingNavigatorList.appendChild(makeNavigatorEmptyState("No paragraphs match your search."));
    return;
  }

  filteredRecords.forEach((record) => {
    const item = document.createElement("section");
    item.className = "navigator-item";
    item.dataset.pageNumber = String(record.pageNumber);
    item.dataset.paragraphIndex = String(record.paragraphIndex);
    item.dataset.active = String(isCurrentParagraph(record.pageNumber, record.paragraphIndex));

    const header = document.createElement("div");
    header.className = "navigator-item-header";

    const title = document.createElement("p");
    title.className = "navigator-item-title";
    title.textContent = `Page ${record.pageNumber} · Paragraph ${record.paragraphIndex + 1}`;
    header.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "navigator-item-actions";

    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.textContent = "Start here";
    startButton.addEventListener("click", async () => {
      await jumpToParagraph(record.pageNumber, record.paragraphIndex, { play: false });
    });
    actions.appendChild(startButton);

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "primary";
    playButton.textContent = "Play from here";
    playButton.addEventListener("click", async () => {
      await jumpToParagraph(record.pageNumber, record.paragraphIndex, { play: true });
    });
    actions.appendChild(playButton);

    header.appendChild(actions);
    item.appendChild(header);

    const preview = document.createElement("p");
    preview.className = "navigator-item-preview";
    preview.textContent = record.preview;
    item.appendChild(preview);

    els.readingNavigatorList.appendChild(item);
  });
}

function makeNavigatorEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "navigator-empty";
  empty.textContent = message;
  return empty;
}

function buildNavigatorSearchText(record) {
  return normalizeWhitespace(`page ${record.pageNumber} paragraph ${record.paragraphIndex + 1} ${record.text}`).toLowerCase();
}

function formatParagraphPreview(text) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 197).trimEnd()}...`;
}

function isCurrentParagraph(pageNumber, paragraphIndex) {
  const currentChunk = getCurrentChunk();
  return state.currentPage === pageNumber && currentChunk?.paragraphIndex === paragraphIndex;
}

function syncNavigatorActiveState() {
  if (!els.readingNavigatorDialog.open) {
    return;
  }

  const activePage = state.currentPage;
  const activeParagraph = getCurrentChunk()?.paragraphIndex;

  els.readingNavigatorList.querySelectorAll(".navigator-item").forEach((item) => {
    const matches = Number(item.dataset.pageNumber) === activePage
      && Number(item.dataset.paragraphIndex) === activeParagraph;
    item.dataset.active = String(matches);
  });
}

async function jumpToParagraph(pageNumber, paragraphIndex, { play = false } = {}) {
  if (!state.pdf) {
    return false;
  }

  cancelCurrentSpeech();
  state.status = "idle";

  await renderPage(pageNumber);

  const pageData = state.pageCache.get(pageNumber);
  const nextPosition = findParagraphStartPosition(pageData, paragraphIndex);
  if (!nextPosition) {
    setStatus("Could not find that paragraph.");
    updateControls();
    return false;
  }

  state.currentChunkIndex = nextPosition.chunkIndex;
  state.currentSentenceIndex = 0;
  renderTextChunks();
  scrollCurrentSentenceIntoView();
  updateControls();

  if (play) {
    closeReadingNavigator();
    startCurrentSentence();
    return true;
  }

  closeReadingNavigator();
  setStatus(`Ready to read from Page ${pageNumber}, Paragraph ${paragraphIndex + 1}.`);
  return true;
}

function getAdjacentSentencePosition(pageData, chunkIndex, sentenceIndex, direction) {
  const chunk = pageData.chunks[chunkIndex];
  if (!chunk) {
    return null;
  }

  let nextChunkIndex = chunkIndex;
  let nextSentenceIndex = sentenceIndex + direction;

  if (direction > 0 && nextSentenceIndex >= chunk.sentences.length) {
    nextChunkIndex += 1;
    nextSentenceIndex = 0;
  } else if (direction < 0 && nextSentenceIndex < 0) {
    nextChunkIndex -= 1;
    if (nextChunkIndex >= 0) {
      nextSentenceIndex = pageData.chunks[nextChunkIndex].sentences.length - 1;
    }
  }

  if (nextChunkIndex < 0 || nextChunkIndex >= pageData.chunks.length) {
    return null;
  }

  return {
    chunkIndex: nextChunkIndex,
    sentenceIndex: nextSentenceIndex
  };
}

function findSpeakableSentencePosition(pageData, chunkIndex, sentenceIndex, { direction = 1, includeCurrent = false } = {}) {
  let position = includeCurrent
    ? { chunkIndex, sentenceIndex }
    : getAdjacentSentencePosition(pageData, chunkIndex, sentenceIndex, direction);

  while (position) {
    if (isSentenceSpeakable(pageData, position.chunkIndex, position.sentenceIndex)) {
      return position;
    }

    position = getAdjacentSentencePosition(pageData, position.chunkIndex, position.sentenceIndex, direction);
  }

  return null;
}

function findParagraphStartPosition(pageData, paragraphIndex) {
  if (paragraphIndex < 0 || paragraphIndex >= pageData.paragraphs.length) {
    return null;
  }

  for (let chunkIndex = 0; chunkIndex < pageData.chunks.length; chunkIndex += 1) {
    const chunk = pageData.chunks[chunkIndex];
    if (chunk.paragraphIndex !== paragraphIndex) {
      continue;
    }

    return {
      chunkIndex,
      sentenceIndex: 0
    };
  }

  return null;
}

function findSpeakableParagraphPosition(pageData, currentParagraphIndex, direction) {
  let paragraphIndex = currentParagraphIndex + direction;

  while (paragraphIndex >= 0 && paragraphIndex < pageData.paragraphs.length) {
    if (isParagraphSpeakable(pageData.pageNumber, paragraphIndex)) {
      const startPosition = findParagraphStartPosition(pageData, paragraphIndex);
      if (startPosition) {
        const sentencePosition = findSpeakableSentencePosition(
          pageData,
          startPosition.chunkIndex,
          startPosition.sentenceIndex,
          { direction: 1, includeCurrent: true }
        );

        if (sentencePosition && pageData.chunks[sentencePosition.chunkIndex]?.paragraphIndex === paragraphIndex) {
          return sentencePosition;
        }
      }
    }

    paragraphIndex += direction;
  }

  return null;
}

function isSentenceSpeakable(pageData, chunkIndex, sentenceIndex) {
  const chunk = pageData.chunks[chunkIndex];
  if (!chunk || !isParagraphSpeakable(pageData.pageNumber, chunk.paragraphIndex)) {
    return false;
  }

  const sentence = chunk.sentences[sentenceIndex];
  if (!sentence) {
    return false;
  }

  return Boolean(cleanForSpeech(sentence.text, state.speechFilters));
}

function isParagraphSpeakable(pageNumber, paragraphIndex) {
  if (!state.speechFilters.stopBeforeReferencesSection || !state.referencesStopPosition) {
    return true;
  }

  if (pageNumber < state.referencesStopPosition.pageNumber) {
    return true;
  }

  if (pageNumber > state.referencesStopPosition.pageNumber) {
    return false;
  }

  return paragraphIndex < state.referencesStopPosition.paragraphIndex;
}

function populateVoices() {
  if (!("speechSynthesis" in window)) {
    return;
  }

  const voices = window.speechSynthesis.getVoices();
  const currentValue = state.prefs.voiceName || els.voice.value;

  els.voice.replaceChildren(new Option("Default voice", ""));

  voices
    .slice()
    .sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`))
    .forEach((voice) => {
      els.voice.appendChild(new Option(`${voice.name} (${voice.lang})`, voice.name));
    });

  els.voice.value = currentValue;
}

function findPreferredVoice(voiceName) {
  if (!voiceName || !("speechSynthesis" in window)) {
    return null;
  }

  return window.speechSynthesis.getVoices().find((voice) => voice.name === voiceName) || null;
}

function updateRateLabel() {
  els.rateValue.textContent = `${Number(els.rate.value).toFixed(1)}x`;
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
}

function logPageProcessingDiagnostics(pageNumber, layout, bounds, textItems, orderedColumns) {
  if (!state.debugLayout) {
    return;
  }

  const leftParagraphs = orderedColumns.columnParagraphs[0] || [];
  const rightParagraphs = orderedColumns.columnParagraphs[1] || [];
  const leftText = leftParagraphs.join("\n\n");
  const rightText = rightParagraphs.join("\n\n");

  console.info("Study Reader: PDF column extraction", {
    pageNumber,
    selectedLayoutMode: layout.mode,
    requestedMode: layout.requestedMode,
    detectedMode: layout.detectedMode,
    minX: bounds.minX,
    maxX: bounds.maxX,
    splitX: layout.splitX,
    itemCount: textItems.length,
    leftItemCount: orderedColumns.leftItems.length,
    rightItemCount: orderedColumns.rightItems.length,
    leftPreview: leftText.slice(0, 300),
    rightPreview: rightText.slice(0, 300)
  });
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

function buildPdfSourceId() {
  return `pdf:${state.fileName || "unknown"}:${state.fileByteLength || 0}`;
}

async function resolvePdfTitle(fallbackTitle) {
  try {
    const metadata = await state.pdf.getMetadata();
    const infoTitle = typeof metadata?.info?.Title === "string" ? metadata.info.Title.trim() : "";
    const dcTitle = typeof metadata?.metadata?.get === "function"
      ? String(metadata.metadata.get("dc:title") || "").trim()
      : "";

    return infoTitle || dcTitle || fallbackTitle || "";
  } catch (error) {
    console.warn("Study Reader: could not read PDF metadata title", error);
    return fallbackTitle || "";
  }
}

async function savePrefs() {
  const nextPrefs = {
    rate: state.prefs.rate,
    voiceName: state.prefs.voiceName
  };

  if (prefsApi) {
    state.prefs = await prefsApi.savePrefs(nextPrefs);
    return;
  }

  state.prefs = normalizePrefs(nextPrefs);
}

function normalizePrefs(input) {
  return {
    rate: clamp(Number(input.rate) || DEFAULT_PREFS.rate, 0.5, 2),
    voiceName: typeof input.voiceName === "string" ? input.voiceName : ""
  };
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeLayoutMode(mode) {
  if (mode === PDF_LAYOUT_MODES.SINGLE || mode === PDF_LAYOUT_MODES.TWO) {
    return mode;
  }

  return PDF_LAYOUT_MODES.AUTO;
}

function getStoredLayoutMode() {
  try {
    return normalizeLayoutMode(localStorage.getItem(PDF_LAYOUT_STORAGE_KEY));
  } catch (_error) {
    return PDF_LAYOUT_MODES.AUTO;
  }
}

function storeLayoutMode(mode) {
  try {
    localStorage.setItem(PDF_LAYOUT_STORAGE_KEY, normalizeLayoutMode(mode));
  } catch (_error) {
    // Ignore localStorage write failures in restricted contexts.
  }
}

function isPdfLayoutDebugEnabled() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("debugLayout") === "1") {
      return true;
    }

    return localStorage.getItem("studyReaderPdfLayoutDebug") === "1";
  } catch (_error) {
    return false;
  }
}

function getStoredFollowReading() {
  try {
    return localStorage.getItem(PDF_FOLLOW_STORAGE_KEY) !== "0";
  } catch (_error) {
    return true;
  }
}

function storeFollowReading(value) {
  try {
    localStorage.setItem(PDF_FOLLOW_STORAGE_KEY, value ? "1" : "0");
  } catch (_error) {
    // Ignore localStorage write failures in restricted contexts.
  }
}

async function loadSpeechFilters() {
  if (chrome?.storage?.local) {
    try {
      const stored = await chrome.storage.local.get({
        [PDF_SPEECH_FILTERS_STORAGE_KEY]: DEFAULT_SPEECH_FILTERS
      });
      return normalizeSpeechFilters(stored[PDF_SPEECH_FILTERS_STORAGE_KEY]);
    } catch (_error) {
      // Fall through to local fallback.
    }
  }

  try {
    return normalizeSpeechFilters(JSON.parse(localStorage.getItem(PDF_SPEECH_FILTERS_STORAGE_KEY) || "null"));
  } catch (_error) {
    return { ...DEFAULT_SPEECH_FILTERS };
  }
}

async function saveSpeechFilters(filters) {
  const normalized = normalizeSpeechFilters(filters);

  if (chrome?.storage?.local) {
    try {
      await chrome.storage.local.set({ [PDF_SPEECH_FILTERS_STORAGE_KEY]: normalized });
      return;
    } catch (_error) {
      // Fall through to local fallback.
    }
  }

  try {
    localStorage.setItem(PDF_SPEECH_FILTERS_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_error) {
    // Ignore localStorage write failures in restricted contexts.
  }
}

function normalizeSpeechFilters(filters) {
  return {
    skipCitations: Boolean(filters?.skipCitations),
    skipParentheticalText: Boolean(filters?.skipParentheticalText),
    skipBracketCitations: Boolean(filters?.skipBracketCitations),
    skipUrlsDois: Boolean(filters?.skipUrlsDois),
    skipFigureTableReferences: Boolean(filters?.skipFigureTableReferences),
    stopBeforeReferencesSection: Boolean(filters?.stopBeforeReferencesSection)
  };
}

function legacyCleanForSpeech(text, options = DEFAULT_SPEECH_FILTERS) {
  let nextText = String(text || "");

  if (options.skipCitations) {
    nextText = nextText
      .replace(/\[(?:\s*\d+\s*(?:[-–]\s*\d+)?\s*(?:,\s*\d+\s*(?:[-–]\s*\d+)?)*)\]/g, " ")
      .replace(/\((?:[^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/gi, " ")
      .replace(/\((?:pp?\.?\s*\d+(?:\s*[-–]\s*\d+)?)\)/gi, " ");
  }

  return nextText
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}


function cleanForSpeech(text, options = DEFAULT_SPEECH_FILTERS) {
  try {
    const filters = normalizeSpeechFilters(options);
    let nextText = String(text || "");

    if (filters.skipUrlsDois) {
      nextText = nextText
        .replace(/\bhttps?:\/\/\S+/gi, " ")
        .replace(/\bwww\.\S+/gi, " ")
        .replace(/\bdoi:\s*\S+/gi, " ")
        .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi, " ");
    }

    if (filters.skipBracketCitations) {
      nextText = nextText.replace(/\[\s*\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013]\s*\d+)?)*\s*\]/g, " ");
    }

    if (filters.skipCitations) {
      nextText = nextText
        .replace(/\((?:[^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/gi, " ")
        .replace(/\((?:\s*pp?\.?\s*\d+(?:\s*[-\u2013]\s*\d+)?\s*)\)/gi, " ")
        .replace(/\((?:[^()]*\b[A-Z][A-Za-z'’.-]+(?:\s+et\s+al\.)?(?:\s*(?:&|and)\s*[A-Z][A-Za-z'’.-]+)?[^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/g, " ");
    }

    if (filters.skipParentheticalText) {
      let previous = "";
      while (previous !== nextText) {
        previous = nextText;
        nextText = nextText.replace(/\([^()]*\)/g, " ");
      }
    }

    if (filters.skipFigureTableReferences) {
      nextText = nextText
        .replace(/\b(?:see|shown in|as shown in|refer to|in)\s+(?:fig(?:ure)?\.?|table|appendix)\s+[A-Z]?\d+[A-Z]?\b/gi, " ")
        .replace(/\b(?:fig(?:ure)?\.?|table)\s+\d+[A-Z]?\b/gi, " ")
        .replace(/\bappendix\s+[A-Z]\b/gi, " ");
    }

    return nextText
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([([{])\s+/g, "$1")
      .replace(/\s+([)\]}])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .replace(/\s*\n\s*/g, " ")
      .trim();
  } catch (_error) {
    return normalizeWhitespace(String(text || ""));
  }
}

function findReferencesStartParagraphIndex(paragraphTexts) {
  for (let index = 0; index < paragraphTexts.length; index += 1) {
    const candidate = normalizeWhitespace(paragraphTexts[index] || "")
      .replace(/[.:;]+$/g, "");

    if (/^(references|bibliography|works cited)$/i.test(candidate)) {
      return index;
    }
  }

  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readPdfFromIndexedDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("study-reader-pdfs", 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
    };

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("files", "readonly");
      const getRequest = transaction.objectStore("files").get("last");

      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
