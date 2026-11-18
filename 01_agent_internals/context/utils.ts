import OpenAI from "openai";
import { withRetry } from "..";
import { logData } from "../utils";


const client = new OpenAI({
  maxRetries: 0,
});

// clear the old tool outputs:
export function clearStaleToolOutputsForACall(
  turnOutputs: OpenAI.Responses.ResponseInputItem[],
  removeBeforeIndex: number,
  minChars = 500,
): OpenAI.Responses.ResponseInputItem[] {
  return turnOutputs.map((item, index) => {
    if (
      index >= removeBeforeIndex ||
      item.type !== "function_call_output" ||
      typeof item.output !== "string" ||
      item.output.length <= minChars
    ) {
      return item;
    }

    let args = "Original arguments unavailable";

    try {
      const parsed = JSON.parse(item.output);
      args = parsed.args ?? args;
    } catch {
      // Tool output wasn't JSON; retain the fallback.
    }

    const originalLength = item.output.length;

    const stub = [
      `[Previous tool output cleared]`,
      `Original output length: ${originalLength} characters.`,
      `Call ID: ${item.call_id}`,
      `Arguments: ${args}`,
      `If you need this information again, call the tool again.`,
    ].join("\n");

    logData("compacted/cleared", stub);

    // Preserve the function_call_output and its call_id!
    return {
      ...item,
      output: stub,
    };
  });
}

const SUMMARY_PROMPT = `You are summarizing the earlier part of a coding agent's session so it can continue with less context.
Write a concise summary with these sections:
- Goal: the user's task
- Done so far: what was completed
- Files: every file created, changed or deleted, with its path, one line each
- Decisions: choices made and why
- Failed attempts: what was tried and did not work, and why, so it is not repeated
- Current state: unresolved errors and anything half-done
- Next step: what the agent was about to do
Keep exact paths, commands, error messages and versions. Do not invent anything.`;

export async function summarizeContext(
  inputs: OpenAI.Responses.ResponseInputItem[],
  summarizeBeforeLength: number,
): Promise<OpenAI.Responses.ResponseInputItem[]> {
  if (summarizeBeforeLength < inputs.length) return inputs;

  const originalTask = inputs[0]!;
  const originalContext = inputs.slice(1, summarizeBeforeLength);
  const toBeMaintained = inputs.slice(summarizeBeforeLength);

  const res = await withRetry(() =>
    client.responses.create({
      model: "gpt-4.1-mini",
      instructions: SUMMARY_PROMPT,
      // tool_choice: "none", // tools are listed only because `old` contains tool calls
      input: [
        originalTask,
        ...originalContext,
        { role: "user", content: "Write the summary now." },
      ],
    }),
  );

  const suummarizedContext = res?.output_text;

  const summary : OpenAI.Responses.ResponseInputItem = {
    role:  "user",
    content: `Summary of earlier work written by harness. \n ${suummarizedContext}`
  }

  inputs.splice(0, inputs.length, originalTask, summary, ...toBeMaintained);

  logData("compaction", { removedItems: originalContext.length, summaryChars: res?.output_text.length });
  return inputs;
}
