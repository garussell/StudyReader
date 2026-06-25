import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");

const DEFAULT_PREFS = {
  rate: 1,
  voiceName: ""
};

const els = {
  fileInput: document.getElementById("pdfFile"),
  fileName: document.getElementById("fileName"),
  canvas: document.getElementById("pdfCanvas"),
  canvasWrap: document.getElementById("canvasWrap"),
  pageStatus: document.getElementById("pageStatus"),
  readerStatus: document.getElementById("readerStatus"),
  textChunks: document.getElementById("textChunks"),
  play: document.getElementById("play"),
  pause: document.getElementById("pause"),
  resume: document.getElementById("resume"),
  stop: document.getElementById("stop"),
  nextSentence: document.getElementById("nextSentence"),
  previousSentence: document.getElementById("previousSentence"),
  nextPage: document.getElementById("nextPage"),
  previousPage: document.getElementById("previousPage"),
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rateValue"),
  voice: document.getElementById("voice")
};

const state = {
  pdf: null,
  fileName: "",
  currentPage: 1,
  pageCache: new Map(),
  currentChunkIndex: 0,
  currentSentenceIndex: 0,
  prefs: { ...DEFAULT_PREFS },
  status: "idle",
  utterance: null,
  speechRunId: 0,
  documentHasText: false
};

init();

async function init() {
  state.prefs = normalizePrefs(await chrome.storage.sync.get(DEFAULT_PREFS));
  els.rate.value = String(state.prefs.rate);
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
  els.nextPage.addEventListener("click", () => movePage(1));
  els.previousPage.addEventListener("click", () => movePage(-1));

  els.rate.addEventListener("input", async () => {
    state.prefs.rate = Number(els.rate.value);
    updateRateLabel();
    await savePrefs();
  });

  els.voice.addEventListener("change", async () => {
    state.prefs.voiceName = els.voice.value;
    await savePrefs();
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

async function loadPdf(bytes, name) {
  stopReading();
  setStatus("Loading PDF...");
  clearCanvas();
  els.textChunks.innerHTML = "";
  state.fileName = name;
  state.currentPage = 1;
  state.pageCache.clear();
  state.currentChunkIndex = 0;
  state.currentSentenceIndex = 0;
  state.documentHasText = false;

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdf = await loadingTask.promise;
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
  const lines = textItemsToLines(textContent.items);
  const paragraphs = linesToParagraphs(lines);
  const chunks = paragraphs.flatMap((paragraph) => paragraphToChunks(paragraph, pageNumber));
  const pageData = { pageNumber, chunks };

  state.pageCache.set(pageNumber, pageData);
  return pageData;
}

function textItemsToLines(items) {
  const textItems = items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: Math.round(item.transform[5]),
      height: item.height || Math.abs(item.transform[3]) || 10,
      hasEOL: Boolean(item.hasEOL)
    }))
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3) {
        return b.y - a.y;
      }
      return a.x - b.x;
    });

  const lines = [];

  for (const item of textItems) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - item.y) > Math.max(4, item.height * 0.45)) {
      lines.push({
        y: item.y,
        height: item.height,
        parts: [item.text],
        forceBreak: item.hasEOL
      });
      continue;
    }

    last.parts.push(item.text);
    last.forceBreak = last.forceBreak || item.hasEOL;
  }

  return lines.map((line) => ({
    text: normalizeWhitespace(line.parts.join(" ")),
    y: line.y,
    height: line.height
  })).filter((line) => line.text);
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
  const sentences = splitSentences(paragraph);
  const chunks = [];
  let currentSentences = [];
  let currentLength = 0;

  for (const sentence of sentences) {
    const nextLength = currentLength + sentence.length;
    if (currentSentences.length > 0 && nextLength > 700) {
      chunks.push(makeChunk(currentSentences, pageNumber));
      currentSentences = [];
      currentLength = 0;
    }

    currentSentences.push(sentence);
    currentLength += sentence.length;
  }

  if (currentSentences.length > 0) {
    chunks.push(makeChunk(currentSentences, pageNumber));
  }

  return chunks;
}

function makeChunk(sentences, pageNumber) {
  return {
    pageNumber,
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
    setStatus(state.documentHasText
      ? "No selectable text was found on this page."
      : "This PDF does not appear to contain selectable text. OCR support can be added later.");
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

  let chunkIndex = state.currentChunkIndex;
  let sentenceIndex = state.currentSentenceIndex + direction;
  const currentChunk = pageData.chunks[chunkIndex];

  if (sentenceIndex >= currentChunk.sentences.length) {
    chunkIndex += 1;
    sentenceIndex = 0;
  } else if (sentenceIndex < 0) {
    chunkIndex -= 1;
    if (chunkIndex >= 0) {
      sentenceIndex = pageData.chunks[chunkIndex].sentences.length - 1;
    }
  }

  if (chunkIndex < 0 || chunkIndex >= pageData.chunks.length) {
    renderTextChunks();
    return false;
  }

  state.currentChunkIndex = chunkIndex;
  state.currentSentenceIndex = sentenceIndex;

  if (shouldSpeak || state.status === "speaking") {
    startCurrentSentence();
  } else {
    renderTextChunks();
    scrollCurrentSentenceIntoView();
    setStatus(currentSentenceLabel());
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
  const pageData = state.pageCache.get(state.currentPage);
  const chunk = pageData?.chunks[state.currentChunkIndex];
  return chunk?.sentences[state.currentSentenceIndex] || null;
}

function scrollCurrentSentenceIntoView() {
  const selector = `.chunk[data-chunk-index="${state.currentChunkIndex}"] .sentence[data-sentence-index="${state.currentSentenceIndex}"]`;
  const active = els.textChunks.querySelector(selector);
  active?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function currentSentenceLabel() {
  const pageData = state.pageCache.get(state.currentPage);
  const chunk = pageData?.chunks[state.currentChunkIndex];
  if (!pageData || !chunk) {
    return "Ready";
  }

  return `Page ${state.currentPage}, chunk ${state.currentChunkIndex + 1} of ${pageData.chunks.length}, sentence ${state.currentSentenceIndex + 1} of ${chunk.sentences.length}`;
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

  els.play.disabled = !hasText;
  els.pause.disabled = !hasText || state.status !== "speaking";
  els.resume.disabled = !hasText || state.status !== "paused";
  els.stop.disabled = !hasText;
  els.nextSentence.disabled = !hasText;
  els.previousSentence.disabled = !hasText;
  els.nextPage.disabled = !hasPdf || state.currentPage >= state.pdf.numPages;
  els.previousPage.disabled = !hasPdf || state.currentPage <= 1;
  updatePageStatus();
}

function showImageOnlyMessage() {
  setStatus("This PDF does not appear to contain selectable text. OCR support can be added later.");
  renderTextChunks();
}

function clearCanvas() {
  const context = els.canvas.getContext("2d");
  context.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.canvas.width = 0;
  els.canvas.height = 0;
}

function setStatus(message) {
  els.readerStatus.textContent = message;
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

function savePrefs() {
  return chrome.storage.sync.set({
    rate: state.prefs.rate,
    voiceName: state.prefs.voiceName
  });
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
