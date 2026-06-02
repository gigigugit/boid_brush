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

function extractElectronZip(zipPath, distDir) {
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'param($zipPath, $distDir) Expand-Archive -LiteralPath $zipPath -DestinationPath $distDir -Force',
        zipPath,
        distDir
      ], { stdio: 'inherit' });
    } catch (error) {
      throw new Error(
        `Failed to extract Electron on Windows. Ensure PowerShell is available in PATH or install it from https://aka.ms/powershell, then retry unpacking ${zipPath}.`,
        { cause: error }
      );
    }
    return;
  }

  try {
    execFileSync('unzip', ['-q', zipPath, '-d', distDir], { stdio: 'inherit' });
    return;
  } catch (error) {
    execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, distDir], { stdio: 'inherit' });
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
  extractElectronZip(zipPath, distDir);
  await fs.promises.writeFile(pathFile, executableRelativePath, 'utf8');
  await fs.promises.chmod(executablePath, 0o755).catch((error) => {
    console.warn(`Unable to mark Electron binary as executable at ${executablePath}. This may prevent the desktop app from launching; check file permissions or run chmod manually.`, error);
  });

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Electron executable was not extracted to ${executablePath}`);
  }

  return executablePath;
}

async function main() {
  await ensureElectronBinary();
  const electronCli = path.join(electronPackageDir, 'cli.js');
  const child = spawn(process.execPath, [electronCli, appRoot, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
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
