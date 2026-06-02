const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('boidBrushDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  })
}));
