const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function resolveAppRoot() {
  return path.resolve(__dirname, '..');
}

function toFilePath(rootDir, requestPath, defaultPage) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = decodedPath === '/'
    ? `/${defaultPage}`
    : path.posix.normalize(decodedPath);
  const strippedPath = normalizedPath.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootDir, strippedPath);
  const relativePath = path.relative(rootDir, absolutePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
}

function createRequestHandler({ rootDir, defaultPage }) {
  return async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      let filePath = toFilePath(rootDir, requestUrl.pathname, defaultPage);
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const stats = await fs.promises.stat(filePath).catch(() => null);
      if (stats?.isDirectory()) {
        filePath = path.join(filePath, defaultPage);
      }

      const finalStats = await fs.promises.stat(filePath).catch(() => null);
      if (!finalStats?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[extension] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      console.error('Electron static server error:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  };
}

async function startStaticServer({
  rootDir = resolveAppRoot(),
  host = '127.0.0.1',
  port = 0,
  defaultPage = 'app.html'
} = {}) {
  const server = http.createServer(createRequestHandler({ rootDir, defaultPage }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine static server address');
  }

  const baseUrl = `http://${host}:${address.port}`;
  const appUrl = `${baseUrl}/${defaultPage}`;

  return {
    server,
    host,
    port: address.port,
    baseUrl,
    appUrl,
    close: () => new Promise((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    })
  };
}

module.exports = {
  resolveAppRoot,
  startStaticServer
};
