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
  const pattern = new RegExp(`(<key>${afterKey}</key>\s*<true\/>\s*)`);
  if (!pattern.test(source)) throw new Error(`Unable to locate plist key: ${afterKey}`);
  return source.replace(pattern, `$1	<key>${newKey}</key>
	<true/>
`);
};

const insertBooleanKeyBefore = (source, beforeKey, newKey) => {
  if (source.includes(`<key>${newKey}</key>`)) return source;
  const pattern = new RegExp(`(<key>${beforeKey}</key>\s*<true\/>\s*)`);
  if (!pattern.test(source)) throw new Error(`Unable to locate plist key: ${beforeKey}`);
  return source.replace(pattern, `	<key>${newKey}</key>
	<true/>
$1`);
};

let text = readFileSync(plistPath, 'utf8');
text = insertBooleanKeyAfter(text, 'LSRequiresIPhoneOS', 'LSSupportsOpeningDocumentsInPlace');
text = insertBooleanKeyBefore(text, 'UIViewControllerBasedStatusBarAppearance', 'UIFileSharingEnabled');
writeFileSync(plistPath, text);
console.log('Configured iOS Files app integration.');
