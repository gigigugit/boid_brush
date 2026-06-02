(() => {
  const STORAGE_SNAPSHOT_KEY = 'bb.native.localStorage.v1';
  const DIRECTORY_DOCUMENTS = 'DOCUMENTS';
  const DIRECTORY_DATA = 'DATA';
  const DIRECTORY_CACHE = 'CACHE';

  const getCapacitor = () => window.Capacitor || null;
  const getPlugin = name => getCapacitor()?.Plugins?.[name] || null;
  const isNativeShell = () => {
    const cap = getCapacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform === 'function') return !!cap.isNativePlatform();
    if (typeof cap.getPlatform === 'function') return ['ios', 'android'].includes(cap.getPlatform());
    return false;
  };

  let mirrorInstalled = false;
  let mirrorTimer = null;

  const markNativeShell = () => {
    if (!isNativeShell()) return;
    document.documentElement.classList.add('bb-native-shell');
    if (document.body) document.body.classList.add('bb-native-shell');
    else document.addEventListener('DOMContentLoaded', () => document.body?.classList.add('bb-native-shell'), { once: true });
  };

  const serializeLocalStorage = () => {
    const snapshot = {};
    try {
      const keys = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key) keys.push(key);
      }
      keys.forEach(key => {
        const value = window.localStorage.getItem(key);
        if (typeof value === 'string') snapshot[key] = value;
      });
    } catch (error) {
      console.warn('Local storage snapshot failed:', error);
    }
    return snapshot;
  };

  const restoreLocalStorage = snapshot => {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    try {
      Object.entries(snapshot).forEach(([key, value]) => {
        if (typeof value !== 'string') return;
        if (window.localStorage.getItem(key) == null) window.localStorage.setItem(key, value);
      });
      return true;
    } catch (error) {
      console.warn('Local storage restore failed:', error);
      return false;
    }
  };

  const persistLocalStorageSnapshot = async () => {
    if (!isNativeShell()) return false;
    const Preferences = getPlugin('Preferences');
    if (!Preferences?.set) return false;
    try {
      await Preferences.set({
        key: STORAGE_SNAPSHOT_KEY,
        value: JSON.stringify(serializeLocalStorage()),
      });
      return true;
    } catch (error) {
      console.warn('Native storage mirror failed:', error);
      return false;
    }
  };

  const scheduleLocalStorageMirror = () => {
    if (!isNativeShell()) return;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = window.setTimeout(() => {
      mirrorTimer = null;
      void persistLocalStorageSnapshot();
    }, 120);
  };

  const installLocalStorageMirroring = () => {
    if (mirrorInstalled || !isNativeShell()) return;
    mirrorInstalled = true;
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    const removeItem = storage.removeItem.bind(storage);
    const clear = storage.clear.bind(storage);
    storage.setItem = (key, value) => {
      setItem(key, value);
      scheduleLocalStorageMirror();
    };
    storage.removeItem = key => {
      removeItem(key);
      scheduleLocalStorageMirror();
    };
    storage.clear = () => {
      clear();
      scheduleLocalStorageMirror();
    };
    window.addEventListener('pagehide', () => void persistLocalStorageSnapshot());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void persistLocalStorageSnapshot();
    });
  };

  const preloadLocalStorageSnapshot = async () => {
    if (!isNativeShell()) return false;
    const Preferences = getPlugin('Preferences');
    if (!Preferences?.get) return false;
    try {
      const { value } = await Preferences.get({ key: STORAGE_SNAPSHOT_KEY });
      if (!value) return false;
      return restoreLocalStorage(JSON.parse(value));
    } catch (error) {
      console.warn('Native storage preload failed:', error);
      return false;
    }
  };

  const fileToBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // Match a standard data URL: data:mime/type;base64,<base64 payload>, allowing optional whitespace in the payload.
      const match = result.match(/^data:[^;]+;base64,([A-Za-z0-9+/=\s]+)$/s);
      if (!match) {
        reject(new Error('Unexpected data URL format'));
        return;
      }
      resolve(match[1].replace(/\s+/g, ''));
    };
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });

  const blobToBase64 = blob => fileToBase64(blob);

  const saveBlob = async (blob, filename, options = {}) => {
    if (!blob || !(blob instanceof Blob)) throw new Error(`Expected a Blob to save, but received ${blob === null ? 'null' : typeof blob}`);
    if (!isNativeShell()) return { saved: false, native: false };
    const Filesystem = getPlugin('Filesystem');
    if (!Filesystem?.writeFile) return { saved: false, native: false };
    const directory = options.directory || DIRECTORY_DOCUMENTS;
    const pathName = options.path || filename;
    const data = await blobToBase64(blob);
    await Filesystem.writeFile({
      path: pathName,
      data,
      directory,
      recursive: true,
    });
    const uri = Filesystem.getUri
      ? await Filesystem.getUri({ path: pathName, directory })
      : null;
    return {
      saved: true,
      native: true,
      directory,
      path: pathName,
      uri: uri?.uri || uri || null,
    };
  };

  const shareBlob = async (blob, filename, options = {}) => {
    if (!blob || !(blob instanceof Blob)) throw new Error(`Expected a Blob to share, but received ${blob === null ? 'null' : typeof blob}`);
    if (!isNativeShell()) return { shared: false, native: false };
    const Share = getPlugin('Share');
    if (!Share?.share) return { shared: false, native: false };
    const saved = await saveBlob(blob, options.cachePath || pathJoin('shared', filename), {
      directory: DIRECTORY_CACHE,
    });
    const payload = {
      title: options.title || filename,
      text: options.text || '',
      dialogTitle: options.dialogTitle || options.title || filename,
    };
    if (saved.uri) {
      payload.url = saved.uri;
      payload.files = [saved.uri];
    }
    await Share.share(payload);
    return { shared: true, native: true, uri: saved.uri || null };
  };

  const pickFile = ({ accept = '', multiple = false } = {}) => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(multiple ? files : (files[0] || null));
    }, { once: true });
    input.click();
  });

  const readText = async file => {
    if (!file) return '';
    if (typeof file.text === 'function') return file.text();
    const buffer = await readArrayBuffer(file);
    return new TextDecoder().decode(buffer);
  };

  const readArrayBuffer = async file => {
    if (!file) return new ArrayBuffer(0);
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    if (typeof file === 'string') {
      const Filesystem = getPlugin('Filesystem');
      if (!Filesystem?.readFile) throw new Error('Filesystem plugin unavailable - cannot read file from native path');
      const { data } = await Filesystem.readFile({ path: file });
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    throw new Error('Unsupported file source type. Expected File object, Blob, or native file path string.');
  };

  const pathJoin = (...parts) => parts
    .filter(Boolean)
    .map(part => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

  const preload = async () => {
    markNativeShell();
    if (!isNativeShell()) return false;
    await preloadLocalStorageSnapshot();
    installLocalStorageMirroring();
    return true;
  };

  markNativeShell();

  window.BoidBrushPlatform = {
    DIRECTORY_DOCUMENTS,
    DIRECTORY_DATA,
    DIRECTORY_CACHE,
    getPlugin,
    isNativeShell,
    preload,
    preloadLocalStorageSnapshot,
    persistLocalStorageSnapshot,
    installLocalStorageMirroring,
    saveBlob,
    shareBlob,
    pickFile,
    readText,
    readArrayBuffer,
  };
})();
