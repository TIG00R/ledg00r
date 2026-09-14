import { useApp } from '../AppState';

export function Placeholder({ id, title }: { id: string; title: string }) {
  const { dm, values } = useApp();
  return (
    <main style={{ padding: 32, maxWidth: 1180, margin: '0 auto', width: '100%' }}>
      <section className="panel" style={{ padding: 48, textAlign: 'center' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>{title}</h2>
        <p style={{ margin: '0 auto', maxWidth: 460, fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
          Designed, not yet built. The engine behind it already runs — net worth computes
          to {dm(values.total)} from the same data this screen will read.
        </p>
        <code style={{ display: 'inline-block', marginTop: 16, fontSize: 12, color: 'var(--faint)' }}>
          screens/{id}.tsx
        </code>
      </section>
    </main>
  );
}
