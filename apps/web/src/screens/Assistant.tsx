import { useCallback, useEffect, useRef, useState } from 'react';
import { Page, Panel, Field, Empty } from '../components/UI';
import { Select } from '../components/Select';
import { Icon } from '../components/Icon';
import { Ledg00rMascot } from '../components/Ledg00r';

/** What the assistant is doing between a question and an answer. */
type Mood = 'idle' | 'thinking' | 'searching' | 'talking' | 'pleased' | 'sorry';
import { SectionProvider, Sections, useSection } from '../components/Sections';
import { ModeProvider } from '../components/ModeBar';
import { useLive } from '../Live';
import { ledger } from '../api';

interface Said { role: 'user' | 'assistant'; text: string; used?: Array<{ tool: string; summary: string }> }

/**
 * Ledg00r.
 *
 * Two ways to put an assistant on this ledger, and they are different enough to be separate
 * sections rather than two buttons. Either one runs here — you give it a provider key and it
 * calls the same capabilities the screens call — or you hand the ledger to an assistant you
 * already have, as an MCP server it connects to.
 *
 * The mascot marks what Ledg00r says, and nothing else. What is happening between asking
 * and answering is said in words, under his picture, because a word can say "looking it up
 * in your ledger" and a moving drawing cannot.
 */
export function Assistant() {
  return (
    <ModeProvider>
      <SectionProvider first="talk"><Body /></SectionProvider>
    </ModeProvider>
  );
}

function Body() {
  const { tab } = useSection();
  return (
    <Page>
      <Sections sections={[
        { id: 'talk', label: 'Talk to Ledg00r', art: <Ledg00rMascot size={15} alt="" />,
          hint: 'Ask about your own figures. He reads this ledger rather than guessing.' },
        { id: 'connect', label: 'Use your own assistant', icon: 'plug',
          hint: 'Hand this ledger to something you already run, over MCP.' },
        { id: 'provider', label: 'Provider', icon: 'settings',
          hint: 'Which model answers, and the key it needs.' },
      ]} />
      {tab === 'talk' && <Talk />}
      {tab === 'connect' && <Connect />}
      {tab === 'provider' && <Provider />}
    </Page>
  );
}

/** The conversation. */
function Talk() {
  const { live } = useLive();
  const [said, setSaid] = useState<Said[]>([]);
  const [question, setQuestion] = useState('');
  const [mood, setMood] = useState<Mood>('idle');
  const [doing, setDoing] = useState<string | null>(null);
  const [ready, setReady] = useState<{ hasKey: boolean; provider: string } | null>(null);
  const foot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    (ledger as any)['assistant.status']({})
      .then((s: any) => setReady({ hasKey: s.hasKey || s.provider === 'local', provider: s.provider }))
      .catch(() => setReady(null));
  }, [live]);

  useEffect(() => { foot.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [said, mood]);

  const ask = useCallback(async (text: string) => {
    if (!text.trim()) return;
    const history = said.map((s) => ({ role: s.role, text: s.text }));
    setSaid((s) => [...s, { role: 'user', text }]);
    setQuestion('');
    setMood('thinking');
    setDoing('Reading the question');

    // He looks like he is searching partway through, because by then he usually is.
    const toSearching = setTimeout(() => { setMood('searching'); setDoing('Looking it up in your ledger'); }, 1400);

    try {
      const res = await fetch('/api/assistant.ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text, history }),
      }).then((r) => r.json());

      clearTimeout(toSearching);
      if (res.error) {
        setMood('sorry');
        setDoing(null);
        setSaid((s) => [...s, { role: 'assistant', text: res.error }]);
        return;
      }
      setMood('talking');
      setDoing(null);
      setSaid((s) => [...s, { role: 'assistant', text: res.answer, used: res.used }]);
      setTimeout(() => setMood('pleased'), Math.min(4000, res.answer.length * 22));
      setTimeout(() => setMood('idle'), Math.min(4000, res.answer.length * 22) + 1400);
    } catch (e) {
      clearTimeout(toSearching);
      setMood('sorry');
      setDoing(null);
      setSaid((s) => [...s, { role: 'assistant', text: (e as Error).message }]);
    }
  }, [said]);

  const suggestions = [
    'What am I worth right now?',
    'Where did my money go last month?',
    'What is due in the next two weeks?',
    'How much zakat do I owe, and on what?',
  ];

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column', minHeight: 460 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14,
                    maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
        {said.length === 0 && (
          <div style={{ padding: '8px 0 4px' }}>
            <Ledg00rMascot size={40} alt="Ledg00r" />
            <p style={{ margin: '14px 0 16px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
              Ask about your own figures. He has the same tools the screens do, so he reads
              what is actually recorded — and he will tell you before he changes anything.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {suggestions.map((q) => (
                <button key={q} className="btn ghost" onClick={() => ask(q)}
                        style={{ fontSize: 12, padding: '8px 13px' }}>{q}</button>
              ))}
            </div>
          </div>
        )}

        {said.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6,
                                alignItems: s.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {s.role === 'assistant' && <Ledg00rMascot size={28} alt="Ledg00r" />}
            <div style={{
              maxWidth: '82%', padding: '11px 14px', borderRadius: 'var(--r-card)',
              fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              background: s.role === 'user' ? 'var(--accent)' : 'var(--raised)',
              color: s.role === 'user' ? 'var(--accent-ink)' : 'var(--ink)',
              border: s.role === 'user' ? 'none' : '1px solid var(--hairline)',
            }}>{s.text}</div>

            {/* What he actually looked at. A figure with no provenance is a guess. */}
            {s.used && s.used.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '82%' }}>
                {s.used.map((u, j) => (
                  <span key={j} className="chip" title={u.summary}
                        style={{ fontSize: 10, background: 'var(--raised)', color: 'var(--faint)' }}>
                    <Icon name="check" size={10} motion="none" /> {u.tool}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {doing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12,
                        color: 'var(--faint)' }}>
            <Ledg00rMascot size={20} alt="Ledg00r" />
            {doing}…
          </div>
        )}
        <div ref={foot} />
      </div>

      <form style={{ display: 'flex', gap: 10, marginTop: 18, paddingTop: 16,
                     borderTop: '1px solid var(--hairline)' }}
            onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)}
               aria-label="Ask Ledg00r" placeholder="Ask about your money…"
               disabled={mood === 'thinking' || mood === 'searching'}
               style={{ flex: 1, fontSize: 14, padding: '11px 13px' }} />
        <button className="btn" type="submit"
                disabled={!question.trim() || mood === 'thinking' || mood === 'searching'}
                style={{ padding: '11px 18px' }}>
          <Icon name="send" size={15} /> Ask
        </button>
      </form>

      {ready && !ready.hasKey && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--gold)', lineHeight: 1.5 }}>
          He has no key yet, so he cannot answer. Give him one under Provider — or hand the
          ledger to an assistant you already run, under “Use your own assistant”.
        </p>
      )}
    </Panel>
  );
}

