import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { SERIOUS } from './theme';
import type { BoardAction, Person, Ticket } from './types';

/** Whole days between two YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

const TONE_COLOR: Record<string, string> = {
  critical: '#d03b3b',
  warning: '#fab219',
  neutral: '#898781',
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
  const tiles = [
    { val: tickets.length, label: 'Open tickets', accent: 'divider' },
    { val: overdue, label: overdue ? '⚠ Overdue' : 'Overdue', accent: overdue ? 'error.main' : 'divider' },
    { val: dueToday, label: 'Due today', accent: dueToday ? 'warning.main' : 'divider' },
    { val: doneToday, label: 'Done today', accent: 'success.main' },
  ];
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2, mb: 2 }}>
      {tiles.map((tile) => (
        <Paper
          key={tile.label}
          variant="outlined"
          sx={{ p: 1.5, px: 2, borderTop: 3, borderTopColor: tile.accent }}
        >
          <Typography variant="h3">{tile.val}</Typography>
          <Typography color="text.secondary">{tile.label}</Typography>
        </Paper>
      ))}
    </Box>
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
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
      {tabs.map((tab) => (
        <Chip
          key={tab.key ?? '__all'}
          label={`${tab.label} (${count(tab.key)})`}
          clickable
          color={selected === tab.key ? 'primary' : 'default'}
          variant={selected === tab.key ? 'filled' : 'outlined'}
          onClick={() => onSelect(tab.key)}
          sx={{ fontWeight: 600, fontSize: '1rem' }}
        />
      ))}
    </Stack>
  );
}

function dueChip(ticket: Ticket, today: string): { label: string; color: string } | null {
  if (!ticket.due) return null;
  const days = daysBetween(today, ticket.due);
  if (days < 0) return { label: `OVERDUE ${-days}d`, color: 'error.main' };
  if (days === 0) return { label: 'TODAY', color: 'warning.main' };
  if (days === 1) return { label: 'TOMORROW', color: 'text.secondary' };
  return {
    label: new Date(ticket.due + 'T00:00:00Z').toLocaleDateString([], {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
    }),
    color: 'text.secondary',
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
  const stripe =
    ticket.due && ticket.due < today ? 'error.main' : ticket.due === today ? 'warning.main' : 'divider';
  const priColor = ticket.priority === 'urgent' ? 'error.main' : ticket.priority === 'high' ? SERIOUS : null;
  return (
    <Card variant="outlined" sx={{ mb: 1.5, borderLeft: 5, borderLeftColor: stripe }}>
      <CardActionArea onClick={() => onTap(ticket)}>
        <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {ticket.ref}
            </Typography>
            {due && (
              <Typography variant="body2" sx={{ color: due.color, fontWeight: 800, letterSpacing: '0.03em' }}>
                {due.label}
              </Typography>
            )}
          </Stack>
          <Typography variant="h6" sx={{ my: 0.5 }}>
            {ticket.title}{' '}
            {priColor && (
              <Typography component="span" variant="body2" sx={{ color: priColor, fontWeight: 800 }}>
                ▲ {ticket.priority.toUpperCase()}
              </Typography>
            )}
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {ticket.category && <Chip size="small" label={`#${ticket.category}`} sx={{ fontWeight: 650 }} />}
            {(ticket.company || ticket.contact) && (
              <Chip
                size="small"
                variant="outlined"
                label={[ticket.company, ticket.contact].filter(Boolean).join(' — ')}
              />
            )}
            {ticket.photos > 0 && <Chip size="small" variant="outlined" label={`📷 ${ticket.photos}`} />}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            {ticket.assigneeName ?? ticket.assignee
              ? `👤 ${ticket.assigneeName ?? ticket.assignee}${ticket.status === 'in_progress' ? ' · working' : ''}`
              : 'unclaimed — tap to claim'}
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
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
    <Box component="section">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pb: 1 }}>
        <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: TONE_COLOR[tone] }} />
        <Typography variant="h2">{title}</Typography>
        <Typography color="text.secondary" sx={{ ml: 'auto !important', fontVariantNumeric: 'tabular-nums' }}>
          {tickets.length}
        </Typography>
      </Stack>
      {tickets.map((t) => (
        <TicketCard key={t.id} ticket={t} today={today} onTap={onTap} />
      ))}
      {tickets.length === 0 && (
        <Box
          sx={{
            color: 'text.secondary',
            textAlign: 'center',
            p: 2,
            border: 1,
            borderStyle: 'dashed',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        >
          —
        </Box>
      )}
    </Box>
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
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>
        <Typography variant="body2" color="text.secondary" component="div">
          {ticket.ref}
        </Typography>
        {ticket.title}
      </DialogTitle>
      <DialogContent>
        {ticket.details && (
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            {ticket.details}
          </Typography>
        )}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5, my: 2 }}>
          <Button variant="outlined" color="inherit" size="large" sx={{ py: 2, fontSize: '1.1rem' }} onClick={() => onAction(ticket, 'claim')}>
            🙋 Claim
          </Button>
          <Button variant="outlined" color="inherit" size="large" sx={{ py: 2, fontSize: '1.1rem' }} onClick={() => onAction(ticket, 'progress')}>
            🔄 Working
          </Button>
          <Button variant="contained" color="success" size="large" sx={{ py: 2, fontSize: '1.1rem' }} onClick={() => onAction(ticket, 'done')}>
            ✅ Done
          </Button>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography color="text.secondary">
            Acting as <b>{me.name}</b> ·{' '}
            <Link component="button" color="inherit" onClick={onSwitchPerson}>
              not you?
            </Link>
          </Typography>
          <Link component="button" color="inherit" onClick={onClose} sx={{ ml: 'auto !important' }}>
            cancel
          </Link>
        </Stack>
      </DialogContent>
    </Dialog>
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
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Who are you?</DialogTitle>
      <DialogContent>
        {people.length === 0 ? (
          <Typography color="text.secondary">
            Nobody yet — use any bot command in Slack once (e.g. <code>/requests</code>) and your name appears
            here.
          </Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
              gap: 1,
              maxHeight: '50vh',
              overflowY: 'auto',
              py: 1,
            }}
          >
            {people.map((p) => (
              <Button key={p.id} variant="outlined" color="inherit" size="large" onClick={() => onPick(p)}>
                {p.name}
              </Button>
            ))}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
