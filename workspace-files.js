const DB_NAME = 'boid-brush-files';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'corral-svg-directory';
const SVG_NAME_PATTERN = /^[^/\\\0]+\.svg$/i;

function openHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openHandleDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function rememberHandle(handle) {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', store => store.put(handle, HANDLE_KEY));
}

async function restoreHandle() {
  if (typeof indexedDB === 'undefined') return null;
  return withStore('readonly', store => store.get(HANDLE_KEY));
}

async function queryPermission(handle, request = false) {
  if (!handle) return 'denied';
  const options = { mode: 'readwrite' };
  let state = await handle.queryPermission?.(options) || 'prompt';
  if (state === 'prompt' && request) state = await handle.requestPermission?.(options) || 'denied';
  return state;
}

export async function listSvgFiles(handle, { maxEntries = 200, maxDepth = 4 } = {}) {
  const files = [];
  if (!handle || await queryPermission(handle) !== 'granted') return files;
  const visit = async (directory, parentPath = '', depth = 0) => {
    if (depth > maxDepth || files.length >= maxEntries) return;
    const entries = [];
    for await (const pair of directory.entries()) entries.push(pair);
    entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, entry] of entries) {
      if (files.length >= maxEntries) break;
      const path = parentPath ? `${parentPath}/${name}` : name;
      if (entry.kind === 'file' && SVG_NAME_PATTERN.test(name)) {
        files.push({ name, path, depth, handle: entry });
      } else if (entry.kind === 'directory' && depth < maxDepth) {
        await visit(entry, path, depth + 1);
      }
    }
  };
  await visit(handle);
  return files;
}

export class CorralFileWorkspace {
  constructor() {
    this.directory = null;
  }

  get supported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  async restore() {
    if (!this.supported) return { permission: 'unsupported', files: [] };
    this.directory = await restoreHandle().catch(() => null);
    const permission = await queryPermission(this.directory);
    return { permission, files: permission === 'granted' ? await listSvgFiles(this.directory) : [] };
  }

  async choose() {
    if (!this.supported) return { permission: 'unsupported', files: [] };
    this.directory = await window.showDirectoryPicker({ id: 'boid-brush-corral-svg', mode: 'readwrite' });
    const permission = await queryPermission(this.directory, true);
    if (permission === 'granted') await rememberHandle(this.directory);
    return { permission, files: permission === 'granted' ? await listSvgFiles(this.directory) : [] };
  }

  async reconnect() {
    const permission = await queryPermission(this.directory, true);
    return { permission, files: permission === 'granted' ? await listSvgFiles(this.directory) : [] };
  }

  async refresh() {
    const permission = await queryPermission(this.directory);
    return { permission, files: permission === 'granted' ? await listSvgFiles(this.directory) : [] };
  }

  async read(fileHandle) {
    if (await queryPermission(this.directory) !== 'granted') throw new Error('Directory permission is required');
    return (await fileHandle.getFile()).text();
  }

  async write(filename, text) {
    if (!SVG_NAME_PATTERN.test(filename)) throw new Error('Use a simple .svg filename');
    if (await queryPermission(this.directory) !== 'granted') throw new Error('Directory permission is required');
    const existing = await this.directory.getFileHandle(filename).catch(() => null);
    if (existing && !window.confirm(`Replace ${filename}?`)) return false;
    const handle = existing || await this.directory.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  }
}
