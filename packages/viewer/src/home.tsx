// The start page: maps already made in this repo, and a box to ask a new question.
import { useEffect, useState } from 'react';
import { api, pageUrl } from './api';
import type { MapMeta } from './types';

export function Home() {
  const [repo, setRepo] = useState('');
  const [maps, setMaps] = useState<MapMeta[] | null>(null);
  const [making, setMaking] = useState<{ id: string; question: string }[]>([]);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.list().then((r) => { setRepo(r.repo); setMaps(r.maps); setMaking(r.making); }, (e: Error) => setError(e.message));
  }, []);

  const submit = async () => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      const { id } = await api.make(question.trim());
      location.assign(pageUrl(id));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <div className="eyebrow">codemap{repo ? ` · ${repo}` : ''}</div>
      <h1>Ask how your code works</h1>
      <p className="muted lede">Claude explores the repo and draws the answer as a map. Every box and arrow is checked against the code before you see it.</p>
      <form className="home-ask" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input id="question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What happens when a user signs up?" aria-label="Your question" autoFocus />
        <button className="btn primary" disabled={busy || !question.trim()}>{busy ? 'Starting…' : 'Map it'}</button>
      </form>
      {error && <div className="banner banner-dead" role="alert">{error}</div>}
      {making.length > 0 && (
        <section>
          <h2 className="section-title">Being made now</h2>
          <ul className="maplist">{making.map((m) => <li key={m.id}><a href={pageUrl(m.id)}>{m.question}</a><span className="muted small">Claude is exploring…</span></li>)}</ul>
        </section>
      )}
      <section>
        <h2 className="section-title">Maps in this repo</h2>
        {maps === null ? <p className="muted">Loading…</p> : maps.length === 0 ? <p className="muted">None yet. Ask a question above.</p> : (
          <ul className="maplist">
            {maps.map((m) => (
              <li key={m.id}>
                <a href={pageUrl(m.id)}>{m.question}</a>
                <span className="muted small">{new Date(m.updatedAt).toLocaleString()}{m.commit ? ` · ${m.commit.slice(0, 7)}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
