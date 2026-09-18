import { useEffect, useMemo, useState } from 'react';
import { ledger } from '../api';
import { useLive } from '../Live';
import { useApp } from '../AppState';
import { Page, Panel, Stat, Stats, Chip } from '../components/UI';
import { RecordTable } from '../components/RecordTable';
import { SectionProvider, Sections } from '../components/Sections';

/**
 * What was done, as opposed to what happened to the money.
 *
 * Every other log here is a log of movements, and a movement is a poor record of most of
 * what a person actually does to a ledger: renaming a destination, archiving an account,
 * switching a reminder off, restating a balance, being refused. None of those move anything,
 * and restating a balance now deliberately moves nothing at all — so without this screen the
 * act would be invisible, which is the one thing a ledger must never let an act be.
 */
export function Logs() {
  return (
    <SectionProvider first="actions"><Body /></SectionProvider>
  );
}

interface Action {
  id: string; at: string; capability: string; context: string; summary: string;
  outcome: string; input: unknown; movementId: string | null;
  subjectId: string | null; source: string;
}

/** What a source was, in words rather than in the word the header happened to carry. */
const SOURCE: Record<string, string> = {
  web: 'these screens',
  mcp: 'an agent, over MCP',
  assistant: 'the built-in assistant',
  api: 'the API',
};

function Body() {
  const { data } = useApp();
  const { live, version } = useLive();
  const [rows, setRows] = useState<Action[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!live) { setRows(null); return; }
    let off = false;
    setLoading(true);
    (ledger as any)['actions.list']({ limit: 500 })
      .then((r: Action[]) => { if (!off) setRows(r ?? []); })
      .catch(() => { if (!off) setRows([]); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [live, version]);

  /**
   * What the thing acted on is called.
   *
   * The log stores an id, because a name can change and an id cannot. A reader wants the
   * name it has now, and the id underneath it for anything the name no longer finds.
   */
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const n of data.nodes) names.set(n.id, n.name);
    for (const c of data.categories) names.set(c.id, c.name);
    for (const i of data.institutions) names.set(i.id, i.name);
    for (const s of data.incomeSources) names.set(s.id, s.name);
    return (id?: string | null) => (id ? names.get(id) ?? id : null);
  }, [data]);

  const refused = (rows ?? []).filter((r) => r.outcome !== 'ok').length;
  const written = (rows ?? []).filter((r) => r.movementId).length;

  return (
    <Page>
      <Sections sections={[
        { id: 'actions', label: 'What was done', icon: 'ledger',
          hint: 'Every write the ledger was asked for, newest first — including the ones it refused, and the ones that moved no money. It cannot be corrected, only emptied — and emptying it is itself an act the new log will say you did.' },
      ]} />

      {!live ? (
        <Panel>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
            The log comes from the ledger service, and there is none behind this screen yet.
          </p>
        </Panel>
      ) : (
        <>
          <Panel>
            <Stats>
              <Stat label="Acts recorded" value={String(rows?.length ?? 0)}
                    sub={loading ? 'reading…' : 'the most recent 500'} />
              <Stat label="Moved money" value={String(written)}
                    sub="wrote a movement you can open" />
              <Stat label="Moved nothing" value={String((rows?.length ?? 0) - written - refused)}
                    sub="a rename, an archive, a restated balance" color="var(--gold)" />
              <Stat label="Refused or failed" value={String(refused)}
                    sub="asked for, and not done" color={refused ? 'var(--negative)' : undefined} />
            </Stats>
          </Panel>

          <Panel title="The log"
                 hint="No row here can be corrected or removed on its own — it is the record of the corrections. The whole log can be emptied under Edit, and emptying it is itself an act, so the first line of the new log will say you did.">
            <RecordTable
              rows={rows ?? []}
              rowKey={(a) => a.id}
              sort={{ key: 'at', dir: 'desc' }}
              empty={{ icon: 'ledger', title: 'Nothing done yet',
                       body: 'Every write lands here the moment it is made — what it was, what it touched, and what came of it.' }}
              clear={{ log: 'actions',
                       what: 'every act recorded here, including the refusals',
                       onDone: () => setRows([]) }}
              columns={[
                { key: 'at', label: 'When', kind: 'date',
                  value: (a) => a.at,
                  cell: (a) => (
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {a.at.slice(0, 10)}
                      <span style={{ color: 'var(--faint)' }}> {a.at.slice(11, 19)}</span>
                    </span>
                  ) },

                { key: 'outcome', label: 'Outcome', kind: 'pick', width: '104px',
                  choices: ['ok', 'refused', 'failed'],
                  value: (a) => a.outcome,
                  cell: (a) => (
                    <Chip tone={a.outcome === 'ok' ? 'good' : a.outcome === 'refused' ? 'warn' : 'bad'}>
                      {a.outcome === 'ok' ? 'done' : a.outcome}
                    </Chip>
                  ) },

                { key: 'capability', label: 'What', kind: 'pick',
                  value: (a) => a.capability,
                  cell: (a) => (
                    <span className="mono" style={{ fontSize: 12 }}>{a.capability}</span>
                  ) },

                { key: 'subject', label: 'To what', kind: 'pick',
                  value: (a) => nameOf(a.subjectId) ?? '—',
                  cell: (a) => (a.subjectId
                    ? <span style={{ fontSize: 13 }}>{nameOf(a.subjectId)}</span>
                    : <span style={{ color: 'var(--faint)' }}>—</span>) },

                { key: 'summary', label: 'What came of it', kind: 'text',
                  value: (a) => a.summary,
                  cell: (a) => <span style={{ fontSize: 13, color: 'var(--muted)' }}>{a.summary}</span> },

                { key: 'source', label: 'From', kind: 'pick', width: '150px',
                  value: (a) => SOURCE[a.source] ?? a.source,
                  cell: (a) => (
                    <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                      {SOURCE[a.source] ?? a.source}
                    </span>
                  ) },

                { key: 'movement', label: 'Movement', kind: 'none', width: '112px',
                  value: (a) => a.movementId ?? '',
                  cell: (a) => (a.movementId
                    ? <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{a.movementId}</span>
                    : <span style={{ fontSize: 11, color: 'var(--faint)' }}>moved nothing</span>) },
              ]}
            />
          </Panel>
        </>
      )}
    </Page>
  );
}
