import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");

const prefsApi = globalThis.StudyReaderPrefs;
const snippetsApi = globalThis.StudyReaderSnippetStorage || globalThis.StudyReaderSnippets;
const DEFAULT_PREFS = prefsApi?.DEFAULT_PREFS || {
  rate: 1,
  voiceName: ""
};
const PDF_LAYOUT_STORAGE_KEY = "studyReaderPdfLayoutMode";
const PDF_FOLLOW_STORAGE_KEY = "studyReaderPdfFollowReading";
const PDF_LAYOUT_MODES = {
  AUTO: "auto",
  SINGLE: "single",
  TWO: "two"
};

const els = {
  fileInput: document.getElementById("pdfFile"),
  fileName: document.getElementById("fileName"),
  canvas: document.getElementById("pdfCanvas"),
  canvasWrap: document.getElementById("canvasWrap"),
  pageStatus: document.getElementById("pageStatus"),
  positionStatus: document.getElementById("positionStatus"),
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
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rateValue"),
  voice: document.getElementById("voice"),
  layoutMode: document.getElementById("layoutMode"),
  followReading: document.getElementById("followReading"),
  textPreviewDialog: document.getElementById("textPreviewDialog"),
  textPreviewMeta: document.getElementById("textPreviewMeta"),
  textPreviewContent: document.getElementById("textPreviewContent"),
  closePreview: document.getElementById("closePreview")
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
  debugLayout: isPdfLayoutDebugEnabled(),
  status: "idle",
  utterance: null,
  speechRunId: 0,
  documentHasText: false,
  statusRestoreTimer: null,
  scrollFrameId: null,
  lastScrollAt: 0
};

init();

async function init() {
  state.prefs = prefsApi ? await prefsApi.getPrefs() : normalizePrefs(DEFAULT_PREFS);
  els.rate.value = String(state.prefs.rate);
  els.layoutMode.value = state.layoutMode;
  els.followReading.checked = state.followReadingPosition;
  updateRateLabel();
  wireEvents();
  populateVoices();
  updateControls();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

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
  els.closePreview.addEventListener("click", closeExtractedTextPreview);
  els.textPreviewDialog.addEventListener("click", (event) => {
    if (event.target === els.textPreviewDialog) {
      closeExtractedTextPreview();
    }
  });

  els.rate.addEventListener("input", async () => {
    state.prefs.rate = Number(els.rate.value);
    updateRateLabel();
    await savePrefs();
  });

  els.voice.addEventListener("change", async () => {
    state.prefs.voiceName = els.voice.value;
    await savePrefs();
  });

  els.layoutMode.addEventListener("change", async () => {
    await applyLayoutModeChange(els.layoutMode.value);
  });

  els.followReading.addEventListener("change", () => {
    state.followReadingPosition = els.followReading.checked;
    storeFollowReading(state.followReadingPosition);
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

  await preloadTextContent();
  await renderPage(targetPage);
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

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdf = await loadingTask.promise;
  state.pdfTitle = await resolvePdfTitle(name);
  els.fileName.textContent = name;

  await preloadTextContent();
  await renderPage(1);

  if (!state.documentHasText) {
    showImageOnlyMessage();
  } else {
    setStatus("Ready");
  }

  updateControls();
}

async function preloadTextContent() {
  for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
    const pageData = await extractPageData(pageNumber);
    if (pageData.chunks.length > 0) {
      state.documentHasText = true;
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
  updatePageStatus();
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
    paragraphCount: paragraphs.length
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
  const sentence = getCurrentSentence();
  if (!sentence) {
    setStatus("No selectable text was found on this page.");
    return;
  }

  startCurrentSentence();
}

function startCurrentSentence() {
  cancelCurrentSpeech();
  state.status = "speaking";
  speakCurrentSentence();
}

function speakCurrentSentence() {
  const sentence = getCurrentSentence();
  if (!sentence) {
    stopReading();
    return;
  }

  const runId = ++state.speechRunId;
  renderTextChunks();
  scrollCurrentSentenceIntoView();
  setStatus(currentSentenceLabel());

  const utterance = new SpeechSynthesisUtterance(sentence.text);
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

  const nextPosition = getAdjacentSentencePosition(
    pageData,
    state.currentChunkIndex,
    state.currentSentenceIndex,
    direction
  );

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

  const nextPosition = findParagraphStartPosition(pageData, currentChunk.paragraphIndex + direction);
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
      : `Page ${state.currentPage} of ${state.pdf.numPages} / No selectable text`;
  }

  const sentenceNumber = chunk.paragraphSentenceStart + state.currentSentenceIndex + 1;
  return `Paragraph ${chunk.paragraphIndex + 1}/${pageData.paragraphCount} / Sentence ${sentenceNumber}/${chunk.paragraphSentenceCount}`;
}

function updatePageStatus() {
  if (!state.pdf) {
    els.pageStatus.textContent = "No PDF loaded";
    return;
  }

  els.pageStatus.textContent = `Page ${state.currentPage} of ${state.pdf.numPages}`;
}

function updateControls() {
  const hasPdf = Boolean(state.pdf);
  const pageData = state.pageCache.get(state.currentPage);
  const hasText = Boolean(pageData?.chunks.length);
  const currentChunk = getCurrentChunk();
  const paragraphIndex = currentChunk?.paragraphIndex ?? 0;
  const hasPreviousSentence = Boolean(
    hasText && getAdjacentSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, -1)
  );
  const hasNextSentence = Boolean(
    hasText && getAdjacentSentencePosition(pageData, state.currentChunkIndex, state.currentSentenceIndex, 1)
  );
  const hasPreviousParagraph = Boolean(hasText && paragraphIndex > 0);
  const hasNextParagraph = Boolean(hasText && paragraphIndex < (pageData?.paragraphCount ?? 0) - 1);

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
  updatePageStatus();
  els.positionStatus.textContent = currentPositionLabel();
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
