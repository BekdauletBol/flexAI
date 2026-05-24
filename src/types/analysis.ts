export interface TodoItem {
  id: string;
  task: string;
  priority: 'high' | 'medium' | 'low';
  done: boolean;
  time?: string;
  duration?: number;   // minutes, default 30
  location?: string;
}

export interface AnalysisResult {
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
}
