import type { Db } from './client.js';

/**
 * Writing to and reading from the one search index.
 *
 * Rows are keyed by kind and record id, so re-indexing a corrected record replaces its row
 * rather than leaving a stale copy behind. `occurred_on` rides along unindexed so a hit can
 * be ordered by date without a second lookup.
 */
/**
 * Folding Arabic before it is indexed.
 *
 * SQLite's `remove_diacritics` strips tashkeel, which is not the problem an Egyptian keyboard
 * actually creates. The problem is letters that are typed interchangeably: hamza carriers
 * (أ إ آ) for a bare alif, teh marbuta (ة) for heh (ه), alif maqsura (ى) for yeh (ي), and the
 * Arabic-Indic digits. A note written one way must be findable typed the other, so both the
 * indexed text and the query pass through the same folding — the only arrangement that
 * cannot drift.
 *
 * Latin text is untouched beyond what the tokenizer already does.
 */
export function fold(text: string): string {
  return text
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')  // آ أ إ ٱ  ->  ا
    .replace(/\u0629/g, '\u0647')                        // ة        ->  ه
    .replace(/\u0649/g, '\u064A')                        // ى        ->  ي
    .replace(/\u0640/g, '')                              // tatweel   ->  nothing
    .replace(/[\u064B-\u065F\u0670]/g, '')               // tashkeel  ->  nothing
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

export interface SearchRow {
  kind: 'expense' | 'giving' | 'income' | 'order' | 'movement' | 'lot';
  recordId: string;
  occurredOn: string;
  title: string;
  body: string;
}

export function indexRow(db: Db, row: SearchRow): void {
  db.$raw.prepare('DELETE FROM search WHERE kind = ? AND record_id = ?').run(row.kind, row.recordId);
  // The folded text is what gets indexed; the original is kept alongside it so a hit can be
  // shown back in the words it was written in.
  db.$raw.prepare(
    'INSERT INTO search (kind, record_id, occurred_on, title, body, shown_title, shown_body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.kind, row.recordId, row.occurredOn, fold(row.title), fold(row.body), row.title, row.body);
}

export function dropRow(db: Db, kind: string, recordId: string): void {
  db.$raw.prepare('DELETE FROM search WHERE kind = ? AND record_id = ?').run(kind, recordId);
}

export interface Hit {
  kind: string; recordId: string; occurredOn: string; title: string; body: string; rank: number;
}

/**
 * Search every log.
 *
 * The query is quoted and suffixed rather than passed through, because FTS5 treats bare
 * punctuation as syntax and a person typing an account number should not get a parse error.
 * The trailing `*` is what makes it behave like the search boxes it backs: typing "trav"
 * finds travel before the word is finished.
 */
export function search(db: Db, q: string, opts: { kinds?: string[]; limit?: number } = {}): Hit[] {
  const term = q.trim();
  if (!term) return [];
  const safe = `"${fold(term).replace(/"/g, '""')}"*`;
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const rows = db.$raw.prepare(`
    SELECT kind, record_id AS recordId, occurred_on AS occurredOn,
           shown_title AS title, shown_body AS body, rank
    FROM search
    WHERE search MATCH ?
      ${kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''}
    ORDER BY rank, occurred_on DESC
    LIMIT ?
  `).all(...[safe, ...(kinds ?? []), opts.limit ?? 50]) as Hit[];
  return rows;
}
