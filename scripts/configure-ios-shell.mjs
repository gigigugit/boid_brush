import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(repoRoot, 'ios', 'App', 'App', 'Info.plist');

if (!existsSync(plistPath)) {
  console.log('No iOS Info.plist found; skipping iOS shell configuration.');
  process.exit(0);
}

const insertBooleanKeyAfter = (source, afterKey, newKey) => {
  if (source.includes(`<key>${newKey}</key>`)) return source;
  const pattern = new RegExp(`<key>${afterKey}</key>[\\s\\r\\n]*<true/>[\\s\\r\\n]*`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Unable to locate plist key '${afterKey}' in ${plistPath}. Verify that the iOS shell was generated correctly.`);
  }
  return source.replace(pattern, `${match[0]}\t<key>${newKey}</key>\n\t<true/>\n`);
};

const insertBooleanKeyBefore = (source, beforeKey, newKey) => {
  if (source.includes(`<key>${newKey}</key>`)) return source;
  const pattern = new RegExp(`<key>${beforeKey}</key>[\\s\\r\\n]*<true/>[\\s\\r\\n]*`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Unable to locate plist key '${beforeKey}' in ${plistPath}. Verify that the iOS shell was generated correctly.`);
  }
  return source.replace(pattern, `\t<key>${newKey}</key>\n\t<true/>\n${match[0]}`);
};

let text = readFileSync(plistPath, 'utf8');
text = insertBooleanKeyAfter(text, 'LSRequiresIPhoneOS', 'LSSupportsOpeningDocumentsInPlace');
text = insertBooleanKeyBefore(text, 'UIViewControllerBasedStatusBarAppearance', 'UIFileSharingEnabled');
writeFileSync(plistPath, text);
console.log('Configured iOS Files app integration.');
