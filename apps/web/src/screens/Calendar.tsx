import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppState';
import { ledger } from '../api';
import { useLive } from '../Live';
import { Page, Panel, Chip, Empty, Field } from '../components/UI';
import { Icon, hasIcon, type IconName } from '../components/Icon';
import { Select } from '../components/Select';
import { DateField } from '../components/DateField';
import { Amount } from '../components/Amount';
import { ConfirmDelete } from '../components/Confirm';
import { ClearAll } from '../components/ClearAll';
import { useViewport } from '../components/Shell';
import { isInteractive } from '../components/RecordTable';

/**
 * The calendar.
 *
 * Everything this ledger knows the date of, drawn as a month: installments due and paid, the
 * day each lunar year closes, zakat, the warnings that run ahead of them, standing charges,
 * income expected. The events come from the ledger rather than from this screen, so the same
 * list is what a phone gets when it subscribes to the feed.
 *
 * Each cell carries both calendars. Zakat is reckoned in the lunar year and everything else
 * is not, and a month that only prints one of them makes the other a conversion nobody wants
 * to do in their head.
 */

interface Event {
  id: string; date: string; hijri: string | null; kind: string; title: string;
  detail?: string; amount?: number; currency?: string; color: string;
  daysAway: number; overdue?: boolean;
  /** the mark it wears: the thing's own where it has one, its kind's otherwise */
  icon: string; past?: boolean;
  /** set when this came from an entry the owner wrote, which can therefore be changed */
  entryId?: string; done?: boolean;
}

/** A mark this set cannot draw is drawn as the kind's, not as whatever is nearest. */
const markOf = (e: { icon?: string; kind: string }): IconName =>
  (hasIcon(e.icon) ? e.icon : hasIcon(e.kind) ? e.kind : 'calendar') as IconName;

interface Entry {
  id: string; date: string; hijri: string | null; title: string; note: string | null;
  color: string | null; repeat: string; remindDays: number;
  amount: number | null; currency: string | null; doneAt: string | null;
}

const REPEATS = [
  { value: 'none', label: 'Once', hint: 'the day itself, and no other' },
  { value: 'monthly', label: 'Every month', hint: 'same day each month' },
  { value: 'annually', label: 'Every year', hint: 'same date each year' },
  { value: 'lunar_annually', label: 'Every lunar year',
    hint: 'keeps step with the Hijri calendar, so it drifts eleven days earlier' },
];

