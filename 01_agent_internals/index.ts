import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ToolsRegistry } from "./tools";
import { z } from "zod";
import type { ToolContext } from "./types";
import { askApproval } from "./utils";

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
): Promise<String> {
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
  let previousResponseId: string | undefined;

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
      ...(previousResponseId && {
        previous_response_id: previousResponseId,
      }),
    });

    previousResponseId = response.id;

    console.log(`model response 🤖...`);
    console.log(`${JSON.stringify(response)}`);

    // tool calls that model has requested, call the tools manually in your code
    const toolCalls = response.output.filter(
      (item) => item.type === "function_call",
    );

    if (toolCalls.length === 0) {
      return response.output_text;
    }

    const toolOutputs: OpenAI.Responses.ResponseInput = [];

    for (const toolCall of toolCalls) {
      const { name } = toolCall;

      const output = await callTool(toolCall.name, toolCall.arguments, {
        sandboxName,
      });

      const key = `${name}:${toolCall.arguments}`;
      const count = (toolCallCounts.get(key) ?? 0) + 1;
      toolCallCounts.set(key, count);

      const payload =
        count >= 3
          ? {
              output,
              warning: `You have made this exact call ${count} times with the same result. Try a different approach.`,
            }
          : output;

      toolOutputs.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(payload),
      });
    }

    // The next request supplies only the tool results.
    input = toolOutputs;
  }

  if (turns > maxIterations) {
    throw new Error("Agent exceeded maximum iterations");
  }
}

const sandbox = createSandbox();
try {
  const answer = await runAgent(
    "create a file hello.js to greet a user with its name, run the file for the user name as 'Tushar' tell me what it returns or prints and delete the file once the task is done.",
    sandbox.name,
  );
  console.log(answer);
} finally {
  destroySandbox(sandbox.name);
}
