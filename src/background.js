const CONTENT_SCRIPT_FILE = "src/content.js";
const CONTENT_PREFS_FILE = "src/shared-prefs.js";
const CONTENT_SNIPPETS_FILE = "src/shared-snippets.js";
const CONTENT_THEME_FILE = "src/shared-theme.js";
const CONTENT_STYLE_FILE = "src/content.css";
const SNIPPETS_STORAGE_KEY = "studyReaderSnippets";
const SNIPPETS_MESSAGE_TYPES = new Set([
  "SNIPPETS_GET",
  "SNIPPETS_SAVE",
  "SNIPPETS_UPDATE",
  "SNIPPETS_DELETE",
  "SNIPPETS_CLEAR",
  "STUDY_READER_SNIPPETS_STORAGE"
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "STUDY_READER_OPEN_POPUP") {
    openStudyReaderPopup()
      .then((opened) => sendResponse({ ok: true, opened }))
      .catch((error) => sendResponse({ ok: false, opened: false, error: error.message }));

    return true;
  }

  if (SNIPPETS_MESSAGE_TYPES.has(message?.type)) {
    handleSnippetStorageMessage(message)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (!message || message.type !== "STUDY_READER_POPUP_COMMAND") {
    return false;
  }

  forwardToActiveTab(message.payload)
    .then((response) => sendResponse({ ok: true, response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function handleSnippetStorageMessage(message) {
  if (!chrome?.storage?.local) {
    throw new Error("Storage permission is missing. Check manifest.json for the storage permission.");
  }

  const stored = await chrome.storage.local.get({ [SNIPPETS_STORAGE_KEY]: [] });
  const snippets = Array.isArray(stored[SNIPPETS_STORAGE_KEY]) ? stored[SNIPPETS_STORAGE_KEY] : [];

  if (message.type === "SNIPPETS_GET" || message.action === "getSnippets") {
    return { snippets };
  }

  if (message.type === "SNIPPETS_CLEAR" || message.action === "setSnippets") {
    const nextSnippets = Array.isArray(message.snippets) ? message.snippets : [];
    await chrome.storage.local.set({
      [SNIPPETS_STORAGE_KEY]: nextSnippets
    });
    return { snippets: nextSnippets, updated: true };
  }

  if (message.type === "SNIPPETS_SAVE") {
    const snippet = message.snippet || message.payload;
    if (!snippet || typeof snippet !== "object") {
      throw new Error("Snippet payload is missing.");
    }

    const duplicate = snippets.find((entry) => (
      entry?.text === snippet.text
      && entry?.sourceId === snippet.sourceId
      && entry?.snippetType === snippet.snippetType
    ));

    if (duplicate) {
      return {
        saved: false,
        duplicate: true,
        snippet: duplicate,
        snippets
      };
    }

    const nextSnippets = [snippet, ...snippets];
    await chrome.storage.local.set({ [SNIPPETS_STORAGE_KEY]: nextSnippets });
    return {
      saved: true,
      duplicate: false,
      snippet,
      snippets: nextSnippets
    };
  }

  if (message.type === "SNIPPETS_UPDATE") {
    if (typeof message.id !== "string" || !message.id) {
      throw new Error("Snippet id is required.");
    }

    const nextSnippets = snippets.map((snippet) => (
      snippet?.id === message.id ? message.updates : snippet
    ));
    await chrome.storage.local.set({ [SNIPPETS_STORAGE_KEY]: nextSnippets });
    return { snippets: nextSnippets, updated: true };
  }

  if (message.type === "SNIPPETS_DELETE") {
    if (typeof message.id !== "string" || !message.id) {
      throw new Error("Snippet id is required.");
    }

    const nextSnippets = snippets.filter((snippet) => snippet?.id !== message.id);
    await chrome.storage.local.set({ [SNIPPETS_STORAGE_KEY]: nextSnippets });
    return { snippets: nextSnippets, deleted: true };
  }

  throw new Error("Unknown snippets storage action.");
}

async function forwardToActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    throw new Error("No active tab found.");
  }

  if (!tab.url || !/^https?:|^file:/.test(tab.url)) {
    throw new Error("Study Reader can only run on regular web pages.");
  }

  await ensureContentScript(tab.id);

  return chrome.tabs.sendMessage(tab.id, {
    type: "STUDY_READER_CONTENT_COMMAND",
    payload
  });
}

async function openStudyReaderPopup() {
  if (!chrome?.action?.openPopup) {
    return false;
  }

  try {
    await chrome.action.openPopup();
    return true;
  } catch (_error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "STUDY_READER_PING" });
    return;
  } catch (_error) {
    // The content script is not loaded in this tab yet.
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: [CONTENT_STYLE_FILE]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_PREFS_FILE, CONTENT_SNIPPETS_FILE, CONTENT_THEME_FILE, CONTENT_SCRIPT_FILE]
  });
}
