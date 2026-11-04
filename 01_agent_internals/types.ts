import { z } from "zod";

export type ToolContext = {
  sandboxName: string;
};

export type Tool<A> = {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  readOnly: boolean; 
  needsApproval?: boolean; // security phase: ask the user first
  run: (args: A, ctx: ToolContext) => Promise<string>; // returns text for the model
};


export type StopReason = "done" | "max_turns" | "token_budget" | "aborted" | "stuck";