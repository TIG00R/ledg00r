import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The skill: one document, three readers.
 *
 * What a model needs to drive this ledger well — the write discipline, the shape of a
 * receipt, the zakat rules — used to live as a string inside the chat loop, which meant the
 * built-in assistant knew the house rules and an assistant connected over MCP did not. It is
 * a file now: the assistant's system prompt, the `ledger://skill` resource, and the download
 * at `/skill.md` are all the same bytes, so none of them can quietly fall behind the others.
 *
 * It is read from disk once and kept. The file ships with the source and is not editable from
 * the app, so re-reading it per turn would buy nothing.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** apps/api/src → the repository root, and the same layout inside the container. */
const CANDIDATES = [
  resolve(HERE, '../../../skills/ledg00r/SKILL.md'),
  resolve(process.cwd(), 'skills/ledg00r/SKILL.md'),
];

let cached: string | null = null;

export function skillText(): string {
  if (cached !== null) return cached;
  for (const path of CANDIDATES) {
    try {
      cached = readFileSync(path, 'utf8');
      return cached;
    } catch { /* try the next one */ }
  }
  throw new Error(`skills/ledg00r/SKILL.md was not found; looked in ${CANDIDATES.join(' and ')}`);
}

/**
 * The same document with its frontmatter taken off, for a model that is being handed it as a
 * system prompt rather than installing it as a skill. The frontmatter addresses whatever
 * loads the file, not the model reading it.
 */
export function skillPrompt(): string {
  const text = skillText();
  const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
  return (end === -1 ? text : text.slice(end + 5)).trim();
}
