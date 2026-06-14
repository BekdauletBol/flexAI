export interface TodoItem {
  id: string;
  task: string;
  priority: 'high' | 'medium' | 'low';
  done: boolean;
  time?: string;       // "HH:MM" for display/24h
  datetime?: string;   // ISO datetime "2026-07-15T15:00:00" for scheduling
  date?: string;       // "YYYY-MM-DD" for grouping/conflict detection
  duration?: number;   // minutes, default 30
  location?: string;
}

export interface AnalysisResult {
  intent: 'query' | 'action' | 'social' | 'reschedule';
  title: string;
  summary: string;
  key_points: string[];
  todos: TodoItem[];
  tags: string[];
  raw_transcript: string;
  language: 'ru' | 'en' | 'kk' | 'mixed';
  location_query?: string;
  visit_datetime?: string;
  needs_location_check?: boolean;
  user_city?: string;
  query_date?: string;
}
