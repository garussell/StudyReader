const CONTENT_SCRIPT_FILE = "src/content.js";
const CONTENT_STYLE_FILE = "src/content.css";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "STUDY_READER_POPUP_COMMAND") {
    return false;
  }

  forwardToActiveTab(message.payload)
    .then((response) => sendResponse({ ok: true, response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

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
    files: [CONTENT_SCRIPT_FILE]
  });
}
