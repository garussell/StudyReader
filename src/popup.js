const prefsApi = globalThis.StudyReaderPrefs;
const snippetsApi = globalThis.StudyReaderSnippetStorage || globalThis.StudyReaderSnippets;
const themeApi = globalThis.StudyReaderTheme;
const DEFAULT_PREFS = prefsApi?.DEFAULT_PREFS || {
  rate: 1,
  voiceName: ""
};

const statusEl = document.getElementById("status");
const rateEl = document.getElementById("rate");
const rateValueEl = document.getElementById("rateValue");
const voiceEl = document.getElementById("voice");
const themeEl = document.getElementById("theme");
const snippetCountEl = document.getElementById("snippetCount");

const buttons = {
  readSelection: document.getElementById("readSelection"),
  openPdfReader: document.getElementById("openPdfReader"),
  openSnippets: document.getElementById("openSnippets"),
  pause: document.getElementById("pause"),
  resume: document.getElementById("resume"),
  stop: document.getElementById("stop"),
  next: document.getElementById("next"),
  previous: document.getElementById("previous")
};
const pdfFileEl = document.getElementById("openPdfFile");

let prefs = { ...DEFAULT_PREFS };

document.addEventListener("DOMContentLoaded", init);

async function init() {
  prefs = prefsApi ? await prefsApi.getPrefs() : { ...DEFAULT_PREFS };
  if (themeApi?.getThemeMode) {
    themeEl.value = await themeApi.getThemeMode();
  }
  rateEl.value = String(prefs.rate);
  updateRateLabel();
  await updateSnippetCount();

  wireControls();
  populateVoices();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

  if (chrome?.storage?.onChanged && snippetsApi?.STORAGE_KEY) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, snippetsApi.STORAGE_KEY)) {
        updateSnippetCount();
      }
    });
  }

  if (themeApi?.watchTheme) {
    themeApi.watchTheme(({ mode }) => {
      themeEl.value = mode;
    });
  }
}

function wireControls() {
  buttons.readSelection.addEventListener("click", async () => {
    const ok = await sendCommand("READ_SELECTION");
    if (ok) {
      window.close();
    }
  });
  buttons.openPdfReader.addEventListener("click", openPdfReader);
  buttons.openSnippets.addEventListener("click", openSnippetsManager);
  buttons.pause.addEventListener("click", () => sendCommand("PAUSE"));
  buttons.resume.addEventListener("click", () => sendCommand("RESUME"));
  buttons.stop.addEventListener("click", () => sendCommand("STOP"));
  buttons.next.addEventListener("click", () => sendCommand("NEXT_SENTENCE"));
  buttons.previous.addEventListener("click", () => sendCommand("PREVIOUS_SENTENCE"));
  pdfFileEl.addEventListener("change", openSelectedPdf);

  rateEl.addEventListener("input", async () => {
    prefs = await savePrefs({
      ...prefs,
      rate: Number(rateEl.value)
    });
    rateEl.value = String(prefs.rate);
    updateRateLabel();
    sendCommand("UPDATE_PREFS", prefs, false);
  });

  voiceEl.addEventListener("change", async () => {
    prefs = await savePrefs({
      ...prefs,
      voiceName: voiceEl.value
    });
    sendCommand("UPDATE_PREFS", prefs, false);
  });

  themeEl.addEventListener("change", async () => {
    if (!themeApi?.saveThemeMode) {
      return;
    }

    themeEl.value = await themeApi.saveThemeMode(themeEl.value);
  });
}

async function openPdfReader() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/pdf-reader.html")
  });
}

async function openSnippetsManager() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/snippets.html")
  });
}

async function openSelectedPdf() {
  const [file] = pdfFileEl.files || [];
  pdfFileEl.value = "";

  if (!file) {
    return;
  }

  if (file.type && file.type !== "application/pdf") {
    setStatus("Choose a PDF file.");
    return;
  }

  try {
    setStatus("Opening PDF...");
    const bytes = await file.arrayBuffer();
    await savePdfForReader(file.name, bytes);
    await chrome.tabs.create({
      url: chrome.runtime.getURL("src/pdf-reader.html?load=last")
    });
    setStatus("PDF reader opened.");
  } catch (error) {
    setStatus(error.message);
  }
}

function updateRateLabel() {
  rateValueEl.textContent = `${Number(rateEl.value).toFixed(1)}x`;
}

function populateVoices() {
  if (!("speechSynthesis" in window)) {
    return;
  }

  const voices = window.speechSynthesis.getVoices();
  const currentValue = prefs.voiceName || voiceEl.value;

  voiceEl.replaceChildren(new Option("Default voice", ""));

  voices
    .slice()
    .sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`))
    .forEach((voice) => {
      const label = `${voice.name} (${voice.lang})`;
      voiceEl.appendChild(new Option(label, voice.name));
    });

  voiceEl.value = currentValue;
}

async function sendCommand(command, extra = {}, showStatus = true) {
  if (showStatus) {
    setStatus("Working...");
  }

  try {
    const result = await chrome.runtime.sendMessage({
      type: "STUDY_READER_POPUP_COMMAND",
      payload: { command, ...extra }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Unable to reach the page.");
    }

    const response = result.response || {};
    if (showStatus) {
      setStatus(response.message || "Ready");
    }
    return true;
  } catch (error) {
    if (showStatus) {
      setStatus(error.message);
    }
    return false;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function updateSnippetCount() {
  if (!snippetCountEl) {
    return;
  }

  if (!snippetsApi?.getSnippets) {
    const diagnostics = getSnippetDiagnostics("popup");
    console.error("Study Reader: popup snippet helper missing", diagnostics);
    snippetCountEl.textContent = "Snippet storage helper is unavailable in the popup.";
    return;
  }

  try {
    const snippets = await snippetsApi.getSnippets();
    const pdfSnippets = snippets.filter((snippet) => snippet.sourceType === "pdf");
    snippetCountEl.textContent = pdfSnippets.length === 0
      ? "No PDF snippets saved yet."
      : `${pdfSnippets.length} saved PDF snippet${pdfSnippets.length === 1 ? "" : "s"}.`;
  } catch (error) {
    console.error("Study Reader: failed to load snippet count", error);
    snippetCountEl.textContent = error.message || "Could not load saved PDF snippets.";
  }
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

async function savePrefs(nextPrefs) {
  if (prefsApi) {
    return prefsApi.savePrefs(nextPrefs);
  }

  return {
    rate: Number(nextPrefs.rate) || DEFAULT_PREFS.rate,
    voiceName: typeof nextPrefs.voiceName === "string" ? nextPrefs.voiceName : ""
  };
}

function savePdfForReader(name, bytes) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("study-reader-pdfs", 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
    };

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("files", "readwrite");
      transaction.objectStore("files").put(
        {
          name,
          bytes,
          savedAt: Date.now()
        },
        "last"
      );
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
