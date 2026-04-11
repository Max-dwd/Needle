#!/usr/bin/env node
if (process.platform !== 'win32') {
    const standard = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const current = new Set((process.env.PATH ?? '').split(':').filter(Boolean));
    for (const entry of standard)
        current.add(entry);
    process.env.PATH = [...current].join(':');
}
import { ArgumentError, CliError, EXIT_CODES } from './errors.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCommandHandler, parseCliRequest, } from './commands/index.js';
import { browserSession, DEFAULT_BROWSER_COMMAND_TIMEOUT, getBrowserFactory, runWithTimeout, } from './runtime.js';
function printUsage() {
    process.stderr.write([
        'Needle Browser Runtime',
        '',
        'Supported commands:',
        '  youtube channel-info',
        '  youtube channel-videos',
        '  youtube video-meta',
        '  youtube transcript',
        '  bilibili channel-info',
        '  bilibili user-videos',
        '  bilibili video-meta',
        '  bilibili subtitle',
        '  bilibili following',
        '',
        'All commands only support `-f json` output.',
        '',
    ].join('\n'));
}
function workspaceForSite(site) {
    return `site:${site}`;
}
function renderError(error) {
    if (error instanceof CliError) {
        return error.hint ? `${error.message}\n${error.hint}` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
async function writeCliResult(result, outputFile) {
    const payload = `${JSON.stringify(result)}\n`;
    if (!outputFile) {
        process.stdout.write(payload);
        return;
    }
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, payload, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, outputFile: outputFile })}\n`);
}
export async function dispatchCliCommand(input) {
    const handler = resolveCommandHandler(input.site, input.command);
    if (!handler) {
        throw new ArgumentError(`Unsupported command: ${input.site} ${input.command}`, 'Needle Browser runtime only includes the YouTube/Bilibili commands used by Needle.');
    }
    const BrowserFactory = getBrowserFactory();
    return browserSession(BrowserFactory, async (page) => runWithTimeout(handler(page, input), {
        timeout: DEFAULT_BROWSER_COMMAND_TIMEOUT,
        label: `${input.site}/${input.command}`,
    }), { workspace: workspaceForSite(input.site) });
}
export async function runCli(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        printUsage();
        return EXIT_CODES.SUCCESS;
    }
    try {
        const request = parseCliRequest(argv);
        const result = await dispatchCliCommand(request.commandInput);
        const outputFile = request.commandInput.flags['output-file'];
        await writeCliResult(result, typeof outputFile === 'string' ? outputFile : undefined);
        return EXIT_CODES.SUCCESS;
    }
    catch (error) {
        process.stderr.write(`${renderError(error)}\n`);
        if (error instanceof CliError)
            return error.exitCode;
        return EXIT_CODES.GENERIC_ERROR;
    }
}
if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
}
