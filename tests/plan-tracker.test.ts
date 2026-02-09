import { describe, expect, test } from "bun:test";
import { PlanTracker } from "../src/claude/plan-tracker";

describe("PlanTracker", () => {
  describe("handleTaskCreate", () => {
    test("parses task ID from result text and stores task as pending", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Fix login" }, "Created Task #7 successfully");
      expect(tracker.hasPlan()).toBe(true);
      expect(tracker.toLinearPlan()).toEqual([{ content: "Fix login", status: "pending" }]);
    });

    test("ignores result text without a task ID", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Fix login" }, "something went wrong");
      expect(tracker.hasPlan()).toBe(false);
    });

    test("uses empty string when subject is missing", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({}, "Task #1 created");
      expect(tracker.toLinearPlan()).toEqual([{ content: "", status: "pending" }]);
    });

    test("multiple creates produce ordered plan (Map insertion order)", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "First" }, "Task #1 ok");
      tracker.handleTaskCreate({ subject: "Second" }, "Task #2 ok");
      tracker.handleTaskCreate({ subject: "Third" }, "Task #3 ok");
      expect(tracker.toLinearPlan()).toEqual([
        { content: "First", status: "pending" },
        { content: "Second", status: "pending" },
        { content: "Third", status: "pending" },
      ]);
    });
  });

  describe("handleTaskUpdate", () => {
    test("updates task status", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Do thing" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "1", status: "in_progress" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "Do thing", status: "inProgress" }]);
    });

    test("updates task subject", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Old name" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "1", subject: "New name" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "New name", status: "pending" }]);
    });

    test("updates both status and subject in one call", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Draft" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "1", status: "completed", subject: "Final" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "Final", status: "completed" }]);
    });

    test("deletes task when status is deleted", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Temp" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "1", status: "deleted" });
      expect(tracker.hasPlan()).toBe(false);
      expect(tracker.toLinearPlan()).toEqual([]);
    });

    test("ignores update for unknown task ID", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "A" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "999", status: "completed" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "A", status: "pending" }]);
    });

    test("ignores update with missing taskId", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "A" }, "Task #1 ok");
      tracker.handleTaskUpdate({});
      expect(tracker.toLinearPlan()).toEqual([{ content: "A", status: "pending" }]);
    });
  });

  describe("handleTodoWrite", () => {
    test("replaces entire plan with new todos", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Old" }, "Task #1 ok");
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

    test("clears plan when todos is undefined", () => {
      const tracker = new PlanTracker();
      tracker.handleTaskCreate({ subject: "Old" }, "Task #1 ok");
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
    test("maps each status independently via STATUS_MAP", () => {
      const tracker = new PlanTracker();
      // Use handleTaskCreate to isolate from handleTodoWrite coupling
      tracker.handleTaskCreate({ subject: "a" }, "Task #1 ok");
      tracker.handleTaskUpdate({ taskId: "1", status: "pending" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "a", status: "pending" }]);

      tracker.handleTaskUpdate({ taskId: "1", status: "in_progress" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "a", status: "inProgress" }]);

      tracker.handleTaskUpdate({ taskId: "1", status: "completed" });
      expect(tracker.toLinearPlan()).toEqual([{ content: "a", status: "completed" }]);
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