const ENTRY_COLORS = ['#5E8B7E', '#B37E00', '#C2603E', '#6B7BA8', '#B0578D', '#3F7D4F'];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Monday-first, and always six rows, so paging months never resizes the grid. */
function grid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function Calendar() {
  const { now, dm } = useApp();
  const { live, version, run, running } = useLive();
  /**
   * A month grid needs seven columns, and seven columns of anything readable need about six
   * hundred pixels. Below that the same events are shown as the days they fall on, in order —
   * which is what a calendar on a phone is anyway.
   */
  const { width } = useViewport();
  const asList = width < 640;
  const [events, setEvents] = useState<Event[] | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  /**
   * The entry being written or corrected.
   *
   * One draft rather than one per row: only one entry is ever being edited, and keeping a
   * draft per row is how a half-typed title ends up saved against the wrong day.
   */
  const [draft, setDraft] = useState<(Partial<Entry> & { id?: string }) | null>(null);
  const [legend, setLegend] = useState<Array<{
    kind: string; label: string; color: string; icon: string; count: number }>>([]);
  const [feedUrl, setFeedUrl] = useState('/calendar.ics');
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!live) { setEvents(null); setEntries(null); return; }
    (ledger as any)['calendar.events']({ withinDays: 800, backDays: 400 })
      .then((a: any) => {
        setEvents(a?.events ?? []);
        setLegend(a?.legend ?? []);
        setFeedUrl(a?.feedUrl ?? '/calendar.ics');
      })
      .catch(() => setEvents(null));
    (ledger as any)['calendar.entries']({})
      .then((rows: Entry[]) => setEntries(rows))
      .catch(() => setEntries(null));
  }, [live]);
  useEffect(load, [load, version]);

  const shown = useMemo(
    () => (events ?? []).filter((e) => !hidden[e.kind]),
    [events, hidden]);

  const byDay = useMemo(() => {
    const map: Record<string, Event[]> = {};
    for (const e of shown) (map[e.date] ??= []).push(e);
    return map;
  }, [shown]);

  const days = grid(cursor.getFullYear(), cursor.getMonth());
  const today = iso(now);
  // The lunar reading lives in Zakat and Sadaqat, where the year it measures is lunar. A
  // second calendar under every day here was a date nobody was reading.
  const ahead = shown
    .filter((e) => e.daysAway >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 12);

  const subscribeUrl = `${window.location.origin}${feedUrl}`;
  const webcal = subscribeUrl.replace(/^https?:/, 'webcal:');

  const blank = (date: string): Partial<Entry> => ({
    date, title: '', note: '', color: ENTRY_COLORS[0]!, repeat: 'none', remindDays: 0,
  });
  const entryOf = (id: string | undefined) => entries?.find((x) => x.id === id);
  const startEdit = (id: string) => {
    const found = entryOf(id);
    if (found) { setDraft({ ...found }); setPicked(found.date); }
  };
  const save = () => {
    if (!draft?.title || !draft.date) return;
    const body = {
      date: draft.date, title: draft.title, note: draft.note || undefined,
      color: draft.color || undefined, repeat: draft.repeat || 'none',
      remindDays: Number(draft.remindDays ?? 0),
      amount: draft.amount == null || draft.amount === 0 ? undefined : Number(draft.amount),
    };
    const call = draft.id
      ? run('calendar.update', { entryId: draft.id, ...body, note: draft.note ?? null })
      : run('calendar.add', body);
    void call.then((o) => { if (o.ok) { setDraft(null); load(); } });
  };

  return (
    <Page aside={(
      <Panel title="Put it in your own calendar"
             hint="One feed, refreshed on its own. Subscribing keeps it live — a payment moved here moves there, rather than leaving a copy behind that quietly goes stale.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <a className="btn" href={webcal} style={{ textDecoration: 'none', justifyContent: 'center' }}>
            <Icon name="calendar" size={15} color="var(--accent-ink)" />
            Subscribe in your calendar
          </a>
          <a className="btn ghost" href={feedUrl} download="ledg00r.ics"
             style={{ textDecoration: 'none', justifyContent: 'center' }}>
            <Icon name="download" size={15} />
            Download the file instead
          </a>
          <div style={{ fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
            The address is <span className="mono public" style={{ wordBreak: 'break-all' }}>{subscribeUrl}</span>.
            If this ledger asks for a key, add <span className="mono public">?key=…</span> to it — a calendar
            application cannot send a header for you.
          </div>
          <div style={{ height: 1, background: 'var(--hairline)' }} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="ov">What is on it</span>
            {Object.values(hidden).some(Boolean) && (
              <button className="btn quiet" style={{ marginLeft: 'auto', padding: '3px 8px', fontSize: 11 }}
                      onClick={() => setHidden({})}>show all</button>
            )}
          </div>
          {/* Each kind is a switch that says what it holds. A kind with nothing in the window
              is shown as empty rather than as a control that appears to do nothing, and the
              row itself toggles — a bare checkbox was the one native control left in the app. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {legend.map((l) => {
              const off = !!hidden[l.kind];
              const empty = l.count === 0;
              return (
                <div key={l.kind} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={() => setHidden({ ...hidden, [l.kind]: !off })}
                    aria-pressed={!off} aria-label={`${l.label}, ${l.count} on the calendar`}
                    disabled={empty}
                    style={{
                      flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9,
                      padding: '5px 8px', borderRadius: 'var(--r-sm)', border: '1px solid transparent',
                      cursor: empty ? 'default' : 'pointer', textAlign: 'left',
                      background: off || empty ? 'transparent'
                        : `color-mix(in srgb, ${l.color} 12%, transparent)`,
                      borderColor: off || empty ? 'var(--hairline)'
                        : `color-mix(in srgb, ${l.color} 34%, transparent)`,
                      opacity: empty ? 0.45 : 1,
                    }}>
                    <Icon name={markOf(l)} size={14} color={off || empty ? 'var(--faint)' : l.color} />
                    <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                   color: off || empty ? 'var(--faint)' : 'var(--ink)' }}>{l.label}</span>
                    <span className="mono public" style={{ fontSize: 11, color: 'var(--faint)' }}>{l.count}</span>
                  </button>
                  {!empty && (
                    <button className="btn quiet" style={{ padding: '4px 7px', fontSize: 10 }}
                            aria-label={`Show only ${l.label}`}
                            onClick={() => setHidden(Object.fromEntries(
                              legend.filter((x) => x.kind !== l.kind).map((x) => [x.kind, true])))}>
                      only
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    )}>
      <Panel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <button className="btn quiet" aria-label="Previous month" style={{ padding: 7 }}
                  onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <Icon name="chevron" size={15} motion="none" />
          </button>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
            </div>
          </div>
          <button className="btn quiet" aria-label="Next month" style={{ padding: 7 }}
                  onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <Icon name="chevron" size={15} motion="none" style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button className="btn ghost" style={{ marginLeft: 'auto' }}
                  onClick={() => setCursor(new Date(now.getFullYear(), now.getMonth(), 1))}>
            This month
          </button>
        </div>

        {!live && (
          <Empty icon="calendar" title="The ledger is not running"
                 body="The calendar is assembled by the ledger service, so that the feed a phone subscribes to and the month drawn here are the same events." />
        )}

        {live && asList && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(() => {
              const inMonth = shown
                .filter((e) => {
                  const d = new Date(`${e.date}T12:00:00`);
                  return d.getMonth() === cursor.getMonth() && d.getFullYear() === cursor.getFullYear();
                })
                .sort((a, b) => a.date.localeCompare(b.date));
              if (!inMonth.length) {
                return <Empty icon="calendar" title="Nothing this month"
                              body="Page back or forward, or put something of your own on a day." />;
              }
              const days = [...new Set(inMonth.map((e) => e.date))];
              return days.map((day) => (
                <div key={day}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '4px 0 6px' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {new Date(`${day}T12:00:00`).toLocaleDateString('en-GB',
                        { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                    <button className="btn quiet" style={{ marginLeft: 'auto', padding: '4px 8px', fontSize: 11 }}
                            onClick={() => { setPicked(day); setDraft(blank(day)); }}>
                      <Icon name="plus" size={12} /> add
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {inMonth.filter((e) => e.date === day).map((e) => (
                      <EventRow key={e.id} e={e} dm={dm}
                        onEdit={e.entryId ? () => startEdit(e.entryId!) : undefined}
                        onDone={e.entryId ? (v) => void run('calendar.update', { entryId: e.entryId, done: v }).then(load) : undefined}
                        onRemove={e.entryId ? () => void run('calendar.remove', { entryId: e.entryId }).then(load) : undefined} />
                    ))}
                  </div>
                </div>
              ));
            })()}
            {draft && (
              <EntryForm draft={draft} setDraft={setDraft} onSave={save}
                         onCancel={() => setDraft(null)} saving={!!running} />
            )}
          </div>
        )}

        {live && !asList && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
              {DOW.map((d) => (
                <span key={d} className="ov" style={{ textAlign: 'center', padding: '2px 0' }}>{d}</span>
              ))}
              {days.map((d) => {
                const key = iso(d);
                const here = byDay[key] ?? [];
                const outside = d.getMonth() !== cursor.getMonth();
                const isToday = key === today;
                return (
                  <button key={key} onClick={() => setPicked(picked === key ? null : key)}
                    aria-label={`${key} — ${here.length} event${here.length === 1 ? '' : 's'}`}
                    style={{
                      minHeight: 86, textAlign: 'left', padding: '7px 8px', cursor: 'pointer',
                      borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 4,
                      background: picked === key ? 'color-mix(in srgb, var(--zakat) 12%, transparent)'
                                : isToday ? 'var(--raised)' : 'var(--surface)',
                      border: `1px solid ${isToday ? 'color-mix(in srgb, var(--zakat) 45%, transparent)' : 'var(--hairline)'}`,
                      opacity: outside ? 0.45 : 1,
                    }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 }}>
                      <span className="mono public" style={{ fontSize: 13, fontWeight: isToday ? 700 : 500 }}>
                        {d.getDate()}
                      </span>
                    </span>
                    {here.slice(0, 3).map((e) => (
                      <span key={e.id} style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        fontSize: 10, lineHeight: 1.3, borderRadius: 4, padding: '2px 4px',
                        background: `color-mix(in srgb, ${e.color} 18%, transparent)`,
                        color: e.color, overflow: 'hidden',
                        opacity: e.done ? 0.55 : 1,
                      }}>
                        <Icon name={markOf(e)} size={11} color={e.color} motion="none" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.title}
                        </span>
                      </span>
                    ))}
                    {here.length > 3 && (
                      <span style={{ fontSize: 9, color: 'var(--faint)' }}>and {here.length - 3} more</span>
                    )}
                  </button>
                );
              })}
            </div>

            {picked && (
              <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 'var(--r-card)',
                            background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {new Date(`${picked}T12:00:00`).toLocaleDateString('en-GB',
                      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </span>
                </div>
                {(byDay[picked] ?? []).length === 0
                  ? <div style={{ fontSize: 12, color: 'var(--faint)' }}>Nothing on this day.</div>
                  : (byDay[picked] ?? []).map((e) => (
                      <EventRow key={e.id} e={e} dm={dm}
                        onEdit={e.entryId ? () => startEdit(e.entryId!) : undefined}
                        onDone={e.entryId ? (v) => void run('calendar.update',
                          { entryId: e.entryId, done: v }).then(load) : undefined}
                        onRemove={e.entryId ? () => void run('calendar.remove',
                          { entryId: e.entryId }).then(load) : undefined} />
                    ))}

                {draft && draft.date === picked ? (
                  <EntryForm draft={draft} setDraft={setDraft} onSave={save}
                             onCancel={() => setDraft(null)} saving={!!running} />
                ) : (
                  <button className="btn ghost" style={{ marginTop: 12 }}
                          onClick={() => setDraft(blank(picked))}>
                    <Icon name="plus" size={14} />
                    Put something of your own on this day
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </Panel>

      {live && (
        <Panel title="Your own entries"
               hint="Everything else on this calendar is here because the ledger worked it out. These are the ones you put there — a viewing, a signing, anything worth remembering — and they go into the feed with the rest."
               action={(
                 <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                   <ClearAll log="calendar" count={entries?.length ?? 0}
                             what="the entries you put on the calendar yourself"
                             onDone={load} />
                   <button className="btn add" onClick={() => { setPicked(picked ?? today); setDraft(blank(picked ?? today)); }}>
                     <Icon name="plus" size={14} />
                     Add an entry
                   </button>
                 </span>
               )}>
          {draft && !picked && (
            <EntryForm draft={draft} setDraft={setDraft} onSave={save}
                       onCancel={() => setDraft(null)} saving={!!running} />
          )}
          {(entries ?? []).length === 0 ? (
            <Empty icon="calendar" title="Nothing of your own yet"
                   body="A meeting about one of these flats, the day a contract is signed, a price to look at again — anything the ledger could not know on its own." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(entries ?? []).map((x) => (
                <div key={x.id} className="mgr-row" style={{
                  display: 'grid', gap: 12, alignItems: 'center',
                  gridTemplateColumns: '150px 26px minmax(0,1fr) 150px 96px',
                  padding: '10px 12px', borderRadius: 8, background: 'var(--surface)',
                  border: '1px solid var(--hairline)', opacity: x.doneAt ? 0.55 : 1,
                }}
                  tabIndex={0} aria-label={`Double-click, or press Enter, to edit ${x.title}`}
                  onDoubleClick={(e) => { if (!isInteractive(e.target)) startEdit(x.id); }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || isInteractive(e.target)) return;
                    e.preventDefault();
                    startEdit(x.id);
                  }}>
                  <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                    <span className="mono public" style={{ fontSize: 12 }}>
                      {new Date(`${x.date}T12:00:00`).toLocaleDateString('en-GB',
                        { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  </span>
                  <span className="ev-bar" style={{
                    width: 26, height: 26, borderRadius: 8, flex: '0 0 26px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `color-mix(in srgb, ${x.color ?? '#5E8B7E'} 16%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${x.color ?? '#5E8B7E'} 30%, transparent)`,
                  }}>
                    <Icon name="calendar" size={14} color={x.color ?? '#5E8B7E'} motion="none" />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500,
                                  textDecoration: x.doneAt ? 'line-through' : 'none' }}>{x.title}</div>
                    {x.note && <div style={{ fontSize: 11, color: 'var(--faint)' }}>{x.note}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Chip>{REPEATS.find((r) => r.value === x.repeat)?.label ?? 'Once'}</Chip>
                    {x.remindDays > 0 && <Chip tone="info">{x.remindDays}d before</Chip>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn quiet rt-hint" aria-label={`Edit ${x.title}`} style={{ padding: 6 }}
                            onClick={() => startEdit(x.id)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button className="btn quiet" aria-label={`Mark ${x.title} done`} style={{ padding: 6 }}
                            onClick={() => void run('calendar.update',
                              { entryId: x.id, done: !x.doneAt }).then(load)}>
                      <Icon name="check" size={14} color={x.doneAt ? 'var(--positive)' : undefined} />
                    </button>
                    <ConfirmDelete what={x.title} className="rt-hint"
                                   onConfirm={() => void run('calendar.remove', { entryId: x.id }).then(load)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {live && (
        <Panel title="Next on the calendar"
               hint="The same events, soonest first — the ones a month grid is too small to say much about.">
          {ahead.length === 0
            ? <Empty icon="clock" title="Nothing ahead" body="No payment, warning or lunar year falls inside the horizon." />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ahead.map((e) => <EventRow key={e.id} e={e} dm={dm} showDate />)}
              </div>}
        </Panel>
      )}
    </Page>
  );
}

function EventRow({ e, dm, showDate, onEdit, onDone, onRemove }: {
  e: Event; dm: (n: number) => string; showDate?: boolean;
  /** only an entry the owner wrote can be changed from here */
  onEdit?: () => void; onDone?: (v: boolean) => void; onRemove?: () => void;
}) {
  return (
    <div className={onEdit ? 'mgr-row' : undefined} style={{
      display: 'grid',
      gridTemplateColumns: `${showDate ? '150px ' : ''}28px minmax(0,1fr) 130px${onEdit ? ' 104px' : ''}`,
      gap: 12, alignItems: 'center', padding: '9px 10px', borderRadius: 8,
      background: 'var(--surface)', border: '1px solid var(--hairline)',
      cursor: onEdit ? 'pointer' : undefined,
    }}
      tabIndex={onEdit ? 0 : undefined}
      aria-label={onEdit ? `Double-click, or press Enter, to edit ${e.title}` : undefined}
      onDoubleClick={onEdit ? (ev) => { if (!isInteractive(ev.target)) onEdit(); } : undefined}
      onKeyDown={onEdit ? (ev) => {
        if (ev.key !== 'Enter' || isInteractive(ev.target)) return;
        ev.preventDefault();
        onEdit();
      } : undefined}>
      {showDate && (
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
          <span className="mono public" style={{ fontSize: 12 }}>
            {new Date(`${e.date}T12:00:00`).toLocaleDateString('en-GB',
              { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        </span>
      )}
      <span className="ev-bar" style={{
        width: 28, height: 28, borderRadius: 8, flex: '0 0 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${e.color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${e.color} 30%, transparent)`,
      }}>
        <Icon name={markOf(e)} size={15} color={e.color} motion="none" />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{e.title}</div>
        {e.detail && (
          <div style={{ fontSize: 11, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.detail}
          </div>
        )}
      </div>
      <span>
        {e.amount != null && (
          <span className="mono" style={{ fontSize: 13 }}>{dm(e.amount)}</span>
        )}
        <span style={{ display: 'block' }}>
          {/* a day already gone reads as gone, whether or not anything is waiting on it */}
          {e.done
            ? <Chip tone="good">done</Chip>
            : e.daysAway < 0
              ? <Chip tone={e.overdue ? 'bad' : 'neutral'}>{-e.daysAway}d ago</Chip>
              : <Chip>{e.daysAway === 0 ? 'today' : `${e.daysAway}d`}</Chip>}
        </span>
      </span>
      {onEdit && (
        <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button className="btn quiet rt-hint" aria-label={`Edit ${e.title}`} style={{ padding: 6 }}
                  onClick={onEdit}>
            <Icon name="edit" size={14} />
          </button>
          {onDone && (
            <button className="btn quiet" aria-label={`Mark ${e.title} done`} style={{ padding: 6 }}
                    onClick={() => onDone(!e.done)}>
              <Icon name="check" size={14} color={e.done ? 'var(--positive)' : undefined} />
            </button>
          )}
          {onRemove && <ConfirmDelete what={e.title} className="rt-hint" onConfirm={onRemove} />}
        </span>
      )}
    </div>
  );
}

/**
 * Writing one down.
 *
 * The fields are the ones an entry actually needs and no more: when, what, whether it comes
 * round again, and how much warning you want. The lunar repeat is offered beside the ordinary
 * ones because this calendar carries both years, and an anniversary reckoned in the lunar one
 * cannot be expressed as "every year".
 */
function EntryForm({ draft, setDraft, onSave, onCancel, saving }: {
  draft: Partial<Entry> & { id?: string };
  setDraft: (d: (Partial<Entry> & { id?: string }) | null) => void;
  onSave: () => void; onCancel: () => void; saving: boolean;
}) {
  const set = (patch: Partial<Entry>) => setDraft({ ...draft, ...patch });
  return (
    <div style={{
      marginTop: 14, padding: '16px 18px', borderRadius: 'var(--r-card)',
      background: 'var(--surface)', border: '1px solid var(--hairline-strong)',
    }}>
      <div style={{ display: 'grid', gap: 16,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Field label="Day">
          <DateField value={draft.date ?? ''} ariaLabel="Entry date"
                     onChange={(v) => set({ date: v })} />
        </Field>
        <Field label="What it is">
          <input aria-label="Entry title" placeholder="Sign the contract"
                 value={draft.title ?? ''} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Note" hint="anything you will want to read back">
          <input aria-label="Entry note" placeholder="bring the ID"
                 value={draft.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        <Field label="Comes round"
               hint={REPEATS.find((r) => r.value === (draft.repeat ?? 'none'))?.hint}>
          <Select ariaLabel="How it repeats" value={draft.repeat ?? 'none'}
                  onChange={(v) => set({ repeat: v })} options={REPEATS} />
        </Field>
        <Field label="Warn me" hint="days before, or none at all">
          <Amount value={Number(draft.remindDays ?? 0)} ariaLabel="Days of warning" min={0}
                  onChange={(n) => set({ remindDays: n })} />
        </Field>
        <Field label="Colour" hint="how it reads in the month">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ENTRY_COLORS.map((c) => (
              <button key={c} aria-label={`Colour ${c}`} aria-pressed={draft.color === c}
                      onClick={() => set({ color: c })}
                      style={{
                        width: 26, height: 26, borderRadius: 7, cursor: 'pointer', background: c,
                        border: draft.color === c ? '2px solid var(--ink)' : '1px solid var(--hairline)',
                      }} />
            ))}
          </div>
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onCancel}>
          <Icon name="close" size={14} motion="none" /> Cancel
        </button>
        <button className={draft.id ? 'btn go' : 'btn add'} onClick={onSave}
                disabled={saving || !draft.title || !draft.date}>
          <Icon name={draft.id ? 'check' : 'plus'} size={14} motion="none" />
          {draft.id ? 'Save the change' : 'Put it on the calendar'}
        </button>
      </div>
    </div>
  );
}