/** Handing the ledger to an assistant that already exists. */
function Connect() {
  const { version } = useLive();
  const [keys, setKeys] = useState<any>(null);
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window === 'undefined' ? 'http://localhost:8080' : window.location.origin;

  const load = useCallback(() => {
    (ledger as any)['access.status']({}).then(setKeys).catch(() => setKeys(null));
  }, []);
  useEffect(load, [load, version]);

  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 2000); }
    catch { /* a browser that will not */ }
  };

  const stdio = `claude mcp add ledg00r -- npx tsx /path/to/ledger/apps/mcp/src/stdio.ts`;
  const http = issued
    ? `${origin}/mcp\nAuthorization: Bearer ${issued.key}`
    : `${origin}/mcp`;

  return (
    <>
      <Panel title="Over MCP"
             hint="Everything the screens can do is a tool, so an assistant you already run can read this ledger and act on it — with the same rules, and the same refusals.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Step n={1} title="On this machine"
                body="If the assistant runs where the ledger does, it can talk to it over a pipe and needs no key at all.">
            <Copyable text={stdio} copied={copied === 'stdio'} onCopy={() => copy('stdio', stdio)} />
          </Step>

          <Step n={2} title="From anywhere else"
                body="Point it at the HTTP transport. A key is only needed if you have turned the requirement on under Settings → Access.">
            <Copyable text={http} copied={copied === 'http'} onCopy={() => copy('http', http)} />
          </Step>

          <Step n={3} title="A key, if it needs one"
                body="One per assistant, so it can be taken away later without guessing which was which.">
            {issued ? (
              <div style={{ padding: '13px 15px', borderRadius: 'var(--r-card)',
                            background: 'color-mix(in srgb, var(--positive) 8%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--positive) 30%, transparent)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                  Copy it now — only a hash is stored, so it cannot be shown again.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="mono" readOnly value={issued.key} aria-label="The new key"
                         onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, fontSize: 12 }} />
                  <button className="btn" onClick={() => copy('key', issued.key)}>
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn add" onClick={async () => {
                const res: any = await (ledger as any)['access.issueKey']({ label: 'An assistant over MCP' })
                  .catch(() => null);
                if (res?.key) { setIssued({ key: res.key, label: res.label }); load(); }
              }}><Icon name="plus" size={14} /> Issue a key for an assistant</button>
            )}
          </Step>

          {/* The manual, not a setting. An assistant with the tools but not the house rules
              will happily invent an account name or record something without asking — which
              is the difference between a ledger and a plausible story about one. */}
          <Step n={4} title="Give it the manual"
                body="Everything it should know before touching this ledger: what to call, what to show before writing, and the rules the zakat figures follow. An assistant over MCP is handed it automatically as ledger://skill. For anything else, take the file and drop it in its skills folder.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <a className="btn" href="/skill.md" download="SKILL.md"
                 style={{ textDecoration: 'none' }}>
                <Icon name="download" size={14} /> Download SKILL.md
              </a>
              <span style={{ fontSize: 12, color: 'var(--faint)' }}>
                for Claude Code, <span className="mono">.claude/skills/ledg00r/SKILL.md</span>
              </span>
            </div>
          </Step>
        </div>
      </Panel>

      <Panel title="What it can do"
             hint="The same capabilities the screens call — nothing more, and nothing less.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {[
            ['Read where things stand', 'Net worth, accounts, what is coming, zakat.'],
            ['Search every log at once', 'Expenses, giving, income, orders and movement notes.'],
            ['Record what happened', 'Movements, spending, giving — each returning what it changed.'],
            ['Ask before it acts', 'Every write takes a dry run, so an effect can be shown first.'],
          ].map(([t, b]) => (
            <div key={t} style={{ padding: '14px 16px', borderRadius: 'var(--r-card)',
                                  background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.5 }}>{b}</div>
            </div>
          ))}
        </div>
        {keys && (
          <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--faint)' }}>
            {keys.enabled
              ? `A key is required. ${keys.keys.filter((k: any) => !k.revoked).length} live.`
              : 'No key is required at the moment — anything that can reach this port can connect.'}
          </p>
        )}
      </Panel>
    </>
  );
}

