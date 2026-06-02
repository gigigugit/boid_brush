const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const { resolveAppRoot, startStaticServer } = require('./static-server.cjs');

let mainWindow = null;
let staticServer = null;

async function ensureStaticServer() {
  if (!staticServer) {
    staticServer = await startStaticServer({
      rootDir: resolveAppRoot(),
      port: 0,
      defaultPage: 'app.html'
    });
  }
  return staticServer;
}

async function createMainWindow() {
  const server = await ensureStaticServer();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0d1118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(server.appUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function shutdownStaticServer() {
  if (!staticServer) return;
  const serverToClose = staticServer;
  staticServer = null;
  await serverToClose.close().catch((error) => {
    console.error(`Failed to close Electron static server for ${serverToClose.appUrl}; app quit will continue:`, error);
  });
}

app.whenReady().then(async () => {
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await shutdownStaticServer();
});
