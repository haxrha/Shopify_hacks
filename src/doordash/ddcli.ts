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

    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new DdCliError(`dd-cli returned non-JSON output for: ${args.join(' ')}`, fullArgs, stdout);
    }
  } catch (error) {
    const stderr = extractStderr(error);
    if (/missing credentials|dd-cli login|DD_CLI_ACCESS_TOKEN/i.test(stderr)) {
      throw new DdCliAuthError(fullArgs, stderr);
    }
    if (error instanceof DdCliError) throw error;
    throw new DdCliError(`dd-cli failed: ${args.join(' ')}`, fullArgs, stderr);
  }
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
  try {
    await runDdCli(['address', 'list']);
    return true;
  } catch (error) {
    if (error instanceof DdCliAuthError) return false;
    // Any other failure means the CLI ran and was authenticated enough to try.
    return true;
  }
}
