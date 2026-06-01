import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(repoRoot, 'ios', 'App', 'App', 'Info.plist');

if (!existsSync(plistPath)) {
  console.log('No iOS Info.plist found; skipping iOS shell configuration.');
  process.exit(0);
}

let text = readFileSync(plistPath, 'utf8');
if (!text.includes('<key>LSSupportsOpeningDocumentsInPlace</key>')) {
  text = text.replace(
    '\t<key>LSRequiresIPhoneOS</key>\n\t<true/>\n',
    '\t<key>LSRequiresIPhoneOS</key>\n\t<true/>\n\t<key>LSSupportsOpeningDocumentsInPlace</key>\n\t<true/>\n',
  );
}
if (!text.includes('<key>UIFileSharingEnabled</key>')) {
  text = text.replace(
    '\t<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<true/>\n',
    '\t<key>UIFileSharingEnabled</key>\n\t<true/>\n\t<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<true/>\n',
  );
}
writeFileSync(plistPath, text);
console.log('Configured iOS Files app integration.');
