(function initStudyReaderPrefs(global) {
  const DEFAULT_PREFS = Object.freeze({
    rate: 1,
    voiceName: ""
  });

  const LOCAL_PREFS_KEY = "study-reader.tts-prefs";

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizePrefs(input = {}) {
    return {
      rate: clamp(Number(input.rate) || DEFAULT_PREFS.rate, 0.5, 2),
      voiceName: typeof input.voiceName === "string" ? input.voiceName : ""
    };
  }

  async function getPrefs() {
    const storedPrefs = await getPrefsFromChromeStorage();
    if (storedPrefs) {
      return normalizePrefs(storedPrefs);
    }

    return normalizePrefs(getPrefsFromLocalStorage());
  }

  async function savePrefs(prefs) {
    const normalizedPrefs = normalizePrefs(prefs);

    if (await savePrefsToChromeStorage(normalizedPrefs)) {
      return normalizedPrefs;
    }

    savePrefsToLocalStorage(normalizedPrefs);
    return normalizedPrefs;
  }

  function prefsFromStorageChanges(changes, currentPrefs = DEFAULT_PREFS) {
    return normalizePrefs({
      ...currentPrefs,
      rate: changes.rate?.newValue ?? currentPrefs.rate,
      voiceName: changes.voiceName?.newValue ?? currentPrefs.voiceName
    });
  }

  async function getPrefsFromChromeStorage() {
    if (!global.chrome?.storage?.sync) {
      return null;
    }

    try {
      return await global.chrome.storage.sync.get(DEFAULT_PREFS);
    } catch (_error) {
      return null;
    }
  }

  async function savePrefsToChromeStorage(prefs) {
    if (!global.chrome?.storage?.sync) {
      return false;
    }

    try {
      await global.chrome.storage.sync.set(prefs);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getPrefsFromLocalStorage() {
    try {
      const rawPrefs = global.localStorage?.getItem(LOCAL_PREFS_KEY);
      return rawPrefs ? JSON.parse(rawPrefs) : DEFAULT_PREFS;
    } catch (_error) {
      return DEFAULT_PREFS;
    }
  }

  function savePrefsToLocalStorage(prefs) {
    try {
      global.localStorage?.setItem(LOCAL_PREFS_KEY, JSON.stringify(prefs));
    } catch (_error) {
      // Ignore local storage persistence errors and keep the in-memory preference.
    }
  }

  global.StudyReaderPrefs = {
    DEFAULT_PREFS,
    normalizePrefs,
    getPrefs,
    savePrefs,
    prefsFromStorageChanges
  };
})(globalThis);
