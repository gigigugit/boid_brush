import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xcodeproj = path.join(repoRoot, 'ios', 'App', 'App.xcodeproj');

if (existsSync(xcodeproj)) {
  console.log('iOS shell already exists; skipping `cap add ios`.');
  process.exit(0);
}

const result = spawnSync('npx', ['cap', 'add', 'ios'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
