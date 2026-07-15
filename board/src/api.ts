import type { BoardAction, BoardData, Ticket } from './types';

export function boardKey(): string {
  return new URLSearchParams(window.location.search).get('key') ?? '';
}

export async function fetchBoard(): Promise<BoardData> {
  const res = await fetch(`/api/board?key=${encodeURIComponent(boardKey())}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Board request failed (${res.status})`);
  }
  return (await res.json()) as BoardData;
}

export async function sendAction(id: number, action: BoardAction, userId: string): Promise<Ticket> {
  const res = await fetch('/api/board/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: boardKey(), id, action, userId }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; ticket?: Ticket; error?: string } | null;
  if (!res.ok || !body?.ok || !body.ticket) {
    throw new Error(body?.error ?? `Action failed (${res.status})`);
  }
  return body.ticket;
}
