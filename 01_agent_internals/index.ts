import OpenAI from "openai";
import { spawn } from "node:child_process";


const client = new OpenAI();

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
      "run a bash command in the project workspace. Returns stdout, stderr and exit code.",
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
];

const systemPrompt = `You are a helpful assistant. Use tools when needed`;

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
async function runBash(cmd: string, timeoutSec = 30) {
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((res, rej) => {
    const child = spawn(
      "C:/Users/WELCOME/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe", // path to docker executable
      [
        "exec", // docker subcommand runs a command inside an already running container, unlike "docker run"
        "agent-sandbox", // name of the container
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

async function runAgent(userQuery: string) {
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
            result = await runBash(toolArguments.command);
            console.log("[bash result]", result);
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

const answer = await runAgent(
  "create a file hello.js to greet a user with its name, run the file for the user name as 'Tushar' tell me what it returns or prints.",
);

console.log(answer);
