export const EXIT_CODES = {
    SUCCESS: 0,
    GENERIC_ERROR: 1,
    USAGE_ERROR: 2,
    EMPTY_RESULT: 66,
    SERVICE_UNAVAIL: 69,
    TEMPFAIL: 75,
    NOPERM: 77,
    CONFIG_ERROR: 78,
};
export class CliError extends Error {
    code;
    hint;
    exitCode;
    constructor(code, message, hint, exitCode = EXIT_CODES.GENERIC_ERROR) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.hint = hint;
        this.exitCode = exitCode;
    }
}
export class BrowserConnectError extends CliError {
    constructor(message, hint) {
        super('BROWSER_CONNECT', message, hint, EXIT_CODES.SERVICE_UNAVAIL);
    }
}
export class CommandExecutionError extends CliError {
    constructor(message, hint) {
        super('COMMAND_EXEC', message, hint, EXIT_CODES.GENERIC_ERROR);
    }
}
export class AuthRequiredError extends CliError {
    domain;
    constructor(domain, message) {
        super('AUTH_REQUIRED', message ?? `Not logged in to ${domain}`, `Please open Chrome and log in to https://${domain}`, EXIT_CODES.NOPERM);
        this.domain = domain;
    }
}
export class TimeoutError extends CliError {
    constructor(label, seconds, hint) {
        super('TIMEOUT', `${label} timed out after ${seconds}s`, hint ?? 'Try again later or increase FOLO_BROWSER_COMMAND_TIMEOUT', EXIT_CODES.TEMPFAIL);
    }
}
export class ArgumentError extends CliError {
    constructor(message, hint) {
        super('ARGUMENT', message, hint, EXIT_CODES.USAGE_ERROR);
    }
}
export class EmptyResultError extends CliError {
    constructor(command, hint) {
        super('EMPTY_RESULT', `${command} returned no data`, hint ?? 'The page structure may have changed, or you may need to log in', EXIT_CODES.EMPTY_RESULT);
    }
}
export class SelectorError extends CliError {
    constructor(selector, hint) {
        super('SELECTOR', `Could not find element: ${selector}`, hint ?? 'The page UI may have changed.', EXIT_CODES.GENERIC_ERROR);
    }
}
