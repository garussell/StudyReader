(function initStudyReaderContentScript() {
  if (window.__studyReaderLoaded) {
    return;
  }

  window.__studyReaderLoaded = true;

  const DEFAULT_PREFS = {
    rate: 1,
    voiceName: ""
  };

  const READABLE_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "article",
    "section",
    "[role='article']",
    "[data-study-reader-source]"
  ].join(",");

  const state = {
    chunks: [],
    currentIndex: 0,
    utterance: null,
    status: "idle",
    prefs: { ...DEFAULT_PREFS },
    lastReadableElement: null,
    speechRunId: 0,
    fallbackHighlight: null,
    miniPlayer: null,
    miniStatus: null
  };

  chrome.storage.sync.get(DEFAULT_PREFS).then((prefs) => {
    state.prefs = normalizePrefs(prefs);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    state.prefs = normalizePrefs({
      ...state.prefs,
      rate: changes.rate?.newValue ?? state.prefs.rate,
      voiceName: changes.voiceName?.newValue ?? state.prefs.voiceName
    });
  });

  document.addEventListener("click", rememberClickedReadableElement, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "STUDY_READER_PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "STUDY_READER_CONTENT_COMMAND") {
      return false;
    }

    handleCommand(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error.message }));

    return true;
  });

  async function handleCommand(payload = {}) {
    ensureMiniPlayer();

    if (payload.command === "UPDATE_PREFS") {
      state.prefs = normalizePrefs(payload);
      return statusResponse("Preferences updated.");
    }

    if (payload.command === "READ_SELECTION") {
      return readSelectionOrClickedParagraph();
    }

    if (payload.command === "PAUSE") {
      window.speechSynthesis.pause();
      state.status = "paused";
      updateMiniStatus("Paused");
      return statusResponse("Paused.");
    }

    if (payload.command === "RESUME") {
      window.speechSynthesis.resume();
      state.status = "speaking";
      updateMiniStatus(currentSentenceLabel());
      return statusResponse("Resumed.");
    }

    if (payload.command === "STOP") {
      stopReading();
      return statusResponse("Stopped.");
    }

    if (payload.command === "NEXT_SENTENCE") {
      return moveSentence(1);
    }

    if (payload.command === "PREVIOUS_SENTENCE") {
      return moveSentence(-1);
    }

    return statusResponse("Unknown command.");
  }

  async function readSelectionOrClickedParagraph() {
    const selectionPlan = createPlanFromSelection();
    const plan = selectionPlan || createPlanFromElement(state.lastReadableElement);

    if (!plan || plan.chunks.length === 0) {
      updateMiniStatus("Select text or click a paragraph first.");
      return statusResponse("Select text or click a paragraph first.");
    }

    startPlan(plan, 0);

    const source = selectionPlan ? "selection" : "clicked paragraph";
    return statusResponse(`Reading ${source}.`);
  }

  async function moveSentence(direction) {
    if (state.chunks.length === 0) {
      updateMiniStatus("Nothing loaded yet.");
      return statusResponse("Nothing loaded yet.");
    }

    const nextIndex = clamp(state.currentIndex + direction, 0, state.chunks.length - 1);
    startCurrentIndex(nextIndex);
    return statusResponse(currentSentenceLabel());
  }

  function startPlan(plan, index) {
    state.chunks = plan.chunks;
    startCurrentIndex(index);
  }

  function startCurrentIndex(index) {
    cancelCurrentSpeech();
    state.currentIndex = clamp(index, 0, state.chunks.length - 1);
    state.status = "speaking";
    speakCurrentChunk();
  }

  function speakCurrentChunk() {
    const chunk = state.chunks[state.currentIndex];
    if (!chunk) {
      stopReading();
      return;
    }

    const runId = ++state.speechRunId;

    highlightChunk(chunk);
    updateMiniStatus(currentSentenceLabel());

    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.rate = state.prefs.rate;

    const voice = findPreferredVoice(state.prefs.voiceName);
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onend = () => {
      if (runId !== state.speechRunId) {
        return;
      }

      if (state.status !== "speaking") {
        return;
      }

      if (state.currentIndex < state.chunks.length - 1) {
        state.currentIndex += 1;
        speakCurrentChunk();
        return;
      }

      state.status = "idle";
      updateMiniStatus("Finished");
      clearHighlight();
    };

    utterance.onerror = () => {
      if (runId !== state.speechRunId) {
        return;
      }

      state.status = "idle";
      updateMiniStatus("Speech stopped");
    };

    state.utterance = utterance;
    window.speechSynthesis.speak(utterance);
  }

  function stopReading() {
    cancelCurrentSpeech();
    state.status = "idle";
    state.chunks = [];
    state.currentIndex = 0;
    clearHighlight();
    updateMiniStatus("Stopped");
  }

  function cancelCurrentSpeech() {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending || window.speechSynthesis.paused) {
      state.speechRunId += 1;
      window.speechSynthesis.cancel();
    }
  }

  function createPlanFromSelection() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const segments = collectTextSegments(range);
    const text = segments.map((segment) => segment.text).join("");
    const sentenceOffsets = splitIntoSentenceOffsets(text);

    return {
      chunks: sentenceOffsets
        .map((offset) => ({
          text: offset.text,
          range: createRangeFromOffsets(segments, offset.start, offset.end)
        }))
        .filter((chunk) => chunk.text.length > 0 && chunk.range)
    };
  }

  function createPlanFromElement(element) {
    if (!element || !document.contains(element)) {
      return null;
    }

    const range = document.createRange();
    range.selectNodeContents(element);

    const segments = collectTextSegments(range);
    const text = segments.map((segment) => segment.text).join("");
    const sentenceOffsets = splitIntoSentenceOffsets(text);

    return {
      chunks: sentenceOffsets
        .map((offset) => ({
          text: offset.text,
          range: createRangeFromOffsets(segments, offset.start, offset.end)
        }))
        .filter((chunk) => chunk.text.length > 0 && chunk.range)
    };
  }

  function collectTextSegments(range) {
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          if (!range.intersectsNode(node)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (node.parentElement?.closest(".study-reader-mini-player")) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const segments = [];
    let index = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;

      if (start >= end) {
        continue;
      }

      const text = node.nodeValue.slice(start, end);
      segments.push({
        node,
        nodeStart: start,
        nodeEnd: end,
        text,
        globalStart: index,
        globalEnd: index + text.length
      });
      index += text.length;
    }

    return segments;
  }

  function createRangeFromOffsets(segments, start, end) {
    const startPoint = findPointForOffset(segments, start);
    const endPoint = findPointForOffset(segments, end, true);

    if (!startPoint || !endPoint) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  }

  function findPointForOffset(segments, offset, preferEnd = false) {
    for (const segment of segments) {
      const isInside = preferEnd
        ? offset > segment.globalStart && offset <= segment.globalEnd
        : offset >= segment.globalStart && offset < segment.globalEnd;

      if (isInside) {
        return {
          node: segment.node,
          offset: segment.nodeStart + (offset - segment.globalStart)
        };
      }
    }

    const edge = preferEnd ? segments[segments.length - 1] : segments[0];
    if (!edge) {
      return null;
    }

    return {
      node: edge.node,
      offset: preferEnd ? edge.nodeEnd : edge.nodeStart
    };
  }

  function splitIntoSentenceOffsets(text) {
    const chunks = [];

    if (!text.trim()) {
      return chunks;
    }

    if ("Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      for (const sentence of segmenter.segment(text)) {
        pushTrimmedChunk(chunks, text, sentence.index, sentence.index + sentence.segment.length);
      }
    } else {
      const pattern = /[^.!?]+(?:[.!?]+["')\]]*)?/g;
      let match;

      while ((match = pattern.exec(text)) !== null) {
        pushTrimmedChunk(chunks, text, match.index, match.index + match[0].length);
      }
    }

    if (chunks.length === 0) {
      pushTrimmedChunk(chunks, text, 0, text.length);
    }

    return chunks;
  }

  function pushTrimmedChunk(chunks, source, start, end) {
    while (start < end && /\s/.test(source[start])) {
      start += 1;
    }

    while (end > start && /\s/.test(source[end - 1])) {
      end -= 1;
    }

    if (start < end) {
      chunks.push({
        start,
        end,
        text: source.slice(start, end)
      });
    }
  }

  function highlightChunk(chunk) {
    clearHighlight();

    if (!chunk.range) {
      return;
    }

    if ("CSS" in window && "highlights" in CSS && "Highlight" in window) {
      CSS.highlights.set("study-reader-current", new Highlight(chunk.range));
      return;
    }

    try {
      const wrapper = document.createElement("span");
      wrapper.className = "study-reader-fallback-highlight";
      chunk.range.surroundContents(wrapper);
      state.fallbackHighlight = wrapper;
    } catch (_error) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(chunk.range);
    }
  }

  function clearHighlight() {
    if ("CSS" in window && "highlights" in CSS) {
      CSS.highlights.delete("study-reader-current");
    }

    if (state.fallbackHighlight) {
      const wrapper = state.fallbackHighlight;
      wrapper.replaceWith(...wrapper.childNodes);
      state.fallbackHighlight = null;
    }
  }

  function rememberClickedReadableElement(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(".study-reader-mini-player")) {
      return;
    }

    const readable = target.closest(READABLE_SELECTOR);
    if (!readable) {
      return;
    }

    const text = readable.textContent?.trim() || "";
    if (text.length >= 20) {
      state.lastReadableElement = readable;
      updateMiniStatus("Paragraph ready");
    }
  }

  function ensureMiniPlayer() {
    if (state.miniPlayer && document.contains(state.miniPlayer)) {
      return;
    }

    const player = document.createElement("div");
    player.className = "study-reader-mini-player";
    player.setAttribute("role", "region");
    player.setAttribute("aria-label", "Study Reader mini-player");

    const status = document.createElement("div");
    status.className = "study-reader-mini-status";
    status.textContent = "Ready";

    const controls = document.createElement("div");
    controls.className = "study-reader-mini-controls";

    const readButton = makeMiniButton("Read", "study-reader-mini-read", () => readSelectionOrClickedParagraph());
    const previousButton = makeMiniButton("Prev", "", () => moveSentence(-1));
    const pauseButton = makeMiniButton("Pause", "", () => handleCommand({ command: "PAUSE" }));
    const resumeButton = makeMiniButton("Resume", "", () => handleCommand({ command: "RESUME" }));
    const nextButton = makeMiniButton("Next", "", () => moveSentence(1));
    const stopButton = makeMiniButton("Stop", "study-reader-mini-stop", () => handleCommand({ command: "STOP" }));
    const collapseButton = makeMiniButton("-", "", () => {
      const collapsed = player.dataset.collapsed === "true";
      player.dataset.collapsed = String(!collapsed);
      collapseButton.textContent = collapsed ? "-" : "+";
    });

    controls.append(readButton, previousButton, pauseButton, resumeButton, nextButton, stopButton);
    player.append(status, controls, collapseButton);
    document.documentElement.appendChild(player);

    state.miniPlayer = player;
    state.miniStatus = status;
  }

  function makeMiniButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = label;

    if (className) {
      button.className = className;
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });

    return button;
  }

  function updateMiniStatus(text) {
    if (state.miniStatus) {
      state.miniStatus.textContent = text;
    }
  }

  function currentSentenceLabel() {
    if (state.chunks.length === 0) {
      return "Ready";
    }

    return `Sentence ${state.currentIndex + 1} of ${state.chunks.length}`;
  }

  function findPreferredVoice(voiceName) {
    if (!voiceName || !("speechSynthesis" in window)) {
      return null;
    }

    return window.speechSynthesis.getVoices().find((voice) => voice.name === voiceName) || null;
  }

  function normalizePrefs(input) {
    return {
      rate: clamp(Number(input.rate) || DEFAULT_PREFS.rate, 0.5, 2),
      voiceName: typeof input.voiceName === "string" ? input.voiceName : ""
    };
  }

  function statusResponse(message) {
    return {
      ok: true,
      message
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();
