const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const electronPackageDir = path.dirname(require.resolve('electron/package.json'));
const electronPackage = require(path.join(electronPackageDir, 'package.json'));
const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronPackageDir] }));

function getPlatformBinaryPath(platform = process.platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return 'electron';
    default:
      throw new Error(`Unsupported Electron platform: ${platform}`);
  }
}

async function ensureElectronBinary() {
  const executableRelativePath = getPlatformBinaryPath();
  const distDir = path.join(electronPackageDir, 'dist');
  const pathFile = path.join(electronPackageDir, 'path.txt');
  const executablePath = path.join(distDir, executableRelativePath);

  if (fs.existsSync(executablePath) && fs.existsSync(pathFile)) {
    return executablePath;
  }

  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require(path.join(electronPackageDir, 'checksums.json'))
  });

  await fs.promises.rm(distDir, { recursive: true, force: true });
  await fs.promises.mkdir(distDir, { recursive: true });
  execFileSync('unzip', ['-q', zipPath, '-d', distDir]);
  await fs.promises.writeFile(pathFile, executableRelativePath, 'utf8');
  await fs.promises.chmod(executablePath, 0o755).catch(() => {});

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Electron executable was not extracted to ${executablePath}`);
  }

  return executablePath;
}

async function main() {
  const electronBinary = await ensureElectronBinary();
  const child = spawn(electronBinary, [appRoot, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
