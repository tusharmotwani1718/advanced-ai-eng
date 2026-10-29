import OpenAI from "openai";

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
];

const systemPrompt = `You are a helpful assistant. Use tools when needed`;

async function callJSONPlaceholder(userId: number) {
  const res = await fetch(
    `https://jsonplaceholder.typicode.com/users/${userId}`,
  );
  const data = await res.json();

  return data;
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

const answer = await runAgent("fetch the user 3 details");

console.log(answer);
