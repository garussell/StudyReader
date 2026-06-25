# Study Reader

Study Reader is a Manifest V3 Chrome extension MVP for text-to-speech study reading. It reads selected webpage text, can fall back to the last clicked readable paragraph, highlights the current sentence, and provides controls in both the popup and a floating in-page mini-player.

## Features

- Read selected webpage text with the browser Web Speech API.
- Fall back to the last clicked paragraph or list item when no text is selected.
- Pause, resume, stop, next sentence, and previous sentence controls.
- Sentence-sized chunking for smoother study pacing.
- Current sentence highlighting using the CSS Custom Highlight API when available.
- Floating mini-player injected into the active page.
- Preferred speech rate and voice saved with `chrome.storage.sync`.
- Minimal MV3 permissions: `activeTab`, `scripting`, and `storage`.
- Local PDF reader view powered by bundled PDF.js files in `vendor/pdfjs`.
- Local PDF file loading from the popup or inside the PDF reader page.
- PDF page rendering, page-by-page text extraction, clickable text chunks, sentence navigation, and current sentence highlighting.
- Graceful image-only PDF handling: scanned PDFs show that OCR can be added later.

## PDF.js Bundle

PDF.js is bundled locally with the extension. The runtime files loaded by Chrome are:

- `vendor/pdfjs/pdf.mjs`
- `vendor/pdfjs/pdf.worker.mjs`

If these files ever need to be regenerated from dependencies, run:

```sh
npm install
npm run vendor:pdfjs
```

## Load In Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Choose this folder: `/Users/allenrussell/Code/Projects/StudyReader`.
5. Pin **Study Reader** from the Extensions menu if you want quick access.

## Use

1. Open any normal webpage.
2. Select text, then click the Study Reader extension icon and choose **Read Selection**.
3. To read from a paragraph instead, activate Study Reader once, click a paragraph on the page, then use **Read Selection** again. When no selection exists, Study Reader reads the last clicked readable paragraph.
4. Use **Previous**, **Pause**, **Resume**, **Next**, and **Stop** from the popup or the in-page mini-player.
5. Choose a voice and rate in the popup. Preferences are saved automatically.

## Test Local PDFs

1. Click the Study Reader extension icon.
2. Click **Open Local PDF** and choose a `.pdf` file.
3. A Study Reader PDF tab opens with the selected file.
4. Use **Previous Page** and **Next Page** to navigate rendered pages.
5. Click a text chunk in the right panel to start reading from that point.
6. Use **Play from Current Chunk**, **Pause**, **Resume**, **Stop**, **Next Sentence**, and **Previous Sentence** to control playback.
7. Adjust **Speed** and **Voice** in the PDF reader. These use the same saved preferences as the webpage reader.

You can also click **Open PDF Reader** from the popup and choose a PDF directly from the reader page.

If a PDF is scanned or image-only, Study Reader displays: "This PDF does not appear to contain selectable text. OCR support can be added later."

Chrome does not allow extensions to run on internal pages such as `chrome://extensions`, the Chrome Web Store, or some protected browser pages.
# StudyReader
