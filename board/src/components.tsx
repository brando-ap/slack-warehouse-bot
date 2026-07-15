import type { BoardAction, Person, Ticket } from './types';

/** Whole days between two YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

const PRIORITY_TAG: Record<string, { label: string; cls: string } | undefined> = {
  urgent: { label: '▲ URGENT', cls: 'critical' },
  high: { label: '▲ HIGH', cls: 'serious' },
};

export function StatTiles({
  tickets,
  today,
  doneToday,
}: {
  tickets: Ticket[];
  today: string;
  doneToday: number;
}) {
  const overdue = tickets.filter((t) => t.due && t.due < today).length;
  const dueToday = tickets.filter((t) => t.due === today).length;
  return (
    <div className="stats">
      <div className="stat">
        <div className="val">{tickets.length}</div>
        <div className="lbl">Open tickets</div>
      </div>
      <div className={`stat ${overdue ? 'crit' : ''}`}>
        <div className="val">{overdue}</div>
        <div className="lbl">{overdue ? '⚠ Overdue' : 'Overdue'}</div>
      </div>
      <div className={`stat ${dueToday ? 'warn' : ''}`}>
        <div className="val">{dueToday}</div>
        <div className="lbl">Due today</div>
      </div>
      <div className="stat ok">
        <div className="val">{doneToday}</div>
        <div className="lbl">Done today</div>
      </div>
    </div>
  );
}

export function CategoryTabs({
  categories,
  tickets,
  selected,
  onSelect,
}: {
  categories: string[];
  tickets: Ticket[];
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const count = (cat: string | null) =>
    cat === null ? tickets.length : tickets.filter((t) => (t.category ?? 'other') === cat).length;
  const hasUncategorized = tickets.some((t) => !t.category);
  const tabs: Array<{ key: string | null; label: string }> = [
    { key: null, label: 'All' },
    ...categories.map((c) => ({ key: c as string | null, label: `#${c}` })),
    ...(hasUncategorized && !categories.includes('other') ? [{ key: 'other' as string | null, label: '#other' }] : []),
  ];
  if (tabs.length <= 2) return null;
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key ?? '__all'}
          role="tab"
          aria-selected={selected === tab.key}
          className={`tab ${selected === tab.key ? 'active' : ''}`}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label} <span className="tab-n">{count(tab.key)}</span>
        </button>
      ))}
    </div>
  );
}

function dueChip(ticket: Ticket, today: string): { label: string; cls: string } | null {
  if (!ticket.due) return null;
  const days = daysBetween(today, ticket.due);
  if (days < 0) return { label: `OVERDUE ${-days}d`, cls: 'critical' };
  if (days === 0) return { label: 'TODAY', cls: 'warning' };
  if (days === 1) return { label: 'TOMORROW', cls: 'neutral' };
  return {
    label: new Date(ticket.due + 'T00:00:00Z').toLocaleDateString([], {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
    }),
    cls: 'neutral',
  };
}

export function TicketCard({
  ticket,
  today,
  onTap,
}: {
  ticket: Ticket;
  today: string;
  onTap: (ticket: Ticket) => void;
}) {
  const due = dueChip(ticket, today);
  const pri = PRIORITY_TAG[ticket.priority];
  const laneCls = ticket.due && ticket.due < today ? 'crit' : ticket.due === today ? 'warn' : '';
  return (
    <button className={`card ${laneCls}`} onClick={() => onTap(ticket)}>
      <div className="card-top">
        <span className="ref">{ticket.ref}</span>
        {due && <span className={`chip due ${due.cls}`}>{due.label}</span>}
      </div>
      <div className="card-title">
        {ticket.title} {pri && <span className={`pri ${pri.cls}`}>{pri.label}</span>}
      </div>
      <div className="card-chips">
        {ticket.category && <span className="chip cat">#{ticket.category}</span>}
        {(ticket.company || ticket.contact) && (
          <span className="chip">{[ticket.company, ticket.contact].filter(Boolean).join(' — ')}</span>
        )}
        {ticket.photos > 0 && <span className="chip">📷 {ticket.photos}</span>}
      </div>
      <div className="card-foot">
        {ticket.assigneeName ?? ticket.assignee ? (
          <span>
            👤 {ticket.assigneeName ?? ticket.assignee}
            {ticket.status === 'in_progress' ? ' · working' : ''}
          </span>
        ) : (
          <span className="unclaimed">unclaimed — tap to claim</span>
        )}
      </div>
    </button>
  );
}

export function Lane({
  title,
  tone,
  tickets,
  today,
  onTap,
}: {
  title: string;
  tone: 'critical' | 'warning' | 'neutral';
  tickets: Ticket[];
  today: string;
  onTap: (ticket: Ticket) => void;
}) {
  return (
    <section className={`lane ${tone}`}>
      <div className="lane-head">
        <span className={`dot ${tone}`} />
        {title}
        <span className="lane-n">{tickets.length}</span>
      </div>
      {tickets.map((t) => (
        <TicketCard key={t.id} ticket={t} today={today} onTap={onTap} />
      ))}
      {tickets.length === 0 && <div className="lane-empty">—</div>}
    </section>
  );
}

export function ActionSheet({
  ticket,
  me,
  onAction,
  onSwitchPerson,
  onClose,
}: {
  ticket: Ticket;
  me: Person;
  onAction: (ticket: Ticket, action: BoardAction) => void;
  onSwitchPerson: () => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-ref">{ticket.ref}</div>
        <div className="sheet-title">{ticket.title}</div>
        {ticket.details && <div className="sheet-details">{ticket.details}</div>}
        <div className="sheet-actions">
          <button className="act" onClick={() => onAction(ticket, 'claim')}>
            🙋 Claim
          </button>
          <button className="act" onClick={() => onAction(ticket, 'progress')}>
            🔄 In progress
          </button>
          <button className="act primary" onClick={() => onAction(ticket, 'done')}>
            ✅ Done
          </button>
        </div>
        <div className="sheet-foot">
          Acting as <b>{me.name}</b> ·{' '}
          <button className="linkish" onClick={onSwitchPerson}>
            not you?
          </button>
          <button className="linkish cancel" onClick={onClose}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function PersonPicker({
  people,
  onPick,
  onClose,
}: {
  people: Person[];
  onPick: (person: Person) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">Who are you?</div>
        {people.length === 0 ? (
          <div className="sheet-details">
            Nobody yet — use any bot command in Slack once (e.g. <code>/requests</code>) and your name
            appears here.
          </div>
        ) : (
          <div className="people">
            {people.map((p) => (
              <button key={p.id} className="act person" onClick={() => onPick(p)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="sheet-foot">
          <button className="linkish cancel" onClick={onClose}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
