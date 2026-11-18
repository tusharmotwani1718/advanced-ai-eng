import type { OpenAI } from "openai";

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

    // Preserve the function_call_output and its call_id!
    return {
      ...item,
      output: stub,
    };
  });
}
