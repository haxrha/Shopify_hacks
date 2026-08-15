import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the DoorDash CLI.
 *
 * Arguments are always passed as an array through execFile with no shell. Message
 * text from a group chat reaches this module, so a shell would be a command
 * injection surface.
 */

// Fields are declared and assigned explicitly rather than via parameter properties,
// which Node's --experimental-strip-types cannot compile.
export class DdCliError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(message: string, args: readonly string[], stderr: string) {
    super(message);
    this.name = 'DdCliError';
    this.args = args;
    this.stderr = stderr;
  }
}

export class DdCliAuthError extends DdCliError {
  constructor(args: readonly string[], stderr: string) {
    super('dd-cli is not signed in — run `dd-cli login`, or set DD_CLI_ACCESS_TOKEN', args, stderr);
    this.name = 'DdCliAuthError';
  }
}

/**
 * Runs a dd-cli command and parses its structured output.
 *
 * `--json-output` is always passed: the default output is text rendered for a human
 * terminal, and dd-cli's own guidance is that agents should read the JSON instead.
 */
export async function runDdCli<T = unknown>(args: readonly string[]): Promise<T> {
  const fullArgs = ['--json-output', ...args];

  try {
    const { stdout } = await execFileAsync(config.ddCli.binary, fullArgs, {
      timeout: config.ddCli.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...(config.ddCli.accessToken ? { DD_CLI_ACCESS_TOKEN: config.ddCli.accessToken } : {}),
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new DdCliError(`dd-cli returned non-JSON output for: ${args.join(' ')}`, fullArgs, stdout);
    }

    return unwrapEnvelope(parsed, fullArgs) as T;
  } catch (error) {
    const stderr = extractStderr(error);
    if (/missing credentials|dd-cli login|DD_CLI_ACCESS_TOKEN/i.test(stderr)) {
      throw new DdCliAuthError(fullArgs, stderr);
    }
    if (error instanceof DdCliError) throw error;
    throw new DdCliError(`dd-cli failed: ${args.join(' ')}`, fullArgs, stderr);
  }
}

/**
 * Unwraps dd-cli's response envelope.
 *
 * `--json-output` returns `{ content: [...], structuredContent: {...}, isError }`,
 * where `content` is text rendered for display and the real payload sits under
 * `structuredContent`. Callers must never see the outer object: helpers that fall
 * back to "the first array in the response" would otherwise pick `content` and
 * silently read display text as if it were data.
 */
function unwrapEnvelope(parsed: unknown, args: readonly string[]): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const envelope = parsed as { structuredContent?: unknown; isError?: unknown; content?: unknown };

  if (envelope.isError === true) {
    throw new DdCliError(`dd-cli reported an error for: ${args.join(' ')}`, args, JSON.stringify(envelope.content ?? ''));
  }

  return envelope.structuredContent ?? parsed;
}

function extractStderr(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { stderr?: unknown; message?: unknown };
    if (typeof candidate.stderr === 'string') return candidate.stderr;
    if (typeof candidate.message === 'string') return candidate.message;
  }
  return String(error);
}

/** True when dd-cli has usable credentials. */
export async function isAuthenticated(): Promise<boolean> {
  // Every dd-cli command rejects a missing --intent before it checks credentials,
  // so the probe has to supply one or it fails for the wrong reason.
  const intent = [
    'Summary: Confirm the ordering agent can reach DoorDash before taking requests',
    'user prompt/purpose: "startup health check"',
  ].join('\n');

  try {
    await runDdCli(['address', 'list', '--intent', intent]);
    return true;
  } catch (error) {
    if (error instanceof DdCliAuthError) return false;
    // Any other failure means the CLI ran and was authenticated enough to try.
    return true;
  }
}
