(function initStudyReaderContentScript() {
  if (window.__studyReaderLoaded) {
    return;
  }

  window.__studyReaderLoaded = true;

  const prefsApi = globalThis.StudyReaderPrefs;
  const themeApi = globalThis.StudyReaderTheme;
  const DEFAULT_PREFS = prefsApi?.DEFAULT_PREFS || {
    rate: 1,
    voiceName: ""
  };
  const THEME_STORAGE_KEY = themeApi?.STORAGE_KEY || "studyReaderTheme";
  const THEME_DEBUG = false;
  const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
  const systemThemeMediaQuery = typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_THEME_QUERY)
    : null;

  const READABLE_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "article",
    "section",
    "[role='article']",
    "[data-study-reader-source]"
  ].join(",");

  const MAX_CLICK_READABLE_ELEMENTS = 40;

  const state = {
    plan: null,
    currentParagraphIndex: 0,
    currentSentenceIndex: 0,
    utterance: null,
    status: "idle",
    prefs: { ...DEFAULT_PREFS },
    lastReadableElement: null,
    speechRunId: 0,
    fallbackHighlight: null,
    miniPlayer: null,
    miniStatus: null,
    miniPreview: null,
    miniRate: null,
    miniRateValue: null,
    miniVoice: null,
    miniButtons: {},
    miniStatusText: "Ready",
    miniPreviewText: "Select text or click a paragraph first.",
    statusRestoreTimer: null,
    toastTimer: null,
    miniToast: null,
    themeMode: "system",
    resolvedTheme: "light",
    themeReadyPromise: null
  };

  init();

  async function init() {
    bindStorageListener();
    bindVoiceEvents();
    bindThemeListeners();
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

    state.prefs = prefsApi ? await prefsApi.getPrefs() : normalizePrefs(DEFAULT_PREFS);
    state.themeReadyPromise = refreshThemeState();
    await state.themeReadyPromise;
    syncMiniControlsFromPrefs();
    populateVoices();
  }

  function bindStorageListener() {
    if (!chrome?.storage?.onChanged || !prefsApi?.prefsFromStorageChanges) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      state.prefs = prefsApi.prefsFromStorageChanges(changes, state.prefs);
      syncMiniControlsFromPrefs();
      populateVoices();
    });
  }

  function bindThemeListeners() {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, THEME_STORAGE_KEY)) {
          return;
        }

        const nextTheme = typeof changes[THEME_STORAGE_KEY]?.newValue === "string"
          ? changes[THEME_STORAGE_KEY].newValue
          : undefined;
        refreshThemeState(nextTheme).catch(() => {
          // Ignore transient content-script theme refresh failures.
        });
      });
    }

    if (!systemThemeMediaQuery) {
      return;
    }

    const handleSystemThemeChange = () => {
      if (normalizeSavedTheme(state.themeMode) === "system") {
        refreshThemeState("system").catch(() => {
          // Ignore transient content-script theme refresh failures.
        });
      }
    };

    if (typeof systemThemeMediaQuery.addEventListener === "function") {
      systemThemeMediaQuery.addEventListener("change", handleSystemThemeChange);
    } else if (typeof systemThemeMediaQuery.addListener === "function") {
      systemThemeMediaQuery.addListener(handleSystemThemeChange);
    }
  }

  function bindVoiceEvents() {
    if (!("speechSynthesis" in window)) {
      return;
    }

    if (typeof window.speechSynthesis.addEventListener === "function") {
      window.speechSynthesis.addEventListener("voiceschanged", populateVoices);
      return;
    }

    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

  async function handleCommand(payload = {}) {
    await ensureThemeState();
    ensureMiniPlayer();

    if (payload.command === "UPDATE_PREFS") {
      state.prefs = normalizePrefs(payload);
      syncMiniControlsFromPrefs();
      populateVoices();
      return statusResponse("Preferences updated.");
    }

    if (payload.command === "READ_SELECTION") {
      return readSelectionOrClickedParagraph();
    }

    if (payload.command === "PLAY") {
      return playCurrentSentence();
    }

    if (payload.command === "PAUSE") {
      pauseReading();
      return statusResponse("Paused.");
    }

    if (payload.command === "RESUME") {
      resumeReading();
      return statusResponse("Resumed.");
    }

    if (payload.command === "STOP") {
      stopReading();
      return statusResponse("Stopped.");
    }

    if (payload.command === "NEXT_SENTENCE") {
      return moveSentence(1, true);
    }

    if (payload.command === "PREVIOUS_SENTENCE") {
      return moveSentence(-1, true);
    }

    if (payload.command === "NEXT_PARAGRAPH") {
      return moveParagraph(1, true);
    }

    if (payload.command === "PREVIOUS_PARAGRAPH") {
      return moveParagraph(-1, true);
    }

    return statusResponse("Unknown command.");
  }

  async function readSelectionOrClickedParagraph() {
    const selectionPlan = createPlanFromSelection();
    const plan = selectionPlan || createPlanFromElementSequence(state.lastReadableElement);

    if (!plan || plan.paragraphs.length === 0) {
      updateMiniStatus("Select text or click a paragraph first.");
      updateMiniPreview("No readable text is loaded.");
      updateMiniControls();
      return statusResponse("Select text or click a paragraph first.");
    }

    startPlan(plan, 0, 0);

    const source = selectionPlan ? "selection" : "clicked passage";
    return statusResponse(`Reading ${source}.`);
  }

  async function playCurrentSentence() {
    if (!hasPlan()) {
      return readSelectionOrClickedParagraph();
    }

    startCurrentSentence();
    return statusResponse(currentSentenceLabel());
  }

  async function moveSentence(direction, shouldSpeak) {
    if (!hasPlan()) {
      updateMiniStatus("Nothing loaded yet.");
      updateMiniPreview("Select text or click a paragraph first.");
      updateMiniControls();
      return statusResponse("Nothing loaded yet.");
    }

    const nextPosition = getNextSentencePosition(direction);
    if (!nextPosition) {
      updateMiniStatus(currentSentenceLabel());
      updateMiniPreview(currentSentencePreview());
      updateMiniControls();
      return statusResponse(currentSentenceLabel());
    }

    setCurrentPosition(nextPosition.paragraphIndex, nextPosition.sentenceIndex);
    handlePositionChange(shouldSpeak);
    return statusResponse(currentSentenceLabel());
  }

  async function moveParagraph(direction, shouldSpeak) {
    if (!hasPlan()) {
      updateMiniStatus("Nothing loaded yet.");
      updateMiniPreview("Select text or click a paragraph first.");
      updateMiniControls();
      return statusResponse("Nothing loaded yet.");
    }

    const paragraphIndex = state.currentParagraphIndex + direction;
    const paragraph = state.plan.paragraphs[paragraphIndex];
    if (!paragraph) {
      updateMiniStatus(currentSentenceLabel());
      updateMiniPreview(currentSentencePreview());
      updateMiniControls();
      return statusResponse(currentSentenceLabel());
    }

    setCurrentPosition(paragraphIndex, 0);
    handlePositionChange(shouldSpeak);
    return statusResponse(currentSentenceLabel());
  }

  function startPlan(plan, paragraphIndex, sentenceIndex) {
    state.plan = plan;
    setCurrentPosition(paragraphIndex, sentenceIndex);
    startCurrentSentence();
  }

  function setCurrentPosition(paragraphIndex, sentenceIndex) {
    state.currentParagraphIndex = clamp(paragraphIndex, 0, state.plan.paragraphs.length - 1);
    const paragraph = getCurrentParagraph();
    state.currentSentenceIndex = clamp(sentenceIndex, 0, paragraph.sentences.length - 1);
  }

  function handlePositionChange(shouldSpeak) {
    if (shouldSpeak || state.status === "speaking") {
      startCurrentSentence();
      return;
    }

    updateMiniStatus(currentSentenceLabel());
    updateMiniPreview(currentSentencePreview());
    highlightSentence(getCurrentSentence());
    scrollCurrentSentenceIntoView();
    updateMiniControls();
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

    highlightSentence(sentence);
    scrollCurrentSentenceIntoView();
    updateMiniStatus(currentSentenceLabel());
    updateMiniPreview(currentSentencePreview());

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

      const nextPosition = getNextSentencePosition(1);
      if (!nextPosition) {
        state.status = "idle";
        updateMiniStatus("Finished");
        updateMiniPreview(currentSentencePreview());
        clearHighlight();
        updateMiniControls();
        return;
      }

      setCurrentPosition(nextPosition.paragraphIndex, nextPosition.sentenceIndex);
      speakCurrentSentence();
    };

    utterance.onerror = () => {
      if (runId !== state.speechRunId) {
        return;
      }

      state.status = "idle";
      updateMiniStatus("Speech stopped");
      updateMiniPreview(currentSentencePreview());
      updateMiniControls();
    };

    state.utterance = utterance;
    window.speechSynthesis.speak(utterance);
    updateMiniControls();
  }

  function pauseReading() {
    window.speechSynthesis.pause();
    state.status = "paused";
    updateMiniStatus("Paused");
    updateMiniPreview(currentSentencePreview());
    updateMiniControls();
  }

  function resumeReading() {
    window.speechSynthesis.resume();
    state.status = "speaking";
    updateMiniStatus(currentSentenceLabel());
    updateMiniPreview(currentSentencePreview());
    updateMiniControls();
  }

  function stopReading() {
    cancelCurrentSpeech();
    state.status = "idle";
    clearHighlight();
    updateMiniStatus("Stopped");
    updateMiniPreview(currentSentencePreview());
    updateMiniControls();
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
    const paragraphs = buildParagraphsFromSegments(segments);

    if (paragraphs.length === 0) {
      return null;
    }

    return { paragraphs };
  }

  function createPlanFromElementSequence(element) {
    if (!element || !document.contains(element)) {
      return null;
    }

    const paragraphs = [];
    const readableElements = collectReadableSequence(element);

    readableElements.forEach((readableElement) => {
      const range = document.createRange();
      range.selectNodeContents(readableElement);
      const segments = collectTextSegments(range);
      paragraphs.push(...buildParagraphsFromSegments(segments));
    });

    if (paragraphs.length === 0) {
      return null;
    }

    return { paragraphs };
  }

  function collectReadableSequence(startElement) {
    const readableStart = startElement.closest?.(READABLE_SELECTOR) || startElement;
    const root = readableStart.closest?.("article, main, [role='main'], section") || document.body;
    const readableElements = Array.from(root.querySelectorAll(READABLE_SELECTOR))
      .filter((candidate) => candidate.textContent && normalizeWhitespace(candidate.textContent).length >= 20)
      .filter(isVisible);

    const startIndex = readableElements.indexOf(readableStart);
    if (startIndex === -1) {
      return [readableStart];
    }

    return readableElements.slice(startIndex, startIndex + MAX_CLICK_READABLE_ELEMENTS);
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
          if (typeof node.nodeValue !== "string") {
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
      if (text.length === 0) {
        continue;
      }

      segments.push({
        node,
        nodeStart: start,
        nodeEnd: end,
        text,
        globalStart: index,
        globalEnd: index + text.length,
        paragraphAnchor: getParagraphAnchor(node.parentElement)
      });
      index += text.length;
    }

    return segments;
  }

  function buildParagraphsFromSegments(segments) {
    const paragraphGroups = groupSegmentsByParagraphAnchor(segments);
    const paragraphs = [];

    paragraphGroups.forEach((group) => {
      const rawText = group.map((segment) => segment.text).join("");
      const paragraphOffsets = splitIntoParagraphOffsets(rawText);

      paragraphOffsets.forEach((paragraphOffset) => {
        const sentences = splitIntoSentenceOffsets(paragraphOffset.text)
          .map((sentenceOffset) => {
            const start = paragraphOffset.start + sentenceOffset.start;
            const end = paragraphOffset.start + sentenceOffset.end;
            return {
              text: sentenceOffset.text,
              range: createRangeFromOffsets(group, start, end)
            };
          })
          .filter((sentence) => sentence.text.length > 0);

        if (sentences.length > 0) {
          paragraphs.push({ sentences });
        }
      });
    });

    return paragraphs;
  }

  function groupSegmentsByParagraphAnchor(segments) {
    const groups = [];
    let currentGroup = [];
    let previousAnchor = null;

    segments.forEach((segment) => {
      if (currentGroup.length > 0 && segment.paragraphAnchor !== previousAnchor) {
        groups.push(currentGroup);
        currentGroup = [];
      }

      currentGroup.push(segment);
      previousAnchor = segment.paragraphAnchor;
    });

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
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

  function splitIntoParagraphOffsets(text) {
    const paragraphs = [];

    if (!text.trim()) {
      return paragraphs;
    }

    const pattern = /(?:\r?\n)+/g;
    let paragraphStart = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      pushTrimmedOffset(paragraphs, text, paragraphStart, match.index);
      paragraphStart = match.index + match[0].length;
    }

    if (paragraphs.length === 0 || paragraphStart < text.length) {
      pushTrimmedOffset(paragraphs, text, paragraphStart, text.length);
    }

    return paragraphs;
  }

  function splitIntoSentenceOffsets(text) {
    const sentences = [];

    if (!text.trim()) {
      return sentences;
    }

    if ("Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      for (const sentence of segmenter.segment(text)) {
        pushTrimmedOffset(sentences, text, sentence.index, sentence.index + sentence.segment.length);
      }
    } else {
      const pattern = /[^.!?]+(?:[.!?]+["')\]]*)?/g;
      let match;

      while ((match = pattern.exec(text)) !== null) {
        pushTrimmedOffset(sentences, text, match.index, match.index + match[0].length);
      }
    }

    if (sentences.length === 0) {
      pushTrimmedOffset(sentences, text, 0, text.length);
    }

    return sentences;
  }

  function pushTrimmedOffset(collection, source, start, end) {
    while (start < end && /\s/.test(source[start])) {
      start += 1;
    }

    while (end > start && /\s/.test(source[end - 1])) {
      end -= 1;
    }

    if (start < end) {
      collection.push({
        start,
        end,
        text: source.slice(start, end)
      });
    }
  }

  function highlightSentence(sentence) {
    clearHighlight();

    if (!sentence?.range) {
      return;
    }

    if ("CSS" in window && "highlights" in CSS && "Highlight" in window) {
      CSS.highlights.set("study-reader-current", new Highlight(sentence.range));
      return;
    }

    try {
      const wrapper = document.createElement("span");
      wrapper.className = "study-reader-fallback-highlight";
      sentence.range.surroundContents(wrapper);
      state.fallbackHighlight = wrapper;
    } catch (_error) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(sentence.range);
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

  function scrollCurrentSentenceIntoView() {
    const sentence = getCurrentSentence();
    const anchor = sentence?.range?.startContainer?.parentElement;
    anchor?.scrollIntoView({ block: "center", behavior: "smooth" });
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

    const text = normalizeWhitespace(readable.textContent || "");
    if (text.length >= 20) {
      state.lastReadableElement = readable;
      if (state.status === "idle" && !hasPlan()) {
        updateMiniStatus("Paragraph ready");
        updateMiniPreview("Play will read from the clicked passage.");
      }
    }
  }

  function ensureMiniPlayer() {
    if (state.miniPlayer && document.contains(state.miniPlayer)) {
      return;
    }

    const player = document.createElement("div");
    player.className = "study-reader-toolbar study-reader-mini-player";
    player.setAttribute("role", "region");
    player.setAttribute("aria-label", "Study Reader mini-player");

    const header = document.createElement("div");
    header.className = "study-reader-mini-header";

    const status = document.createElement("div");
    status.className = "study-reader-mini-status";
    status.textContent = state.miniStatusText;

    const headerActions = document.createElement("div");
    headerActions.className = "study-reader-mini-header-actions";

    const menuButton = makeMiniButton("Menu", "study-reader-mini-menu", () => openMainMenu());
    const collapseButton = makeMiniButton("-", "study-reader-mini-collapse", () => {
      const collapsed = player.dataset.collapsed === "true";
      player.dataset.collapsed = String(!collapsed);
      collapseButton.textContent = collapsed ? "-" : "+";
    });
    const closeButton = makeMiniButton("Close", "study-reader-mini-close", () => closeMiniPlayer());

    headerActions.append(menuButton, collapseButton, closeButton);
    header.append(status, headerActions);

    const preview = document.createElement("div");
    preview.className = "study-reader-mini-preview";
    preview.textContent = state.miniPreviewText;

    const groups = document.createElement("div");
    groups.className = "study-reader-mini-groups";

    const playbackGroup = makeMiniGroup("Playback");
    const playButton = makeMiniButton("Play", "study-reader-mini-primary", () => playCurrentSentence());
    const pauseButton = makeMiniButton("Pause", "", () => pauseReading());
    const resumeButton = makeMiniButton("Resume", "", () => resumeReading());
    const stopButton = makeMiniButton("Stop", "study-reader-mini-stop", () => stopReading());
    playbackGroup.body.append(playButton, pauseButton, resumeButton, stopButton);

    const sentenceGroup = makeMiniGroup("Sentence");
    const previousSentenceButton = makeMiniButton("Prev Sentence", "", () => moveSentence(-1, true));
    const nextSentenceButton = makeMiniButton("Next Sentence", "", () => moveSentence(1, true));
    sentenceGroup.body.append(previousSentenceButton, nextSentenceButton);

    const paragraphGroup = makeMiniGroup("Paragraph");
    const previousParagraphButton = makeMiniButton("Prev Paragraph", "", () => moveParagraph(-1, true));
    const nextParagraphButton = makeMiniButton("Next Paragraph", "", () => moveParagraph(1, true));
    paragraphGroup.body.append(previousParagraphButton, nextParagraphButton);

    const settingsGroup = makeMiniGroup("Voice / Speed");
    settingsGroup.body.classList.add("study-reader-mini-settings");

    const rateWrap = document.createElement("label");
    rateWrap.className = "study-reader-mini-field";
    rateWrap.setAttribute("for", "studyReaderMiniRate");
    rateWrap.innerHTML = `Speed <span class="study-reader-mini-field-value" id="studyReaderMiniRateValue">${formatRate(state.prefs.rate)}</span>`;

    const rateInput = document.createElement("input");
    rateInput.id = "studyReaderMiniRate";
    rateInput.type = "range";
    rateInput.min = "0.5";
    rateInput.max = "2";
    rateInput.step = "0.1";
    rateInput.value = String(state.prefs.rate);
    rateInput.addEventListener("input", async () => {
      state.prefs = await savePrefs({
        ...state.prefs,
        rate: Number(rateInput.value)
      });
      syncMiniControlsFromPrefs();
    });

    const voiceWrap = document.createElement("label");
    voiceWrap.className = "study-reader-mini-field";
    voiceWrap.setAttribute("for", "studyReaderMiniVoice");
    voiceWrap.textContent = "Voice";

    const voiceSelect = document.createElement("select");
    voiceSelect.id = "studyReaderMiniVoice";
    voiceSelect.addEventListener("change", async () => {
      state.prefs = await savePrefs({
        ...state.prefs,
        voiceName: voiceSelect.value
      });
      populateVoices();
    });

    settingsGroup.body.append(rateWrap, rateInput, voiceWrap, voiceSelect);

    groups.append(
      playbackGroup.element,
      sentenceGroup.element,
      paragraphGroup.element,
      settingsGroup.element
    );
    player.append(header, preview, groups);
    document.documentElement.appendChild(player);

    state.miniPlayer = player;
    state.miniStatus = status;
    state.miniPreview = preview;
    state.miniRate = rateInput;
    state.miniRateValue = rateWrap.querySelector("#studyReaderMiniRateValue");
    state.miniVoice = voiceSelect;
    state.miniButtons = {
      play: playButton,
      pause: pauseButton,
      resume: resumeButton,
      stop: stopButton,
      previousSentence: previousSentenceButton,
      nextSentence: nextSentenceButton,
      previousParagraph: previousParagraphButton,
      nextParagraph: nextParagraphButton,
      menu: menuButton,
      close: closeButton,
      collapse: collapseButton
    };

    applyMiniPlayerTheme();
    syncMiniControlsFromPrefs();
    populateVoices();
    updateMiniControls();
  }

  function applyMiniPlayerTheme() {
    if (!state.miniPlayer) {
      return;
    }

    state.miniPlayer.dataset.themeMode = normalizeSavedTheme(state.themeMode);
    state.miniPlayer.dataset.theme = resolveStudyReaderTheme(state.themeMode);
    logThemeDebug("toolbar", state.miniPlayer);
  }

  function applyMiniToastTheme() {
    if (!state.miniToast) {
      return;
    }

    state.miniToast.dataset.themeMode = normalizeSavedTheme(state.themeMode);
    state.miniToast.dataset.theme = resolveStudyReaderTheme(state.themeMode);
    logThemeDebug("toast", state.miniToast);
  }

  function makeMiniGroup(title) {
    const element = document.createElement("section");
    element.className = "study-reader-mini-group";

    const heading = document.createElement("p");
    heading.className = "study-reader-mini-group-title";
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "study-reader-mini-group-body";

    element.append(heading, body);
    return { element, body };
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
      Promise.resolve(onClick()).catch((error) => {
        updateMiniStatus(error.message || "Unable to update Study Reader.");
        updateMiniPreview(currentSentencePreview());
        updateMiniControls();
      });
    });

    return button;
  }

  function updateMiniStatus(text) {
    clearTimeout(state.statusRestoreTimer);
    state.miniStatusText = text;
    if (state.miniStatus) {
      state.miniStatus.textContent = text;
    }
  }

  function updateMiniPreview(text) {
    state.miniPreviewText = text;
    if (state.miniPreview) {
      state.miniPreview.textContent = text;
    }
  }

  function updateMiniControls() {
    if (!state.miniPlayer) {
      return;
    }

    const hasLoadedPlan = hasPlan();
    const atStart = isAtPlanStart();
    const atEnd = isAtPlanEnd();

    state.miniButtons.pause.disabled = state.status !== "speaking";
    state.miniButtons.resume.disabled = state.status !== "paused";
    state.miniButtons.stop.disabled = !hasLoadedPlan && state.status === "idle";
    state.miniButtons.previousSentence.disabled = !hasLoadedPlan || atStart;
    state.miniButtons.nextSentence.disabled = !hasLoadedPlan || atEnd;
    state.miniButtons.previousParagraph.disabled = !hasLoadedPlan || state.currentParagraphIndex <= 0;
    state.miniButtons.nextParagraph.disabled = !hasLoadedPlan || state.currentParagraphIndex >= state.plan.paragraphs.length - 1;
  }

  async function openMainMenu() {
    closeMiniPlayer();

    try {
      const response = await chrome.runtime.sendMessage({ type: "STUDY_READER_OPEN_POPUP" });
      if (response?.ok && response?.opened) {
        return;
      }
    } catch (_error) {
      // Fall through to user guidance toast.
    }

    showMiniToast("Toolbar closed. Click the Study Reader extension icon to reopen the menu.");
  }

  function closeMiniPlayer() {
    stopReading();
    clearTimeout(state.statusRestoreTimer);
    state.plan = null;
    state.currentParagraphIndex = 0;
    state.currentSentenceIndex = 0;
    state.lastReadableElement = null;
    state.miniStatusText = "Ready";
    state.miniPreviewText = "Select text or click a paragraph first.";

    if (state.miniPlayer?.isConnected) {
      state.miniPlayer.remove();
    }

    state.miniPlayer = null;
    state.miniStatus = null;
    state.miniPreview = null;
    state.miniRate = null;
    state.miniRateValue = null;
    state.miniVoice = null;
    state.miniButtons = {};
  }

  function showMiniToast(message) {
    clearTimeout(state.toastTimer);

    if (!state.miniToast || !document.contains(state.miniToast)) {
      const toast = document.createElement("div");
      toast.className = "study-reader-mini-toast";
      state.miniToast = toast;
      applyMiniToastTheme();
      document.documentElement.appendChild(toast);
    }

    state.miniToast.textContent = message;
    state.miniToast.hidden = false;

    state.toastTimer = setTimeout(() => {
      if (state.miniToast) {
        state.miniToast.hidden = true;
      }
    }, 2600);
  }

  function syncMiniControlsFromPrefs() {
    if (!state.miniRate || !state.miniRateValue || !state.miniVoice) {
      return;
    }

    state.miniRate.value = String(state.prefs.rate);
    state.miniRateValue.textContent = formatRate(state.prefs.rate);
    state.miniVoice.value = state.prefs.voiceName;
  }

  function populateVoices() {
    if (!state.miniVoice || !("speechSynthesis" in window)) {
      return;
    }

    const voices = window.speechSynthesis.getVoices();
    const currentValue = state.prefs.voiceName || state.miniVoice.value;

    state.miniVoice.replaceChildren(new Option("Default voice", ""));

    voices
      .slice()
      .sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`))
      .forEach((voice) => {
        state.miniVoice.appendChild(new Option(`${voice.name} (${voice.lang})`, voice.name));
      });

    state.miniVoice.value = currentValue;
  }

  function hasPlan() {
    return Boolean(state.plan?.paragraphs.length);
  }

  function getCurrentParagraph() {
    return state.plan?.paragraphs[state.currentParagraphIndex] || null;
  }

  function getCurrentSentence() {
    const paragraph = getCurrentParagraph();
    return paragraph?.sentences[state.currentSentenceIndex] || null;
  }

  function getNextSentencePosition(direction) {
    const paragraph = getCurrentParagraph();
    if (!paragraph) {
      return null;
    }

    let paragraphIndex = state.currentParagraphIndex;
    let sentenceIndex = state.currentSentenceIndex + direction;

    if (sentenceIndex >= paragraph.sentences.length) {
      paragraphIndex += 1;
      sentenceIndex = 0;
    } else if (sentenceIndex < 0) {
      paragraphIndex -= 1;
      if (paragraphIndex >= 0) {
        sentenceIndex = state.plan.paragraphs[paragraphIndex].sentences.length - 1;
      }
    }

    if (paragraphIndex < 0 || paragraphIndex >= state.plan.paragraphs.length) {
      return null;
    }

    return { paragraphIndex, sentenceIndex };
  }

  function isAtPlanStart() {
    return !hasPlan() || (state.currentParagraphIndex === 0 && state.currentSentenceIndex === 0);
  }

  function isAtPlanEnd() {
    if (!hasPlan()) {
      return true;
    }

    const paragraph = getCurrentParagraph();
    return state.currentParagraphIndex === state.plan.paragraphs.length - 1
      && state.currentSentenceIndex === paragraph.sentences.length - 1;
  }

  function currentSentenceLabel() {
    if (!hasPlan()) {
      return "Ready";
    }

    const paragraph = getCurrentParagraph();
    return `Paragraph ${state.currentParagraphIndex + 1}/${state.plan.paragraphs.length} / Sentence ${state.currentSentenceIndex + 1}/${paragraph.sentences.length}`;
  }

  function currentSentencePreview() {
    return getCurrentSentence()?.text || "Select text or click a paragraph first.";
  }

  function findPreferredVoice(voiceName) {
    if (!voiceName || !("speechSynthesis" in window)) {
      return null;
    }

    return window.speechSynthesis.getVoices().find((voice) => voice.name === voiceName) || null;
  }

  function getParagraphAnchor(element) {
    let current = element;

    while (current && current !== document.body) {
      if (current.matches?.(READABLE_SELECTOR)) {
        return current;
      }

      const display = window.getComputedStyle(current).display;
      if (display === "block" || display === "list-item" || display === "table-cell") {
        return current;
      }

      current = current.parentElement;
    }

    return element?.parentElement || document.body;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizePrefs(input) {
    if (prefsApi?.normalizePrefs) {
      return prefsApi.normalizePrefs(input);
    }

    return {
      rate: clamp(Number(input.rate) || DEFAULT_PREFS.rate, 0.5, 2),
      voiceName: typeof input.voiceName === "string" ? input.voiceName : ""
    };
  }

  async function savePrefs(nextPrefs) {
    if (prefsApi?.savePrefs) {
      return prefsApi.savePrefs(nextPrefs);
    }

    return normalizePrefs(nextPrefs);
  }

  function formatRate(rate) {
    return `${Number(rate).toFixed(1)}x`;
  }

  function flashMiniStatus(message) {
    const restoreMessage = currentMiniStatus();
    updateMiniStatus(message);
    state.statusRestoreTimer = setTimeout(() => {
      state.miniStatusText = restoreMessage;
      if (state.miniStatus) {
        state.miniStatus.textContent = restoreMessage;
      }
    }, 1800);
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

  function currentMiniStatus() {
    if (state.status === "paused") {
      return "Paused";
    }

    if (state.status === "speaking") {
      return currentSentenceLabel();
    }

    if (hasPlan()) {
      return currentSentenceLabel();
    }

    return state.miniStatusText || "Ready";
  }

  async function ensureThemeState() {
    if (!state.themeReadyPromise) {
      state.themeReadyPromise = refreshThemeState();
    }

    await state.themeReadyPromise;
  }

  async function loadSavedTheme() {
    if (chrome?.storage?.local) {
      try {
        const stored = await chrome.storage.local.get({ [THEME_STORAGE_KEY]: "system" });
        return normalizeSavedTheme(stored[THEME_STORAGE_KEY]);
      } catch (_error) {
        // Fall through to theme helper and finally default.
      }
    }

    if (themeApi?.getThemeMode) {
      try {
        return normalizeSavedTheme(await themeApi.getThemeMode());
      } catch (_error) {
        // Fall through to default.
      }
    }

    return "system";
  }

  async function refreshThemeState(nextTheme) {
    const savedTheme = normalizeSavedTheme(
      nextTheme === undefined ? await loadSavedTheme() : nextTheme
    );
    const resolvedTheme = resolveStudyReaderTheme(savedTheme);

    state.themeMode = savedTheme;
    state.resolvedTheme = resolvedTheme;

    applyMiniPlayerTheme();
    applyMiniToastTheme();
    logThemeDebug("refresh");

    return {
      savedTheme,
      resolvedTheme
    };
  }

  function normalizeSavedTheme(theme) {
    return theme === "light" || theme === "dark" ? theme : "system";
  }

  function resolveStudyReaderTheme(savedTheme) {
    const normalized = normalizeSavedTheme(savedTheme);
    if (normalized === "dark") {
      return "dark";
    }

    if (normalized === "light") {
      return "light";
    }

    return systemThemeMediaQuery?.matches ? "dark" : "light";
  }

  function logThemeDebug(target, root) {
    if (!THEME_DEBUG) {
      return;
    }

    console.info("Study Reader web theme", {
      target,
      savedTheme: state.themeMode,
      resolvedTheme: state.resolvedTheme,
      appliedTheme: root?.dataset?.theme || null
    });
  }
})();
