import { useCallback, useEffect, useState } from 'react';
import { Panel, Toggle, Field, Chip } from './UI';
import { Icon } from './Icon';
import { ConfirmDelete } from './Confirm';
import { useLive } from '../Live';
import { ledger } from '../api';

/**
 * Who may call this ledger.
 *
 * Off by default and off in the box, because the first thing anyone does is open their own
 * ledger, and meeting a key prompt there is an obstacle rather than a protection. It matters
 * at the moment the ledger is handed to something else — an assistant, a script, another
 * machine — and that is what the keys are for.
 *
 * A key is shown once. Only its hash is stored, so this screen genuinely cannot show it
 * again, and saying so plainly is better than a "reveal" that quietly cannot work.
 */
interface KeyRow {
  id: string; label: string; prefix: string;
  createdAt: string; lastUsedAt: string | null; revoked: boolean;
}

export function AccessSettings() {
  const { run, version, live } = useLive();
  const [state, setState] = useState<{ enabled: boolean; trustLoopback: boolean; keys: KeyRow[] } | null>(null);
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!live) { setState(null); return; }
    (ledger as any)['access.status']({})
      .then(setState)
      .catch(() => setState(null));
  }, [live]);

  useEffect(load, [load, version]);

  const usable = state?.keys.filter((k) => !k.revoked) ?? [];

  if (!live) {
    return (
      <Panel title="Access" hint="Who may call this ledger.">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          There is no ledger service behind this screen, so there is nothing to protect yet.
          Start the API and this becomes live.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="Access"
             hint="Off, and anything that can reach this port can read and write. On, and every call needs a key you have issued — which is what you want the moment the ledger is reachable by anything but you.">
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14, padding: '15px 17px',
          borderRadius: 'var(--r-card)',
          background: state?.enabled
            ? 'color-mix(in srgb, var(--positive) 8%, transparent)'
            : 'color-mix(in srgb, var(--gold) 8%, transparent)',
          border: `1px solid color-mix(in srgb, var(--${state?.enabled ? 'positive' : 'gold'}) 28%, transparent)`,
        }}>
          <Icon name={state?.enabled ? 'check' : 'warn'} size={18}
                color={`var(--${state?.enabled ? 'positive' : 'gold'})`} motion="none" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {state?.enabled ? 'A key is required' : 'No key is required'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              {state?.enabled
                ? 'Calls must carry a key issued below. The screens on this machine are covered by the exception underneath.'
                : usable.length === 0
                  ? 'Issue a key first — turning this on with none would lock everything out, including these screens.'
                  : 'Turn this on and every call from outside this machine will need one of the keys below.'}
            </div>
          </div>
          <Toggle on={!!state?.enabled} label="Require a key"
                  onChange={async (on) => {
                    setProblem(null);
                    const res: any = await run('access.configure', { enabled: on });
                    if (res.ok === false) setProblem(res.message ?? 'That could not be changed.');
                    load();
                  }} />
        </div>

        {problem && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--negative)', lineHeight: 1.5 }}>{problem}</p>
        )}

        {state?.enabled && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14,
                          padding: '12px 15px', borderRadius: 'var(--r-card)',
                          background: 'var(--raised)', border: '1px solid var(--hairline)' }}>
            <Toggle on={state.trustLoopback} label="Trust this machine"
                    onChange={(on) => { void run('access.configure', { trustLoopback: on }); load(); }} />
            <span style={{ fontSize: 12, lineHeight: 1.45 }}>
              Skip the key for calls from this machine
              <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)' }}>
                Inside a container, a browser on your host is not this machine — it arrives over
                the bridge network. Turn this off only if something untrusted runs alongside the
                ledger itself.
              </span>
            </span>
          </label>
        )}
      </Panel>

      <Panel title="Keys"
             hint="One per thing that holds it, so a key can be revoked later without guessing which it was. An assistant driving this ledger over MCP wants one of these.">
        {issued && (
          <div style={{
            padding: '15px 17px', marginBottom: 16, borderRadius: 'var(--r-card)',
            background: 'color-mix(in srgb, var(--positive) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--positive) 30%, transparent)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              {issued.label} — copy this now
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
              Only a hash of it is stored, so this screen cannot show it again. Losing it means
              issuing another.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <input className="mono" readOnly value={issued.key} aria-label="The new key"
                     onFocus={(e) => e.currentTarget.select()}
                     style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
              <button className="btn" style={{ whiteSpace: 'nowrap' }}
                onClick={async () => {
                  try { await navigator.clipboard.writeText(issued.key); setCopied(true); }
                  catch { setCopied(false); }
                  setTimeout(() => setCopied(false), 2000);
                }}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn ghost" onClick={() => setIssued(null)}>Done</button>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                Using it
              </summary>
              <pre className="mono" style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.6,
                                             color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
{`curl -H 'authorization: Bearer ${issued.key}' \\
     -H 'content-type: application/json' \\
     -d '{}' http://localhost:8080/api/portfolio.overview

# and for an assistant over MCP, the same header against /mcp`}
              </pre>
            </details>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
          <Field label="What will hold this key">
            <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Key label"
                   placeholder="Claude on my laptop" style={{ minWidth: 240 }} />
          </Field>
          <button className="btn add" onClick={async () => {
            setProblem(null);
            const res: any = await (ledger as any)['access.issueKey']({ label: label.trim() || 'Untitled key' })
              .catch((e: Error) => ({ ok: false, message: e.message }));
            if (res?.key) { setIssued({ key: res.key, label: res.label }); setLabel(''); load(); }
            else setProblem(res?.message ?? 'That key was not issued.');
          }}>Issue a key</button>
        </div>

        {(state?.keys.length ?? 0) === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--faint)' }}>No keys yet.</p>
        ) : (
          <table>
            <thead><tr><th>Label</th><th>Key</th><th>Issued</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {state!.keys.map((k) => (
                <tr key={k.id} style={{ opacity: k.revoked ? 0.5 : 1 }}>
                  <td style={{ fontSize: 13 }}>{k.label}</td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>{k.prefix}…</td>
                  <td className="mono public" style={{ fontSize: 12 }}>{k.createdAt.slice(0, 10)}</td>
                  <td className="mono public" style={{ fontSize: 12, color: 'var(--faint)' }}>
                    {k.lastUsedAt ? k.lastUsedAt.slice(0, 10) : 'never'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {k.revoked
                      ? <Chip tone="bad">revoked</Chip>
                      : <ConfirmDelete what={k.label} size={14}
                          onConfirm={async () => { await run('access.revokeKey', { keyId: k.id }); load(); }} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="If you lock yourself out"
             style={{ borderColor: 'color-mix(in srgb, var(--gold) 30%, transparent)' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Turning this on and then losing every key would leave nothing able to reach the screen
          that turns it off again. The way back is from the machine the ledger runs on, which
          needs access to it anyway:
        </p>
        <pre className="mono" style={{ margin: '12px 0 0', fontSize: 12, padding: '11px 13px',
                                       borderRadius: 'var(--r-card)', background: 'var(--raised)',
                                       border: '1px solid var(--hairline)', overflowX: 'auto' }}>
LEDGER_DISABLE_AUTH=1
        </pre>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--faint)', lineHeight: 1.55 }}>
          Set on the server — or added to the container and restarted — every check is skipped
          and this screen becomes reachable again. Revoking the last key does the same thing
          automatically, rather than leaving the ledger unreachable.
        </p>
      </Panel>
    </>
  );
}
