import { confirm as confirmPrompt, select as selectPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { stdin as input, stdout as output } from 'node:process';
function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}
export async function step(label, action) {
    if (!process.stdout.isTTY) {
        return action();
    }
    const spinner = ora({
        text: label,
        discardStdin: false,
    }).start();
    try {
        const result = await action();
        spinner.succeed(label);
        return result;
    }
    catch (error) {
        spinner.fail(label);
        throw error;
    }
}
export async function promptYesNo(label, defaultValue = false) {
    if (!input.isTTY) {
        return defaultValue;
    }
    return confirmPrompt({
        message: label,
        default: defaultValue,
    }, { input, output });
}
export async function promptSelect(label, choices, defaultValue) {
    if (!input.isTTY) {
        return defaultValue;
    }
    return selectPrompt({
        message: label,
        choices,
        default: defaultValue,
    }, { input, output });
}
export function printCliError(error, options = {}) {
    const message = getErrorMessage(error);
    console.error(chalk.red('Error'));
    console.error(chalk.redBright(message));
    if (options.debug && error instanceof Error && error.stack) {
        console.error('');
        console.error(chalk.gray(error.stack));
    }
    else {
        console.error('');
        console.error(chalk.gray('Run with --debug to see the stack trace.'));
    }
}
export function printSection(title) {
    console.log(chalk.bold(chalk.cyan(title)));
}
export function printKeyValue(label, value) {
    const paddedLabel = `${label}:`.padEnd(12, ' ');
    console.log(`${chalk.gray(paddedLabel)} ${value}`);
}
