export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  EMPTY_RESULT: 66,
  SERVICE_UNAVAIL: 69,
  TEMPFAIL: 75,
  NOPERM: 77,
  CONFIG_ERROR: 78,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode: ExitCode;

  constructor(
    code: string,
    message: string,
    hint?: string,
    exitCode: ExitCode = EXIT_CODES.GENERIC_ERROR,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export class BrowserConnectError extends CliError {
  constructor(message: string, hint?: string) {
    super('BROWSER_CONNECT', message, hint, EXIT_CODES.SERVICE_UNAVAIL);
  }
}

export class CommandExecutionError extends CliError {
  constructor(message: string, hint?: string) {
    super('COMMAND_EXEC', message, hint, EXIT_CODES.GENERIC_ERROR);
  }
}

export class AuthRequiredError extends CliError {
  readonly domain: string;

  constructor(domain: string, message?: string) {
    super(
      'AUTH_REQUIRED',
      message ?? `Not logged in to ${domain}`,
      `Please open Chrome and log in to https://${domain}`,
      EXIT_CODES.NOPERM,
    );
    this.domain = domain;
  }
}

export class TimeoutError extends CliError {
  constructor(label: string, seconds: number, hint?: string) {
    super(
      'TIMEOUT',
      `${label} timed out after ${seconds}s`,
      hint ?? 'Try again later or increase FOLO_BROWSER_COMMAND_TIMEOUT',
      EXIT_CODES.TEMPFAIL,
    );
  }
}

export class ArgumentError extends CliError {
  constructor(message: string, hint?: string) {
    super('ARGUMENT', message, hint, EXIT_CODES.USAGE_ERROR);
  }
}

export class EmptyResultError extends CliError {
  constructor(command: string, hint?: string) {
    super(
      'EMPTY_RESULT',
      `${command} returned no data`,
      hint ?? 'The page structure may have changed, or you may need to log in',
      EXIT_CODES.EMPTY_RESULT,
    );
  }
}

export class SelectorError extends CliError {
  constructor(selector: string, hint?: string) {
    super(
      'SELECTOR',
      `Could not find element: ${selector}`,
      hint ?? 'The page UI may have changed.',
      EXIT_CODES.GENERIC_ERROR,
    );
  }
}
