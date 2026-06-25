(function initStudyReaderSnippets(global) {
  const STORAGE_KEY = "studyReaderSnippets";
  const HELPER_NAME = "StudyReaderSnippetStorage";
  const LEGACY_HELPER_NAME = "StudyReaderSnippets";
  const MESSAGE_TYPES = {
    GET: "SNIPPETS_GET",
    SAVE: "SNIPPETS_SAVE",
    UPDATE: "SNIPPETS_UPDATE",
    DELETE: "SNIPPETS_DELETE",
    CLEAR: "SNIPPETS_CLEAR"
  };

  async function getSnippets() {
    const snippets = await readSnippets();
    return normalizeSnippets(snippets);
  }

  async function saveSnippet(snippet) {
    const normalizedSnippet = normalizeSnippet(snippet);
    const snippets = await getSnippets();
    const duplicate = snippets.find((existing) => isDuplicateSnippet(existing, normalizedSnippet));

    if (duplicate) {
      return {
        saved: false,
        duplicate: true,
        snippet: duplicate,
        snippets
      };
    }

    return insertSnippet(normalizedSnippet, snippets);
  }

  async function updateSnippet(id, updates) {
    const snippets = await getSnippets();
    const currentSnippet = snippets.find((snippet) => snippet.id === id);
    if (!currentSnippet) {
      return snippets;
    }

    const updatedSnippet = normalizeSnippet({ ...currentSnippet, ...updates, id: currentSnippet.id });
    const duplicate = snippets.find((snippet) => (
      snippet.id !== id && isDuplicateSnippet(snippet, updatedSnippet)
    ));

    if (duplicate) {
      return snippets;
    }

    if (global.chrome?.storage?.local) {
      const nextSnippets = snippets.map((snippet) => (snippet.id === id ? updatedSnippet : snippet));
      await writeSnippets(nextSnippets);
      return nextSnippets;
    }

    const response = await sendStorageMessage(MESSAGE_TYPES.UPDATE, {
      id,
      updates: updatedSnippet
    });
    return normalizeSnippets(response.snippets || snippets);
  }

  async function deleteSnippet(id) {
    if (global.chrome?.storage?.local) {
      const snippets = await getSnippets();
      const nextSnippets = snippets.filter((snippet) => snippet.id !== id);
      await writeSnippets(nextSnippets);
      return nextSnippets;
    }

    const response = await sendStorageMessage(MESSAGE_TYPES.DELETE, { id });
    return normalizeSnippets(response.snippets || []);
  }

  async function clearSnippets() {
    if (global.chrome?.storage?.local) {
      await writeSnippets([]);
      return [];
    }

    const response = await sendStorageMessage(MESSAGE_TYPES.CLEAR);
    return normalizeSnippets(response.snippets || []);
  }

  function normalizeSnippets(snippets) {
    if (!Array.isArray(snippets)) {
      return [];
    }

    return snippets
      .map((snippet) => {
        try {
          return normalizeSnippet(snippet);
        } catch (error) {
          console.error("Study Reader: discarded invalid snippet record", error, snippet);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  function normalizeSnippet(input = {}) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) {
      throw new Error("Snippet text is required.");
    }

    const sourceType = input.sourceType === "pdf" ? "pdf" : "web";
    const sourceUrl = sourceType === "web" && typeof input.sourceUrl === "string"
      ? normalizeSourceUrl(input.sourceUrl)
      : null;
    const pdfFileName = sourceType === "pdf" && typeof input.pdfFileName === "string" && input.pdfFileName.trim()
      ? input.pdfFileName.trim()
      : null;
    const sourceTitle = typeof input.sourceTitle === "string" && input.sourceTitle.trim()
      ? input.sourceTitle.trim()
      : (pdfFileName || sourceUrl || "Untitled source");
    const sourceId = typeof input.sourceId === "string" && input.sourceId.trim()
      ? input.sourceId.trim()
      : buildSourceId({
        sourceType,
        sourceUrl,
        pdfFileName,
        sourceTitle
      });

    return {
      id: typeof input.id === "string" && input.id ? input.id : createSnippetId(),
      text,
      snippetType: input.snippetType === "paragraph" || input.type === "paragraph" ? "paragraph" : "sentence",
      sourceType,
      sourceId,
      sourceTitle,
      sourceUrl,
      pdfFileName,
      pageNumber: Number.isFinite(Number(input.pageNumber)) ? Number(input.pageNumber) : null,
      paragraphIndex: Number.isFinite(Number(input.paragraphIndex)) ? Number(input.paragraphIndex) : null,
      sentenceIndex: Number.isFinite(Number(input.sentenceIndex)) ? Number(input.sentenceIndex) : null,
      createdAt: normalizeCreatedAt(input.createdAt),
      note: typeof input.note === "string"
        ? input.note
        : (typeof input.userNote === "string" ? input.userNote : "")
    };
  }

  function isDuplicateSnippet(a, b) {
    return a.text === b.text
      && a.sourceId === b.sourceId
      && a.snippetType === b.snippetType;
  }

  function groupSnippetsBySource(snippets) {
    const groups = new Map();

    normalizeSnippets(snippets).forEach((snippet) => {
      if (!groups.has(snippet.sourceId)) {
        groups.set(snippet.sourceId, {
          sourceId: snippet.sourceId,
          sourceType: snippet.sourceType,
          sourceTitle: snippet.sourceTitle,
          sourceUrl: snippet.sourceUrl,
          pdfFileName: snippet.pdfFileName,
          snippets: []
        });
      }

      groups.get(snippet.sourceId).snippets.push(snippet);
    });

    return Array.from(groups.values());
  }

  async function readSnippets() {
    if (global.chrome?.storage?.local) {
      try {
        const stored = await global.chrome.storage.local.get({ [STORAGE_KEY]: [] });
        return stored[STORAGE_KEY];
      } catch (error) {
        console.error("Study Reader: direct snippet storage read failed", error);
      }
    }

    if (global.chrome?.runtime?.sendMessage) {
      try {
        const response = await sendStorageMessage(MESSAGE_TYPES.GET);
        return response.snippets || [];
      } catch (error) {
        console.error("Study Reader: background snippet storage read failed", error);
        throw createStorageError(error);
      }
    }

    throw createStorageError(new Error("No storage API is available in this context."));
  }

  async function writeSnippets(snippets) {
    const normalized = normalizeSnippets(snippets);

    if (global.chrome?.storage?.local) {
      try {
        await global.chrome.storage.local.set({ [STORAGE_KEY]: normalized });
        return;
      } catch (error) {
        console.error("Study Reader: direct snippet storage write failed", error);
      }
    }

    if (global.chrome?.runtime?.sendMessage) {
      try {
        await sendStorageMessage(MESSAGE_TYPES.CLEAR);
        for (const snippet of normalized) {
          await sendStorageMessage(MESSAGE_TYPES.SAVE, { snippet });
        }
        return;
      } catch (error) {
        console.error("Study Reader: background snippet storage write failed", error);
        throw createStorageError(error);
      }
    }

    throw createStorageError(new Error("No storage API is available in this context."));
  }

  async function insertSnippet(normalizedSnippet, existingSnippets) {
    if (global.chrome?.storage?.local) {
      const nextSnippets = [normalizedSnippet, ...existingSnippets];
      await writeSnippets(nextSnippets);
      return {
        saved: true,
        duplicate: false,
        snippet: normalizedSnippet,
        snippets: nextSnippets
      };
    }

    const response = await sendStorageMessage(MESSAGE_TYPES.SAVE, {
      snippet: normalizedSnippet
    });

    return {
      saved: Boolean(response.saved),
      duplicate: Boolean(response.duplicate),
      snippet: normalizeSnippet(response.snippet || normalizedSnippet),
      snippets: normalizeSnippets(response.snippets || existingSnippets)
    };
  }

  async function sendStorageMessage(type, payload = {}) {
    if (!global.chrome?.runtime?.sendMessage) {
      throw new Error("Could not reach background service worker.");
    }

    const response = await global.chrome.runtime.sendMessage({
      type,
      ...payload
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not reach background service worker.");
    }

    return response;
  }

  function createStorageError(error) {
    const message = String(error?.message || error || "");

    if (/permission|access denied|storage/i.test(message)) {
      return new Error("Storage permission is missing. Check manifest.json for the storage permission.");
    }

    if (/could not establish connection|receiving end does not exist|service worker|message port closed/i.test(message)) {
      return new Error("Could not reach background service worker.");
    }

    return new Error(`Snippet storage failed: ${message || "Unknown storage error."}`);
  }

  function normalizeSourceUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString();
    } catch (_error) {
      return url.trim();
    }
  }

  function buildSourceId({ sourceType, sourceUrl, pdfFileName, sourceTitle }) {
    if (sourceType === "pdf") {
      return `pdf:${pdfFileName || sourceTitle}`;
    }

    return sourceUrl || `web:${sourceTitle}`;
  }

  function normalizeCreatedAt(createdAt) {
    if (typeof createdAt === "string" && createdAt.trim()) {
      const parsed = Date.parse(createdAt);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }
    }

    if (Number.isFinite(Number(createdAt))) {
      return new Date(Number(createdAt)).toISOString();
    }

    return new Date().toISOString();
  }

  function createSnippetId() {
    return `snippet-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function getDiagnostics(context = "unknown") {
    return {
      context,
      helperName: HELPER_NAME,
      storageKey: STORAGE_KEY,
      hasChrome: Boolean(global.chrome),
      hasChromeStorage: Boolean(global.chrome?.storage),
      hasChromeStorageLocal: Boolean(global.chrome?.storage?.local),
      hasChromeRuntime: Boolean(global.chrome?.runtime),
      hasChromeSendMessage: Boolean(global.chrome?.runtime?.sendMessage),
      hasPrimaryHelper: Boolean(global[HELPER_NAME]),
      hasLegacyHelper: Boolean(global[LEGACY_HELPER_NAME])
    };
  }

  const api = {
    STORAGE_KEY,
    HELPER_NAME,
    LEGACY_HELPER_NAME,
    MESSAGE_TYPES,
    getSnippets,
    saveSnippet,
    updateSnippet,
    deleteSnippet,
    clearSnippets,
    normalizeSnippet,
    normalizeSnippets,
    groupSnippetsBySource,
    getDiagnostics
  };

  global[HELPER_NAME] = api;
  global[LEGACY_HELPER_NAME] = api;

  if (global.window && typeof global.window === "object") {
    global.window[HELPER_NAME] = api;
    global.window[LEGACY_HELPER_NAME] = api;
  }
})(globalThis);
