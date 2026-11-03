import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ToolsRegistry } from "./tools";
import { z } from "zod";
import type { ToolContext } from "./types";
import { askApproval, isReadOnly, logData } from "./utils";

const client = new OpenAI();

const DOCKER = process.env.DOCKER_PATH ?? "docker";

// convert our tools in open ai compatible format:
const openAITools: OpenAI.Responses.FunctionTool[] = ToolsRegistry.map(
  (tool) => {
    const { $schema, ...parameters } = z.toJSONSchema(tool.schema) as Record<
      string,
      unknown
    >;
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters,
    };
  },
);

// call tool function
async function callTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = ToolsRegistry.find((tool) => tool.name == name);
  if (!tool) {
    return `ERROR: Invalid tool called, Available tools: ${ToolsRegistry.map((tool) => tool.name)}`;
  }

  let json: unknown;

  try {
    json = JSON.parse(rawArgs);
  } catch (error) {
    return `ERROR: arguments are not valid JSON`;
  }

  const parsed = tool.schema.safeParse(json);
  if (!parsed.success) {
    return `ERROR: invalid arguments for ${name}: ${parsed.error.message}`;
  }

  try {
    if (tool.needsApproval) {
      const approval = await askApproval(tool.name, parsed.data);
      if (!approval) {
        return `DENIED: the user did not approve this ${tool.name} call. Do not retry it; continue without it or ask the user.`;
      }
    }
    return await tool.run(parsed.data, ctx);
  } catch (error) {
    return `ERROR: ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const systemPrompt = `You are a coding agent with a Linux sandbox. Your working directory is /workspace.
Use write_file to create or change files. Use bash only to run commands (node, ls, cat, tests).
Verify your work by running it. If something fails twice the same way, change your approach.`;

// sandbox functions to run isolated environments
function createSandbox() {
  const id = randomUUID().slice(0, 8);
  const name = `agent-sandbox-${id}`;
  const workspace = path.resolve("workspaces", id);
  mkdirSync(workspace, { recursive: true });

  const r = spawnSync(
    DOCKER,
    [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "agent-sandbox=true", // lets you find and clean up leaked ones
      "-v",
      `${workspace}:/workspace`,
      "-w",
      "/workspace",
      "--network",
      "none",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "node:22",
      "sleep",
      "infinity",
    ],
    { encoding: "utf8" },
  );

  if (r.status !== 0)
    throw new Error(`Sandbox failed to start: ${r.stderr || r.error?.message}`);
  return { name, workspace };
}

function destroySandbox(name: string) {
  spawnSync(DOCKER, ["rm", "-f", name]);
}

async function runAgent(userQuery: string, sandboxName: string) {
  let input: OpenAI.Responses.ResponseInput = [
    {
      role: "user",
      content: userQuery,
    },
  ];

  const maxIterations = 10;
  let turns = 0;

  const toolCallCounts = new Map<string, number>(); // toolName -> call counts

  while (turns++ < maxIterations) {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: systemPrompt,
      tools: openAITools,
      input: input,
    });

    // add the model response at each turn to the context
    input.push(...(response.output as OpenAI.Responses.ResponseInput));

    logData("response/output", response.output);
    logData("response/usage", response.usage);

    // tool calls that model has requested, call the tools manually in your code
    const toolCalls = response.output.filter(
      (item) => item.type === "function_call",
    );

    if (toolCalls.length === 0) {
      logData("response/output-text", response.output_text);
      return response.output_text;
    }

    // parallel execution:
    const runOneTool = async (
      tc: (typeof toolCalls)[number],
    ): Promise<string> => {
      const started = Date.now();
      const output = await callTool(tc.name, tc.arguments, { sandboxName });
      logData("tool_call/run-one", {
        name: tc.name,
        args: tc.arguments,
        ms: Date.now() - started,
      });
      return output;
    };

    let outputs: string[];
    if (toolCalls.every((tc) => isReadOnly(tc.name))) {
      outputs = await Promise.all(toolCalls.map(runOneTool)); // results come back in the original order
    } else {
      outputs = [];
      for (const tc of toolCalls) outputs.push(await runOneTool(tc));
    }

    toolCalls.forEach((tc, i) => {
      const key = `${tc.name}:${tc.arguments}`;
      const count = (toolCallCounts.get(key) ?? 0) + 1;
      toolCallCounts.set(key, count);

      let output = outputs[i]!;
      if (count >= 3) {
        output += `\n\nWARNING: you have made this exact call ${count} times. Try a different approach.`;
      }

      input.push({ type: "function_call_output", call_id: tc.call_id, output });
    });
  }

  throw new Error("Agent exceeded maximum iterations");
}

const sandbox = createSandbox();
try {
  const answer = await runAgent(
    "create three files a.txt, b.txt and c.txt all written with a+b+c = d",
    sandbox.name,
  );
  logData("runAgent/response", answer);
} finally {
  destroySandbox(sandbox.name);
}
