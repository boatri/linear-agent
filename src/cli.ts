import { Command } from "commander";
import { withClient, createClient } from "./client";
import { Watcher } from "./watcher";

const program = new Command()
  .name("linear-agent")
  .description("Claude-to-Linear bridge CLI");

// --- Watch ---

program
  .command("watch")
  .description("Tail a Claude session JSONL and emit activities to Linear")
  .requiredOption("--session-id <id>", "Linear agent session ID")
  .action(async (opts: { sessionId: string }) => {
    const client = await createClient();
    const watcher = new Watcher({ sessionId: opts.sessionId }, client);
    await watcher.run();
  });

// --- Issue ---

const issue = program
  .command("issue")
  .description("Manage Linear issues");

issue
  .command("view")
  .description("View issue details")
  .argument("<issue-id>")
  .action(async (issueId: string) => {
    await withClient(async (client) => {
      const issue = await client.issue(issueId);
      const state = await issue.state;
      const assignee = await issue.assignee;

      console.log(`${issue.identifier}: ${issue.title}`);
      console.log(`State: ${state?.name ?? "Unknown"}`);
      console.log(`Assignee: ${assignee?.name ?? "Unassigned"}`);
      console.log(`Priority: ${issue.priority}`);
      if (issue.description) {
        console.log(`\nDescription:\n${issue.description}`);
      }
    });
  });

issue
  .command("list")
  .description("List issues")
  .option("--state <name>", "Filter by workflow state")
  .action(async (opts: { state?: string }) => {
    await withClient(async (client) => {
      const issues = await client.issues({
        filter: opts.state ? { state: { name: { eq: opts.state } } } : undefined,
        first: 50,
      });

      if (issues.nodes.length === 0) {
        console.log("No issues found.");
        return;
      }

      for (const issue of issues.nodes) {
        const state = await issue.state;
        console.log(`${issue.identifier}\t${state?.name ?? "?"}\t${issue.title}`);
      }
    });
  });

issue
  .command("move")
  .description("Move issue to workflow state")
  .argument("<issue-id>")
  .argument("<state-name>")
  .action(async (issueId: string, stateName: string) => {
    await withClient(async (client) => {
      const issue = await client.issue(issueId);
      const team = await issue.team;
      if (!team) {
        console.error("Error: Could not resolve issue's team");
        process.exit(1);
      }

      const states = await team.states();
      const target = states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
      if (!target) {
        const available = states.nodes.map((s) => s.name).join(", ");
        console.error(`Error: State "${stateName}" not found. Available: ${available}`);
        process.exit(1);
      }

      await client.updateIssue(issue.id, { stateId: target.id });
      console.log(`Moved ${issue.identifier} to "${target.name}"`);
    });
  });

issue
  .command("comment")
  .description("Post a comment on an issue")
  .argument("<issue-id>")
  .argument("<body>")
  .action(async (issueId: string, body: string) => {
    await withClient(async (client) => {
      const issue = await client.issue(issueId);
      await client.createComment({ issueId: issue.id, body });
      console.log(`Comment posted on ${issue.identifier}`);
    });
  });

// --- Session ---

function getSessionId(opts: { id?: string }): string {
  const sessionId = opts.id ?? process.env.LINEAR_AGENT_SESSION_ID;
  if (!sessionId) {
    console.error("Error: Session ID required — pass --id <id> or set LINEAR_AGENT_SESSION_ID");
    process.exit(1);
  }
  return sessionId;
}

const session = program
  .command("session")
  .description("Manage agent session")
  .option("--id <id>", "Linear agent session ID (or LINEAR_AGENT_SESSION_ID env var)");

session
  .command("update-plan")
  .description("Replace session plan items")
  .argument("<json>")
  .action(async (jsonStr: string) => {
    const sessionId = getSessionId(session.opts());
    const plan = JSON.parse(jsonStr);
    await withClient(async (client) => {
      await client.updateAgentSession(sessionId, { plan });
    });
    console.log("Session plan updated");
  });

session
  .command("add-url")
  .description("Add external URL to session")
  .argument("<label>")
  .argument("<url>")
  .action(async (label: string, url: string) => {
    const sessionId = getSessionId(session.opts());
    await withClient(async (client) => {
      await client.updateAgentSession(sessionId, {
        addedExternalUrls: [{ label, url }],
      });
    });
    console.log(`URL added: ${label} → ${url}`);
  });

const ACTIVITY_TYPES = ["thought", "action", "error", "response", "elicitation"] as const;

session
  .command("activity")
  .description("Emit an activity")
  .argument("<type>", `Activity type (${ACTIVITY_TYPES.join("|")})`)
  .argument("<body>")
  .action(async (type: string, body: string) => {
    if (!ACTIVITY_TYPES.includes(type as (typeof ACTIVITY_TYPES)[number])) {
      console.error(`Error: Invalid activity type: ${type}. Must be one of: ${ACTIVITY_TYPES.join(", ")}`);
      process.exit(1);
    }

    const sessionId = getSessionId(session.opts());
    await withClient(async (client) => {
      await client.createAgentActivity({
        agentSessionId: sessionId,
        content: { type, body },
      });
    });
    console.log(`Activity emitted: ${type}`);
  });

// --- Run ---

program.parseAsync().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
