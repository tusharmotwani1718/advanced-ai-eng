import { z } from "zod";
import type { Tool } from "./types";
import { dockerExec, lineCount, readSandboxFile, writeSandboxFile } from "./utils";

function defineTool<T>(tool: Tool<T>) {
  return tool;
}

const MAX_LINES = 100;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a text file from /workspace. Returns content with line numbers. " +
    `Reads at most ${MAX_LINES} lines per call; use offset to read further.`,
  readOnly: true,
  schema: z
    .object({
      path: z.string().describe("Path to the file to read"),
      offset: z.number().describe("Offset to start reading from").nullable(),
      limit: z
        .number()
        .describe("maximum number of lines to read at once")
        .nullable(),
    })
    .strict(),
  async run(args, ctx) {
    const { path, offset, limit } = args;

    const run = await dockerExec(ctx.sandboxName, ["cat", "--", path]);
    if (run.exitCode !== 0) {
      return `ERROR: Failed to read file: ${run.stderr}`;
    }

    const lines = run.stdout.split("\n");
    if (lines.length === 0) {
      return `${path} is empty`;
    }

    const total = lines.length;

    const start = offset ?? 1;
    const count = limit ?? MAX_LINES;
    if (start > total)
      return `ERROR: offset ${start} is past the end of ${path} (${total} lines).`;

    const end = Math.min(start + count - 1, total);
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
      .join("\n");

    const header = `${path} (lines ${start}-${end} of ${total})`;
    const footer =
      end < total
        ? `\n... ${total - end} more lines. Call read_file with offset=${end + 1}.`
        : "";
    return `${header}\n${body}${footer}`;
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a file in /workspace, or completely overwrite it if it exists. Parent folders are created automatically. " +
    "To change part of an existing file, use edit_file instead.",
  readOnly: false,
  schema: z
    .object({
      path: z.string().min(1).describe("File path, relative to /workspace"),
      content: z.string().describe("The complete file content"),
    })
    .strict(),

  async run({ path, content }, ctx) {
    const r = await writeSandboxFile(ctx.sandboxName, path, content);
    if (!r.ok) return `ERROR: could not write ${path}: ${r.error}`;
    return `Wrote ${path} (${lineCount(content)} lines, ${Buffer.byteLength(content)} bytes).`;
  },
});

export const deleteFileTool = defineTool({
  name: "delete_file",
  description: "Delete a single file in /workspace. Cannot delete folders. The user must approve each deletion.",
  readOnly: false,
  needsApproval: true,
  schema: z
    .object({
      path: z.string().min(1).describe("File path, relative to /workspace"),
    })
    .strict(),

  async run({ path }, ctx) {
    // No -r: rm refuses folders, so one call can't wipe a directory tree.
    // No -f: a missing file is reported as an error instead of silently "succeeding".
    const r = await dockerExec(ctx.sandboxName, ["rm", "--", path]);
    if (r.exitCode !== 0) return `ERROR: could not delete ${path}: ${r.stderr.trim() || `exit code ${r.exitCode}`}`;
    return `Deleted ${path}.`;
  },
});

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace text in an existing file. old_string must match the file exactly, including whitespace and indentation, " +
    "and must appear exactly once unless replace_all is true. Include enough surrounding lines to make it unique. " +
    "Read the file first, and do not include the line-number prefixes shown by read_file.",
  readOnly: false,
  schema: z
    .object({
      path: z.string().min(1).describe("File path, relative to /workspace"),
      old_string: z.string().min(1).describe("Exact text to replace"),
      new_string: z.string().describe("Replacement text; empty string deletes old_string"),
      replace_all: z.boolean().nullable().describe("Replace every occurrence. null = false"),
    })
    .strict(),

  async run({ path, old_string, new_string, replace_all }, ctx) {
    if (old_string === new_string) return "ERROR: old_string and new_string are identical; nothing to change.";

    const file = await readSandboxFile(ctx.sandboxName, path);
    if (!file.ok) return `ERROR: could not read ${path}: ${file.error}`;
    const content = file.content;

    const matches = content.split(old_string).length - 1;
    if (matches === 0) {
      return `ERROR: old_string not found in ${path}. It must match exactly, including whitespace. Use read_file to see the current content.`;
    }
    if (matches > 1 && !replace_all) {
      return `ERROR: old_string appears ${matches} times in ${path}. Include more surrounding lines to make it unique, or set replace_all to true.`;
    }

    // split/join instead of String.replace(): replace() treats "$&", "$1", "$$" in the
    // replacement text as special patterns, which would corrupt code containing "$".
    const updated = content.split(old_string).join(new_string);

    const w = await writeSandboxFile(ctx.sandboxName, path, updated);
    if (!w.ok) return `ERROR: could not write ${path}: ${w.error}`;

    const firstLine = content.slice(0, content.indexOf(old_string)).split("\n").length;
    return `Edited ${path}: replaced ${matches} occurrence${matches > 1 ? "s" : ""} (first at line ${firstLine}).`;
  },
});

export const bashTool = defineTool({
  name: "bash",
  description: "Run a bash command in /workspace. Returns exit code, stdout and stderr. Do not use this to write file contents.",
  readOnly: false,
  schema: z
    .object({ command: z.string().min(1).describe("Command to run") })
    .strict(),
  async run({ command }, ctx) {
    const r = await dockerExec(ctx.sandboxName, ["bash", "-c", command]);
    return `exit code: ${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
  },
});


export const ToolsRegistry: Tool<any>[] = [
  readFileTool,
  writeFileTool,
  deleteFileTool,
  editFileTool,
  bashTool
]