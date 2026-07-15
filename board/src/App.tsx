import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchBoard, sendAction } from './api';
import type { BoardAction, BoardData, Person, Ticket } from './types';
import { ActionSheet, CategoryTabs, Lane, PersonPicker, StatTiles } from './components';

const POLL_MS = 15_000;
const ME_KEY = 'board.me';

function loadMe(): Person | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Person) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [me, setMe] = useState<Person | null>(loadMe);
  const [target, setTarget] = useState<Ticket | null>(null);
  const [pickingPerson, setPickingPerson] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clock, setClock] = useState(() => new Date());

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchBoard();
      setData(fresh);
      setError(null);
      setStale(false);
    } catch (err) {
      // Keep showing the last good data; just flag it as stale.
      setStale(true);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    const tick = setInterval(() => setClock(new Date()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const chooseMe = (person: Person) => {
    setMe(person);
    localStorage.setItem(ME_KEY, JSON.stringify(person));
    setPickingPerson(false);
  };

  const runAction = async (ticket: Ticket, action: BoardAction) => {
    if (!me) return;
    setTarget(null);
    try {
      const updated = await sendAction(ticket.id, action, me.id);
      setData((prev) =>
        prev
          ? {
              ...prev,
              tickets:
                action === 'done'
                  ? prev.tickets.filter((t) => t.id !== ticket.id)
                  : prev.tickets.map((t) => (t.id === ticket.id ? updated : t)),
              doneToday: action === 'done' ? prev.doneToday + 1 : prev.doneToday,
            }
          : prev
      );
      setToast(action === 'done' ? `✅ ${ticket.ref} closed — nice work, ${me.name}!` : `${ticket.ref} updated`);
    } catch (err) {
      setToast(`⚠️ ${err instanceof Error ? err.message : 'Action failed'}`);
      void refresh();
    }
    setTimeout(() => setToast(null), 4000);
  };

  const visible = useMemo(() => {
    if (!data) return [];
    if (!category) return data.tickets;
    return data.tickets.filter((t) => (t.category ?? 'other') === category);
  }, [data, category]);

  const lanes = useMemo(() => {
    if (!data) return { overdue: [], today: [], upcoming: [] };
    const today = data.today;
    const weight = (t: Ticket) =>
      ({ urgent: 0, high: 1, normal: 2, low: 3 })[t.priority as 'urgent' | 'high' | 'normal' | 'low'] ?? 2;
    const byUrgency = (a: Ticket, b: Ticket) =>
      weight(a) - weight(b) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.id - b.id;
    return {
      overdue: visible.filter((t) => t.due && t.due < today).sort(byUrgency),
      today: visible.filter((t) => t.due === today).sort(byUrgency),
      upcoming: visible.filter((t) => !t.due || t.due > today).sort(byUrgency),
    };
  }, [data, visible]);

  if (!data && !error) {
    return <div className="loading">Loading the board…</div>;
  }
  if (!data) {
    return (
      <div className="loading">
        <div className="load-error">
          <h1>Can’t reach the board</h1>
          <p>{error}</p>
          <p className="hint">
            Check the URL includes <code>?key=…</code> — then this page retries automatically.
          </p>
        </div>
      </div>
    );
  }

  const overdueCount = data.tickets.filter((t) => t.due && t.due < data.today).length;

  return (
    <div className="board">
      {overdueCount > 0 && (
        <div className="alert-banner" role="alert">
          ⚠ {overdueCount} ticket{overdueCount === 1 ? '' : 's'} OVERDUE
        </div>
      )}

      <header>
        <h1>📦 Fulfillment Board</h1>
        <div className="header-right">
          <span className={`sync ${stale ? 'stale' : 'ok'}`}>
            {stale ? '● reconnecting…' : '● live'}
          </span>
          <span className="clock">
            {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
      </header>

      <StatTiles tickets={data.tickets} today={data.today} doneToday={data.doneToday} />

      <CategoryTabs
        categories={data.categories}
        tickets={data.tickets}
        selected={category}
        onSelect={setCategory}
      />

      <div className="lanes">
        <Lane title="⚠ Overdue" tone="critical" tickets={lanes.overdue} today={data.today} onTap={setTarget} />
        <Lane title="Due today" tone="warning" tickets={lanes.today} today={data.today} onTap={setTarget} />
        <Lane title="Up next" tone="neutral" tickets={lanes.upcoming} today={data.today} onTap={setTarget} />
      </div>

      {data.tickets.length === 0 && <div className="all-clear">✔ All clear — no open tickets</div>}

      <footer>
        <span>
          {me ? (
            <>
              Acting as <b>{me.name}</b> ·{' '}
              <button className="linkish" onClick={() => setPickingPerson(true)}>
                switch
              </button>
            </>
          ) : (
            'Tap a ticket to claim or complete it'
          )}
        </span>
        <span className="muted">File tickets with /request in Slack · refreshes every 15s</span>
      </footer>

      {target && me && !pickingPerson && (
        <ActionSheet
          ticket={target}
          me={me}
          onAction={runAction}
          onSwitchPerson={() => setPickingPerson(true)}
          onClose={() => setTarget(null)}
        />
      )}
      {(pickingPerson || (target && !me)) && (
        <PersonPicker
          people={data.people}
          onPick={chooseMe}
          onClose={() => {
            setPickingPerson(false);
            if (!me) setTarget(null);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
