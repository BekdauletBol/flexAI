export interface TodoItem {
  task: string;
  priority: 'high' | 'medium' | 'low';
  done: boolean;
}

export interface AnalysisResult {
  title: string;
  summary: string;
  key_points: string[];
  todos: TodoItem[];
  tags: string[];
  raw_transcript: string;
  language: 'ru' | 'en' | 'mixed';
}
