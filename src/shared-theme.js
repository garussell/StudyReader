(function initStudyReaderTheme(global) {
  const STORAGE_KEY = "studyReaderTheme";
  const DEFAULT_THEME = "system";
  const DARK_QUERY = "(prefers-color-scheme: dark)";
  const SUPPORTED_THEMES = new Set(["system", "light", "dark"]);
  const watchers = new Set();
  const mediaQuery = typeof global.matchMedia === "function"
    ? global.matchMedia(DARK_QUERY)
    : null;

  let currentMode = DEFAULT_THEME;
  let initialized = false;

  function normalizeThemeMode(input) {
    return SUPPORTED_THEMES.has(input) ? input : DEFAULT_THEME;
  }

  function resolveTheme(mode = currentMode) {
    const normalized = normalizeThemeMode(mode);
    if (normalized === "system") {
      return mediaQuery?.matches ? "dark" : "light";
    }

    return normalized;
  }

  async function getThemeMode() {
    if (global.chrome?.storage?.local) {
      try {
        const stored = await global.chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_THEME });
        return normalizeThemeMode(stored[STORAGE_KEY]);
      } catch (_error) {
        // Fall through to local fallback.
      }
    }

    try {
      return normalizeThemeMode(global.localStorage?.getItem(STORAGE_KEY));
    } catch (_error) {
      return DEFAULT_THEME;
    }
  }

  async function saveThemeMode(mode) {
    const normalized = normalizeThemeMode(mode);
    currentMode = normalized;

    if (global.chrome?.storage?.local) {
      try {
        await global.chrome.storage.local.set({ [STORAGE_KEY]: normalized });
        emitThemeChange();
        return normalized;
      } catch (_error) {
        // Fall through to local fallback.
      }
    }

    try {
      global.localStorage?.setItem(STORAGE_KEY, normalized);
    } catch (_error) {
      // Ignore local storage persistence errors.
    }

    emitThemeChange();
    return normalized;
  }

  function applyDocumentTheme(themeMode = currentMode) {
    const resolvedTheme = resolveTheme(themeMode);
    if (global.document?.documentElement) {
      global.document.documentElement.dataset.themeMode = normalizeThemeMode(themeMode);
      global.document.documentElement.dataset.theme = resolvedTheme;
    }

    return resolvedTheme;
  }

  function emitThemeChange() {
    const payload = {
      mode: currentMode,
      resolvedTheme: resolveTheme(currentMode)
    };

    watchers.forEach((watcher) => {
      try {
        watcher(payload);
      } catch (error) {
        console.error("Study Reader: theme watcher failed", error);
      }
    });
  }

  async function refreshThemeMode(nextMode) {
    currentMode = nextMode === undefined
      ? await getThemeMode()
      : normalizeThemeMode(nextMode);

    emitThemeChange();
    return {
      mode: currentMode,
      resolvedTheme: resolveTheme(currentMode)
    };
  }

  function ensureListeners() {
    if (initialized) {
      return;
    }

    initialized = true;

    if (global.chrome?.storage?.onChanged) {
      global.chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
          return;
        }

        refreshThemeMode(changes[STORAGE_KEY]?.newValue);
      });
    }

    if (mediaQuery) {
      const handleSystemThemeChange = () => {
        if (currentMode === "system") {
          emitThemeChange();
        }
      };

      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleSystemThemeChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(handleSystemThemeChange);
      }
    }
  }

  function watchTheme(watcher) {
    ensureListeners();
    watchers.add(watcher);
    refreshThemeMode().catch((error) => {
      console.error("Study Reader: failed to refresh theme mode", error);
    });

    return () => {
      watchers.delete(watcher);
    };
  }

  function watchDocumentTheme() {
    return watchTheme(({ mode, resolvedTheme }) => {
      if (global.document?.documentElement) {
        global.document.documentElement.dataset.themeMode = mode;
        global.document.documentElement.dataset.theme = resolvedTheme;
      }
    });
  }

  global.StudyReaderTheme = {
    STORAGE_KEY,
    DEFAULT_THEME,
    normalizeThemeMode,
    resolveTheme,
    getThemeMode,
    saveThemeMode,
    applyDocumentTheme,
    watchTheme,
    watchDocumentTheme
  };

  const isExtensionPage = /^(chrome|moz)-extension:$/.test(global.location?.protocol || "");
  if (isExtensionPage) {
    watchDocumentTheme();
  }
})(globalThis);
