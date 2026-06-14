import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAN_PATH = path.resolve(__dirname, '../day_plan.json');

function migrate() {
  if (!fs.existsSync(PLAN_PATH)) return;
  const raw = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));
  
  let userPlansObj = raw.userPlans;
  if (raw.__version !== 2 || !userPlansObj) {
    console.log('Migration only supports v2 format.');
    return;
  }

  let deletedCount = 0;

  for (const [userId, plans] of Object.entries(userPlansObj)) {
    const seen = new Set<string>();
    
    // Iterate from newest to oldest plan
    for (let i = (plans as any[]).length - 1; i >= 0; i--) {
      const plan = (plans as any[])[i];
      const planDate = plan.createdAt.substring(0, 10);
      const newTodos = [];
      
      // Iterate todos from newest to oldest
      for (let j = plan.todos.length - 1; j >= 0; j--) {
        const todo = plan.todos[j];
        const tDate = todo.date || planDate;
        const taskNorm = todo.task.trim().toLowerCase();
        
        const key = `${taskNorm}::${tDate}`;
        if (seen.has(key)) {
          deletedCount++;
        } else {
          seen.add(key);
          newTodos.unshift(todo); // put back in original order
        }
      }
      plan.todos = newTodos;
    }
  }

  fs.writeFileSync(PLAN_PATH, JSON.stringify(raw, null, 2));
  console.log(`Migration complete. Deleted ${deletedCount} duplicate tasks.`);
}

migrate();
