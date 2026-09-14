import { useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Chip, Field } from './UI';

export interface Term {
  id: string;
  name: string;
  icon: IconName;
  color: string;
  note?: string;
  archived?: boolean;
  /** some lists carry a behavioural flag; the label for it comes from the editor's props */
  flag?: boolean;
}

const ICONS: IconName[] = [
  'expenses', 'banknote', 'car', 'goldbar', 'building', 'stocks', 'charity', 'zakat',
  'income', 'flow', 'accounts', 'assets', 'clock', 'bell', 'plus', 'check', 'warn', 'settings',
];

const SWATCHES = [
  '#00A32E', '#0086A8', '#7A00E0', '#B37E00', '#E00000', '#C4574C',
  '#3F7D4F', '#2B5FA5', '#6B4E9E', '#8C3B48', '#B5602A', '#2F7B7B',
];

/**
 * An editable list of the user's own words. Nothing here is seeded from a fixed
 * vocabulary the app insists on — the rows below are only what happens to exist now.
 */
export function TaxonomyEditor({ title, hint, initial, addLabel, flagLabel, flagHint }: {
  title: string;
  hint: string;
  initial: Term[];
  addLabel: string;
  flagLabel?: string;
  flagHint?: string;
}) {
  const [terms, setTerms] = useState<Term[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Term | null>(null);

  const startAdd = () => {
    const t: Term = { id: `new-${Date.now()}`, name: '', icon: 'expenses', color: SWATCHES[0]!, flag: false };
    setDraft(t); setEditing(t.id);
  };
  const startEdit = (t: Term) => { setDraft({ ...t }); setEditing(t.id); };
  const commit = () => {
    if (!draft || !draft.name.trim()) { setEditing(null); setDraft(null); return; }
    setTerms((rows) => (rows.some((r) => r.id === draft.id)
      ? rows.map((r) => (r.id === draft.id ? draft : r))
      : [...rows, draft]));
    setEditing(null); setDraft(null);
  };
  const archive = (id: string) =>
    setTerms((rows) => rows.map((r) => (r.id === id ? { ...r, archived: !r.archived } : r)));

  return (
    <section className="panel" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
        <button className="btn add" style={{ marginLeft: 'auto' }} onClick={startAdd}>
          <Icon name="plus" size={14} /> {addLabel}
        </button>
      </div>
      <p style={{ margin: '4px 0 18px', fontSize: 12, color: 'var(--faint)', maxWidth: 760, lineHeight: 1.5 }}>{hint}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {terms.map((t) => (
          editing === t.id && draft
            ? <TermForm key={t.id} draft={draft} setDraft={setDraft} onSave={commit}
                        onCancel={() => { setEditing(null); setDraft(null); }}
                        flagLabel={flagLabel} flagHint={flagHint} />
            : (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: '38px minmax(0,1fr) auto auto', gap: 14, alignItems: 'center',
                padding: '12px 14px', borderRadius: 'var(--r-card)',
                background: t.archived ? 'transparent' : 'var(--raised)',
                border: '1px solid var(--hairline)', opacity: t.archived ? 0.55 : 1,
              }}>
                <span style={{
                  width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: `color-mix(in srgb, ${t.color} 15%, transparent)`,
                }}>
                  <Icon name={t.icon} size={17} color={t.color} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{t.name}</div>
                  {t.note && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{t.note}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {t.archived && <Chip>archived</Chip>}
                  {flagLabel && t.flag && <Chip tone="warn">{flagLabel}</Chip>}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn quiet" style={{ padding: 6, border: 'none' }}
                          aria-label={`Edit ${t.name}`} onClick={() => startEdit(t)}>
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="btn quiet" style={{ padding: 6, border: 'none' }}
                          aria-label={`${t.archived ? 'Restore' : 'Archive'} ${t.name}`} onClick={() => archive(t.id)}>
                    <Icon name={t.archived ? 'check' : 'close'} size={15} />
                  </button>
                </div>
              </div>
            )
        ))}

        {editing && draft && !terms.some((r) => r.id === draft.id) && (
          <TermForm draft={draft} setDraft={setDraft} onSave={commit}
                    onCancel={() => { setEditing(null); setDraft(null); }}
                    flagLabel={flagLabel} flagHint={flagHint} />
        )}
      </div>

      <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--faint)' }}>
        Archiving keeps every record that already points at a term. Deleting one outright is
        refused for the same reason a used account cannot be deleted — it would rewrite history.
      </p>
    </section>
  );
}

function TermForm({ draft, setDraft, onSave, onCancel, flagLabel, flagHint }: {
  draft: Term; setDraft: (t: Term) => void; onSave: () => void; onCancel: () => void;
  flagLabel?: string; flagHint?: string;
}) {
  return (
    <div style={{
      padding: 18, borderRadius: 'var(--r-card)', background: 'var(--surface)',
      border: '1px solid color-mix(in srgb, var(--accent) 34%, transparent)',
    }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span style={{
          width: 52, height: 52, borderRadius: 12, flex: '0 0 52px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${draft.color} 15%, transparent)`,
        }}>
          <Icon name={draft.icon} size={24} color={draft.color} />
        </span>
        <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="What you call it">
            <input autoFocus value={draft.name} placeholder="Travel and leisure"
                   aria-label="What you call it"
                   onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="A line about it" hint="optional — shows under the name">
            <input value={draft.note ?? ''} placeholder="Flights, hotels, anything on a trip"
                   aria-label="A line about it"
                   onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
        <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 8 }}>Icon</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ICONS.map((ic) => (
                <button key={ic} aria-label={ic} onClick={() => setDraft({ ...draft, icon: ic })}
                  style={{
                    width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: draft.icon === ic ? `color-mix(in srgb, ${draft.color} 16%, transparent)` : 'var(--raised)',
                    border: `1px solid ${draft.icon === ic ? draft.color : 'var(--hairline)'}`,
                  }}>
                  <Icon name={ic} size={15} color={draft.icon === ic ? draft.color : 'var(--muted)'} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 8 }}>Colour</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {SWATCHES.map((c) => (
                <button key={c} aria-label={`Colour ${c}`} onClick={() => setDraft({ ...draft, color: c })}
                  style={{
                    width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer',
                    border: '1px solid var(--hairline)',
                    outline: draft.color === c ? `2px solid ${c}` : 'none', outlineOffset: 2,
                  }} />
              ))}
              <input value={draft.color} aria-label="Custom colour" className="mono"
                     onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                     style={{ width: 96, marginLeft: 4 }} />
            </div>
          </div>
        </div>
      </div>

      {flagLabel && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: 13 }}>
          <input type="checkbox" checked={draft.flag ?? false}
                 onChange={(e) => setDraft({ ...draft, flag: e.target.checked })}
                 style={{ width: 16, height: 16, padding: 0 }} />
          <span>{flagLabel}{flagHint && <span style={{ color: 'var(--faint)' }}> — {flagHint}</span>}</span>
        </label>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onCancel}>
          <Icon name="close" size={14} motion="none" /> Cancel
        </button>
        <button className="btn go" onClick={onSave}>
          <Icon name="check" size={14} motion="none" /> Save
        </button>
      </div>
    </div>
  );
}
