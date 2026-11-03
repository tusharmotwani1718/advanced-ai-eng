import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";

const DOCKER = process.env.DOCKER_PATH ?? "docker";

type ExecOpts = { timeoutSec?: number; stdin?: string };

export function dockerExec(
  sandbox: string,
  cmd: string[],
  opts: ExecOpts = {},
) {
  const { timeoutSec = 30, stdin } = opts;
  return new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((res) => {
    const args = [
      "exec",
      ...(stdin !== undefined ? ["-i"] : []), // -i only when we send stdin
      sandbox,
      "timeout",
      String(timeoutSec),
      ...cmd,
    ];
    const child = spawn(DOCKER, args);

    // Collect raw Buffers and decode once at the end. Decoding each chunk separately
    // can split a multi-byte character (emoji, Hindi text) across two chunks and corrupt it.
    const out: Buffer[] = [],
      err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));

    child.on("error", (e) =>
      res({
        exitCode: null,
        stdout: "",
        stderr: `Failed to start: ${e.message}`,
      }),
    );
    child.on("close", (code) =>
      res({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );

    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

export async function readSandboxFile(sandbox: string, path: string) {
  const r = await dockerExec(sandbox, ["cat", "--", path]);
  if (r.exitCode !== 0)
    return {
      ok: false as const,
      error: r.stderr.trim() || `exit code ${r.exitCode}`,
    };
  return { ok: true as const, content: r.stdout };
}

export async function writeSandboxFile(
  sandbox: string,
  path: string,
  content: string,
) {
  const r = await dockerExec(
    sandbox,
    ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], // path is $1, never interpolated
    { stdin: content }, // content never parsed by a shell
  );
  if (r.exitCode !== 0)
    return {
      ok: false as const,
      error: r.stderr.trim() || `exit code ${r.exitCode}`,
    };
  return { ok: true as const };
}

export const lineCount = (s: string) =>
  s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);

export async function askApproval(name: string, args: unknown) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    `\n⚠ Allow ${name} ${JSON.stringify(args)}? (y/n) `,
  );
  rl.close();
  return answer.trim().toLowerCase() === "y";
}