/** Which model answers, and the key it needs. */
function Provider() {
  const { run, version } = useLive();
  const [status, setStatus] = useState<any>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');

  const load = useCallback(() => {
    (ledger as any)['assistant.status']({}).then((s: any) => {
      setStatus(s); setModel(s.model);
    }).catch(() => setStatus(null));
  }, []);
  useEffect(load, [load, version]);

  if (!status) {
    return <Panel title="Provider"><p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
      There is no ledger service behind this screen yet.</p></Panel>;
  }

  const chosen = status.providers.find((p: any) => p.id === status.provider);

  return (
    <Panel title="Provider"
           hint="Which model Ledg00r talks through. The key is written and never read back — this screen can only ever show its last four characters.">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22 }}>
        {status.providers.map((p: any) => {
          const on = p.id === status.provider;
          return (
            <button key={p.id} onClick={() => run('assistant.configure', { provider: p.id }).then(load)}
              style={{
                flex: '1 1 170px', textAlign: 'left', padding: '14px 16px', cursor: 'pointer',
                borderRadius: 'var(--r-card)', color: 'var(--ink)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--hairline)'}`,
                background: on ? 'color-mix(in srgb, var(--accent) 8%, var(--surface))' : 'var(--surface)',
              }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>{p.model}</div>
              <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{p.docs}</div>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
        <Field label="Model" hint="whatever that provider calls the one you want">
          <input value={model} aria-label="Model" onChange={(e) => setModel(e.target.value)}
                 onBlur={() => model !== status.model && run('assistant.configure', { model }).then(load)} />
        </Field>

        <Field label={status.provider === 'local' ? 'Key, if yours needs one' : 'Key'}
               hint={status.hasKey ? `one ending ${status.keyTail} is stored` : chosen?.keyHint}>
          <input type="password" value={key} aria-label="Provider key"
                 placeholder={status.hasKey ? '••••••••' : chosen?.keyHint}
                 onChange={(e) => setKey(e.target.value)} />
        </Field>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button className="btn go" disabled={!key.trim()}
                  onClick={() => run('assistant.configure', { key: key.trim() })
                    .then(() => { setKey(''); load(); })}>
            <Icon name="check" size={14} motion="none" /> Save the key
          </button>
          {status.hasKey && (
            <button className="btn ghost"
                    onClick={() => run('assistant.configure', { key: '' }).then(load)}>
              Forget it
            </button>
          )}
        </div>
      </div>

      {status.provider === 'local' && (
        <p style={{ margin: '20px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.6 }}>
          A local server usually speaks the OpenAI shape on its own port — Ollama at
          <span className="mono"> :11434</span>, LM Studio at <span className="mono">:1234</span>.
          Nothing leaves your machine, which for a ledger is the point.
        </p>
      )}
    </Panel>
  );
}

function Step({ n, title, body, children }: {
  n: number; title: string; body: string; children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      <span style={{ width: 26, height: 26, borderRadius: 999, flex: '0 0 26px',
                     display: 'flex', alignItems: 'center', justifyContent: 'center',
                     fontSize: 12, fontWeight: 600,
                     background: 'var(--raised)', border: '1px solid var(--hairline)' }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '5px 0 11px', lineHeight: 1.55 }}>{body}</div>
        {children}
      </div>
    </div>
  );
}

function Copyable({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <pre className="mono" style={{ flex: 1, margin: 0, fontSize: 12, lineHeight: 1.6,
                                     padding: '11px 13px', borderRadius: 'var(--r-card)',
                                     background: 'var(--raised)', border: '1px solid var(--hairline)',
                                     overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</pre>
      <button className="btn ghost" onClick={onCopy} style={{ whiteSpace: 'nowrap' }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export { Empty, Select };
