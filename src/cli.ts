import { withClient, createClient } from "./client";
import { Watcher } from "./watcher";

function usage(): never {
  console.log(`Usage: linear-agent <command> [args]

Commands:
  watch     Tail a Claude session JSONL and emit activities to Linear
  issue     Manage Linear issues
  session   Manage agent session

Watch command:
  watch --session-id <id>                Tail session JSONL → Linear activities

Issue commands:
  issue view <issue-id>                  View issue details
  issue list [--state <name>]            List issues
  issue move <issue-id> <state-name>     Move issue to workflow state
  issue comment <issue-id> <body>        Post a comment

Session commands:
  session update-plan <json>             Replace session plan items
  session add-url <label> <url>          Add external URL to session
  session activity <type> <body>         Emit an activity (thought|action|error|response|elicitation)

Options:
  --help    Show this help message`);
  process.exit(0);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function requireArg(args: string[], index: number, name: string): string {
  if (index >= args.length || !args[index]) {
    return fail(`Missing required argument: ${name}`);
  }
  return args[index];
}

function requireSessionId(): string {
  const id = process.env.LINEAR_AGENT_SESSION_ID;
  if (!id)
    return fail("LINEAR_AGENT_SESSION_ID environment variable is required for session commands");
  return id;
}

// --- Issue commands ---

async function issueView(issueId: string): Promise<void> {
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
}

async function issueList(stateName?: string): Promise<void> {
  await withClient(async (client) => {
    const issues = await client.issues({
      filter: stateName ? { state: { name: { eq: stateName } } } : undefined,
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
}

async function issueMove(issueId: string, stateName: string): Promise<void> {
  await withClient(async (client) => {
    const issue = await client.issue(issueId);
    const team = await issue.team;
    if (!team) return fail("Could not resolve issue's team");

    const states = await team.states();
    const target = states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
    if (!target) {
      const available = states.nodes.map((s) => s.name).join(", ");
      return fail(`State "${stateName}" not found. Available: ${available}`);
    }

    await client.updateIssue(issue.id, { stateId: target.id });
    console.log(`Moved ${issue.identifier} to "${target.name}"`);
  });
}

async function issueComment(issueId: string, body: string): Promise<void> {
  await withClient(async (client) => {
    const issue = await client.issue(issueId);
    await client.createComment({ issueId: issue.id, body });
    console.log(`Comment posted on ${issue.identifier}`);
  });
}

// --- Session commands ---

async function sessionUpdatePlan(jsonStr: string): Promise<void> {
  const sessionId = requireSessionId();
  const plan = JSON.parse(jsonStr);
  await withClient(async (client) => {
    await client.updateAgentSession(sessionId, { plan });
  });
  console.log("Session plan updated");
}

async function sessionAddUrl(label: string, url: string): Promise<void> {
  const sessionId = requireSessionId();
  await withClient(async (client) => {
    await client.updateAgentSession(sessionId, {
      addedExternalUrls: [{ label, url }],
    });
  });
  console.log(`URL added: ${label} → ${url}`);
}

async function sessionActivity(type: string, body: string): Promise<void> {
  const validTypes = ["thought", "action", "error", "response", "elicitation"];
  if (!validTypes.includes(type)) {
    fail(`Invalid activity type: ${type}. Must be one of: ${validTypes.join(", ")}`);
  }

  const sessionId = requireSessionId();
  await withClient(async (client) => {
    await client.createAgentActivity({
      agentSessionId: sessionId,
      content: { type, body },
    });
  });
  console.log(`Activity emitted: ${type}`);
}

// --- Watch command ---

async function watch(args: string[]): Promise<void> {
  const sidIdx = args.indexOf("--session-id");
  if (sidIdx === -1 || !args[sidIdx + 1]) {
    fail("Usage: watch --session-id <id>");
  }
  const sessionId = args[sidIdx + 1];

  const client = await createClient();
  const watcher = new Watcher({ sessionId }, client);
  await watcher.run();
}

// --- Main dispatch ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    if (args.length <= 1) usage();
  }

  const resource = args[0];
  const action = args[1];

  if (resource === "--help") usage();

  if (resource === "watch") {
    await watch(args.slice(1));
    return;
  }

  if (resource === "issue") {
    if (!action || action === "--help") {
      console.log(`Usage: linear-agent issue <action> [args]

Commands:
  view <issue-id>                  View issue details
  list [--state <name>]            List issues
  move <issue-id> <state-name>     Move issue to workflow state
  comment <issue-id> <body>        Post a comment`);
      process.exit(0);
    }

    switch (action) {
      case "view":
        await issueView(requireArg(args, 2, "issue-id"));
        break;
      case "list": {
        const stateIdx = args.indexOf("--state");
        const stateName = stateIdx !== -1 ? args[stateIdx + 1] : undefined;
        await issueList(stateName);
        break;
      }
      case "move":
        await issueMove(requireArg(args, 2, "issue-id"), requireArg(args, 3, "state-name"));
        break;
      case "comment":
        await issueComment(requireArg(args, 2, "issue-id"), requireArg(args, 3, "body"));
        break;
      default:
        fail(`Unknown issue action: ${action}`);
    }
  } else if (resource === "session") {
    if (!action || action === "--help") {
      console.log(`Usage: linear-agent session <action> [args]

Commands:
  update-plan <json>             Replace session plan items
  add-url <label> <url>          Add external URL to session
  activity <type> <body>         Emit an activity`);
      process.exit(0);
    }

    switch (action) {
      case "update-plan":
        await sessionUpdatePlan(requireArg(args, 2, "json"));
        break;
      case "add-url":
        await sessionAddUrl(requireArg(args, 2, "label"), requireArg(args, 3, "url"));
        break;
      case "activity":
        await sessionActivity(requireArg(args, 2, "type"), requireArg(args, 3, "body"));
        break;
      default:
        fail(`Unknown session action: ${action}`);
    }
  } else {
    fail(`Unknown resource: ${resource}. Use "issue" or "session".`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
