import { createHash } from 'node:crypto';

// Verified against nodejs/node v24.19.0/LICENSE. Only upstream contact-address
// findings are exempted; credential and path rules still scan the entire file.
const NODE_LICENSE_SHA256 = '148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5';
// Public npm metadata for glob@7.2.3, independently checked against the registry.
const GLOB_NOTICE_SHA256 = '55485ce46ec1f7d3378548cbc9d651e489f775e5b19ce47544e7c1de8782b504';
const PATCH_FILENAME = ['app-builder-lib', '26.15.3.patch'].join('@');
const rules = [
  [
    'credential token',
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential in URL', /https?:\/\/[^\s/]+:[^\s/@]+@/i],
  [
    'personal home path',
    /(?:[A-Z]:[\\/]Users[\\/]|\/(?:Users|home)\/)(?!(?:user|username|example|name)[\\/])[^\\/\s"']+/i,
  ],
  ['embedded account identifier', /\b(?:cli_[a-z0-9]{16,}|ou_[a-z0-9]{16,}|oc_[a-z0-9]{16,})\b/],
  ['phone-number-shaped value', /\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/],
];
const secretAssignment =
  /\b(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']([^"']+)["']/gi;
const placeholder =
  /^(?:|example|placeholder|changeme|your[-_].*|replace[-_].*|\$\{[^}]+\}|<[^>]+>)$/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function inspectPath(file) {
  const path = file.replaceAll('\\', '/');
  const leaf = path.split('/').at(-1);
  if (
    (/^\.env(?:\.|$)/.test(leaf) && leaf !== '.env.example') ||
    /\.(?:pem|p12|pfx|key)$/i.test(leaf)
  )
    return 'credential file';
  if (
    /(?:^|\/)(?:node_modules|dist|release|test-results|screenshots|profiles|\.cache|\.openai|\.codex)(?:\/|$)/.test(
      path,
    )
  )
    return 'local or generated data';
  if (/\.(?:docx?|pdf|xlsx?|db|sqlite3?|log|dmp|heapsnapshot|har)$/i.test(leaf))
    return 'document or runtime data';
}

export function inspectContent(file, buffer) {
  if (buffer.includes(0)) {
    // The one binary source asset is a generated application icon, reviewed manually.
    return file === 'assets/icon.ico' ? [] : [{ line: 0, category: 'binary file requires review' }];
  }
  const text = buffer.toString('utf8').replaceAll('\r\n', '\n');
  const officialLicense =
    file === 'web/NODE-LICENSE.txt' &&
    createHash('sha256').update(text).digest('hex') === NODE_LICENSE_SHA256;
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    const add = (category) => findings.push({ line: index + 1, category });
    for (const [category, pattern] of rules) if (pattern.test(line)) add(category);
    for (const match of line.matchAll(secretAssignment))
      if (!placeholder.test(match[1])) add('hard-coded credential value');
    for (const match of line.matchAll(emailPattern)) {
      const address = match[0];
      // A dependency patch filename is not an email address. Match the exact filename only.
      const patchName =
        address === PATCH_FILENAME &&
        line.includes('patches/' + address) &&
        ['pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file);
      const officialNotice =
        file === 'pnpm-lock.yaml' &&
        createHash('sha256')
          .update(line.trim().replace(/^deprecated: /, ''))
          .digest('hex') === GLOB_NOTICE_SHA256;
      if (
        !officialLicense &&
        !officialNotice &&
        !patchName &&
        !/@(?:users\.noreply\.github\.com|example\.com)$/i.test(address)
      )
        add('contact address requires review');
    }
  }
  return findings;
}

export function isPrivateCommitEmail(email) {
  return /^[^\s@]+@users\.noreply\.github\.com$/i.test(email);
}
