import { describe, expect, test } from "bun:test";
import { PlanTracker } from "../src/claude/plan-tracker";

describe("PlanTracker", () => {
  describe("handleTodoWrite", () => {
    test("stores todos as plan items", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({
        todos: [
          { content: "Step 1", status: "completed" },
          { content: "Step 2", status: "pending" },
        ],
      });
      expect(tracker.toLinearPlan()).toEqual([
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "pending" },
      ]);
    });

    test("replaces previous plan on subsequent calls", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({ todos: [{ content: "Old", status: "pending" }] });
      tracker.handleTodoWrite({ todos: [{ content: "New", status: "in_progress" }] });
      expect(tracker.toLinearPlan()).toEqual([
        { content: "New", status: "inProgress" },
      ]);
    });

    test("clears plan when todos is undefined", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({ todos: [{ content: "X", status: "pending" }] });
      tracker.handleTodoWrite({});
      expect(tracker.hasPlan()).toBe(false);
    });

    test("handles empty todos array", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({ todos: [] });
      expect(tracker.hasPlan()).toBe(false);
    });

    test("defaults missing content and status", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({ todos: [{}] });
      expect(tracker.toLinearPlan()).toEqual([{ content: "", status: "pending" }]);
    });
  });

  describe("toLinearPlan", () => {
    test("maps each status to Linear format", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "completed" },
        ],
      });
      expect(tracker.toLinearPlan()).toEqual([
        { content: "a", status: "pending" },
        { content: "b", status: "inProgress" },
        { content: "c", status: "completed" },
      ]);
    });

    test("falls back to pending for unknown status", () => {
      const tracker = new PlanTracker();
      tracker.handleTodoWrite({ todos: [{ content: "x", status: "unknown_status" }] });
      expect(tracker.toLinearPlan()).toEqual([{ content: "x", status: "pending" }]);
    });

    test("returns empty array when no plan exists", () => {
      expect(new PlanTracker().toLinearPlan()).toEqual([]);
    });
  });
});
