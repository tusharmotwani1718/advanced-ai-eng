import OpenAI from "openai";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const client = new OpenAI();

const DOCKER = process.env.DOCKER_PATH ?? "docker";

const tools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "get_user",
    description: "Get the user given by id from the JSON placeholder API.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "number",
          description: "The id of the user to fetch details",
        },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "bash",
    description:
      "run a bash command in the project workspace. Returns stdout, stderr and exit code. Run commands. Do not use this to write file contents.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "bash command to run inside the workspace",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description:
      "Create or overwrite a file in /workspace with the given content. Always use this to write file contents; do not use echo or heredocs in bash.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to /workspace" },
        content: { type: "string", description: "The complete file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

const systemPrompt = `You are a coding agent with a Linux sandbox. Your working directory is /workspace.
Use write_file to create or change files. Use bash only to run commands (node, ls, cat, tests).
Verify your work by running it. If something fails twice the same way, change your approach.`;

const truncate = (s: string, max = 10_000) => {
  return s.length > max
    ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`
    : s;
};

// json placeholder function:
async function callJSONPlaceholder(userId: number) {
  const res = await fetch(
    `https://jsonplaceholder.typicode.com/users/${userId}`,
  );
  const data = await res.json();

  return data;
}

// run bash command function:
function runBash(cmd: string, sandboxName: string, timeoutSec = 30) {
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((res, rej) => {
    const child = spawn(
      DOCKER, // path to docker executable
      [
        "exec", // docker subcommand runs a command inside an already running container, unlike "docker run"
        sandboxName, // name of the container
        "timeout",
        String(timeoutSec),
        "bash",
        "-c",
        cmd,
      ],
    );

    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (e) => {
      res({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: `Failed to start process: ${e.message}`,
      });
    });

    child.on("close", (code, signal) => {
      res({
        exitCode: code,
        signal,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
  });
}

// write file function:
function writeFileContent(
  sandboxName: string,
  filePath: string,
  content: string,
) {
  return new Promise<{ok: boolean, error?: string}>((res, _) => {
    const child = spawn(DOCKER, [
      "exec", "-i", sandboxName,                    // -i keeps stdin open
      "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"',
      "sh", filePath,                               // becomes $0 and $1 in the script
    ]);

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ ok: false, error: e.message }));
    child.on("close", (code) =>
      res(code === 0 ? { ok: true } : { ok: false, error: stderr || `exit code ${code}` }),
    );
    child.stdin.end(content);                       // content goes in raw, never parsed

  })
}

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

async function runAgent(userQuery: string, sandbox: string) {
  let previousResponseId: string | undefined;

  let input: OpenAI.Responses.ResponseInput = [
    {
      role: "user",
      content: userQuery,
    },
  ];

  const maxIterations = 10;
  let turns = 0;

  while (turns++ < maxIterations) {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: systemPrompt,
      tools: tools,
      input: input,
      ...(previousResponseId && {
        previous_response_id: previousResponseId,
      }),
    });

    previousResponseId = response.id;

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
      let result: unknown;

      try {
        const toolArguments = JSON.parse(toolCall.arguments);

        switch (name) {
          case "get_user": {
            result = await callJSONPlaceholder(toolArguments.userId);
            break;
          }
          case "bash": {
            console.log("[bash]", toolArguments.command);
            result = await runBash(toolArguments.command, sandbox);
            console.log("[bash result]", result);
            break;
          }
          case "write_file": {
            console.log("[write_file]", toolArguments.path);
            result = await writeFileContent(sandbox, toolArguments.path, toolArguments.content);
            break;
          }
          default:
            result = { error: `Unknown tool: ${name}` };
            break;
        }
      } catch (error) {
        result = {
          error:
            error instanceof Error ? error.message : "Tool execution failed",
        };
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
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
    "create a file hello.js to greet a user with its name, run the file for the user name as 'Tushar' tell me what it returns or prints.",
    sandbox.name,
  );
  console.log(answer);
} finally {
  destroySandbox(sandbox.name);
}
