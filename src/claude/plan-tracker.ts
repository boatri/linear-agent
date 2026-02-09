const STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
  deleted: 'canceled',
}

interface PlanItem {
  content: string
  status: string
}

export class PlanTracker {
  private tasks = new Map<string, PlanItem>()

  handleTaskCreate(input: Record<string, unknown>, resultText: string): void {
    const id = this.parseTaskId(resultText)
    if (!id) return

    this.tasks.set(id, {
      content: String(input.subject ?? ''),
      status: 'pending',
    })
  }

  handleTaskUpdate(input: Record<string, unknown>): void {
    const id = String(input.taskId ?? '')
    const task = this.tasks.get(id)
    if (!task) return

    if (input.status === 'deleted') {
      this.tasks.delete(id)
      return
    }

    if (input.status) {
      task.status = String(input.status)
    }
    if (input.subject) {
      task.content = String(input.subject)
    }
  }

  handleTodoWrite(input: Record<string, unknown>): void {
    this.tasks.clear()

    const todos = input.todos as Array<{ content?: string; status?: string }> | undefined
    if (!todos) return

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i]
      this.tasks.set(String(i), {
        content: String(todo.content ?? ''),
        status: String(todo.status ?? 'pending'),
      })
    }
  }

  hasPlan(): boolean {
    return this.tasks.size > 0
  }

  toLinearPlan(): Array<{ content: string; status: string }> {
    return Array.from(this.tasks.values()).map((item) => ({
      content: item.content,
      status: STATUS_MAP[item.status] ?? 'pending',
    }))
  }

  private parseTaskId(resultText: string): string | null {
    const match = resultText.match(/Task #(\d+)/)
    return match ? match[1] : null
  }
}
