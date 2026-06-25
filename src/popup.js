const DEFAULT_PREFS = {
  rate: 1,
  voiceName: ""
};

const statusEl = document.getElementById("status");
const rateEl = document.getElementById("rate");
const rateValueEl = document.getElementById("rateValue");
const voiceEl = document.getElementById("voice");

const buttons = {
  readSelection: document.getElementById("readSelection"),
  openPdfReader: document.getElementById("openPdfReader"),
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
  prefs = await getPrefs();
  rateEl.value = String(prefs.rate);
  updateRateLabel();

  wireControls();
  populateVoices();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }
}

function wireControls() {
  buttons.readSelection.addEventListener("click", () => sendCommand("READ_SELECTION"));
  buttons.openPdfReader.addEventListener("click", openPdfReader);
  buttons.pause.addEventListener("click", () => sendCommand("PAUSE"));
  buttons.resume.addEventListener("click", () => sendCommand("RESUME"));
  buttons.stop.addEventListener("click", () => sendCommand("STOP"));
  buttons.next.addEventListener("click", () => sendCommand("NEXT_SENTENCE"));
  buttons.previous.addEventListener("click", () => sendCommand("PREVIOUS_SENTENCE"));
  pdfFileEl.addEventListener("change", openSelectedPdf);

  rateEl.addEventListener("input", async () => {
    prefs.rate = Number(rateEl.value);
    updateRateLabel();
    await savePrefs();
    sendCommand("UPDATE_PREFS", prefs, false);
  });

  voiceEl.addEventListener("change", async () => {
    prefs.voiceName = voiceEl.value;
    await savePrefs();
    sendCommand("UPDATE_PREFS", prefs, false);
  });
}

async function openPdfReader() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/pdf-reader.html")
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
  } catch (error) {
    if (showStatus) {
      setStatus(error.message);
    }
  }
}

function getPrefs() {
  return chrome.storage.sync.get(DEFAULT_PREFS);
}

function savePrefs() {
  return chrome.storage.sync.set({
    rate: prefs.rate,
    voiceName: prefs.voiceName
  });
}

function setStatus(text) {
  statusEl.textContent = text;
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
