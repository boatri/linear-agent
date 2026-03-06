const STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
}

interface PlanItem {
  content: string
  status: string
}

export class PlanTracker {
  private items: PlanItem[] = []

  handleTodoWrite(input: Record<string, unknown>): void {
    const todos = input.todos as Array<{ content?: string; status?: string }> | undefined
    this.items = (todos ?? []).map((todo) => ({
      content: String(todo.content ?? ''),
      status: String(todo.status ?? 'pending'),
    }))
  }

  hasPlan(): boolean {
    return this.items.length > 0
  }

  toLinearPlan(): Array<{ content: string; status: string }> {
    return this.items.map((item) => ({
      content: item.content,
      status: STATUS_MAP[item.status] ?? 'pending',
    }))
  }
}
