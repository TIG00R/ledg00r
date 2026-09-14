import { useRef, useState } from 'react';
import { Icon, ICON_FAMILY, hasIcon, type IconName } from './Icon';
import { Dismissable } from './Confirm';
import { useLive } from '../Live';

/**
 * A mark: an icon from the set, or a picture of your own.
 *
 * Most things are better served by an icon — one weight, one grid, legible at seventeen
 * pixels. Some are not: a bank has a logo, and offering the nearest abstract shape instead is
 * offering a worse answer. So a mark is a string that is either an icon name or `img:<id>`,
 * and everything that draws one handles both.
 */
export type MarkRef = string;

export const isPicture = (mark?: string): boolean => !!mark?.startsWith('img:');
export const markSrc = (mark: string): string => `/marks/${mark.slice(4)}`;

export function Mark({ mark, size = 18, color = 'var(--muted)', fallback = 'assets' }: {
  mark?: string; size?: number; color?: string; fallback?: IconName;
}) {
  if (isPicture(mark)) {
    return (
      <img src={markSrc(mark!)} alt="" width={size} height={size}
           style={{ width: size, height: size, objectFit: 'contain', borderRadius: 4, display: 'block' }} />
    );
  }
  // A mark this set has no icon for is not a mark. Drawing the nearest thing to hand is how
  // three different banks ended up wearing the same picture as the assets screen.
  return <Icon name={hasIcon(mark) ? mark : fallback} size={size} color={color} />;
}

/**
 * Choosing one.
 *
 * The icons offered are icons of the subject — choosing a car's mark means choosing between
 * vehicles, not scrolling a list that happens to contain one. Underneath them is the way out
 * of the set: a picture, for the cases the set will never cover.
 */
export function MarkPicker({ value, family, tone = 'var(--accent)', onChange, onClose, label }: {
  value?: string;
  /** which set of icons to offer; a key of ICON_FAMILY */
  family: string;
  tone?: string;
  onChange: (mark: string) => void;
  onClose: () => void;
  label: string;
}) {
  const { run } = useLive();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const icons = ICON_FAMILY[family] ?? ICON_FAMILY.spending ?? [];

  const upload = async (f: File) => {
    setProblem(null);
    if (f.size > 512 * 1024) {
      setProblem(`That is ${Math.round(f.size / 1024)} KB. A mark is never drawn larger than about 48 pixels, so scale it down under 512 KB.`);
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      // The label is the file's name, and a photograph off a phone is routinely called
      // something longer than the sixty characters the ledger stores — which came back as
      // "the input does not match what this capability takes" and looked like the picture
      // being rejected. It is a label; the end of it is no loss.
      const res = await run('mark.upload', { label: f.name.slice(0, 60), mime: f.type, data });
      const ref = res.result?.ref as string | undefined;
      if (ref) { onChange(ref); onClose(); }
      else setProblem(res.message ?? 'That picture was not stored.');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dismissable onClose={onClose} label={label}>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 12, padding: '13px 15px',
        borderRadius: 'var(--r-card)', background: 'var(--raised)', border: '1px solid var(--hairline)',
      }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {icons.map((ic) => (
            <button key={ic} aria-label={ic} aria-pressed={value === ic} onClick={() => { onChange(ic); onClose(); }}
              style={{
                width: 38, height: 38, borderRadius: 10, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: value === ic ? `color-mix(in srgb, ${tone} var(--tint), transparent)` : 'var(--surface)',
                border: `1px solid ${value === ic ? tone : 'var(--hairline)'}`,
              }}>
              <Icon name={ic} size={18} color={value === ic ? tone : 'var(--faint)'} />
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 10,
                      borderTop: '1px solid var(--hairline)' }}>
          {isPicture(value) && (
            <img src={markSrc(value!)} alt="" width={34} height={34}
                 style={{ width: 34, height: 34, objectFit: 'contain', borderRadius: 8,
                          border: `1px solid ${tone}`, padding: 3 }} />
          )}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                 aria-label={`${label} — a picture`} style={{ display: 'none' }}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <button className="btn ghost" disabled={busy} onClick={() => file.current?.click()}
                  style={{ fontSize: 12, padding: '7px 12px' }}>
            {busy ? 'Storing…' : isPicture(value) ? 'Use a different picture' : 'Use a picture instead'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>PNG, JPEG, WebP, SVG · up to 512 KB</span>
        </div>

        {problem && (
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: 'var(--negative)' }}>{problem}</p>
        )}
      </div>
    </Dismissable>
  );
}
