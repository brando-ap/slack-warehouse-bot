// Shapes returned by the Worker's /api/board endpoints.

export interface Ticket {
  id: number;
  ref: string;
  title: string;
  details: string | null;
  company: string | null;
  contact: string | null;
  category: string | null;
  status: string;
  priority: string;
  due: string | null;
  assignee: string | null;
  assigneeName: string | null;
  photos: number;
  createdByName: string | null;
}

export interface Person {
  id: string;
  name: string;
}

export interface BoardData {
  generatedAt: string;
  timezone: string;
  today: string;
  doneToday: number;
  categories: string[];
  people: Person[];
  tickets: Ticket[];
}

export type BoardAction = 'claim' | 'progress' | 'done';
