import { confirm as confirmPrompt, select as selectPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { stdin as input, stdout as output } from 'node:process';

interface PrintCliErrorOptions {
  debug?: boolean;
}

type SelectChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  disabled?: boolean | string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

export async function step<T>(label: string, action: () => Promise<T>): Promise<T> {
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
  } catch (error) {
    spinner.fail(label);
    throw error;
  }
}

export async function promptYesNo(label: string, defaultValue = false): Promise<boolean> {
  if (!input.isTTY) {
    return defaultValue;
  }

  return confirmPrompt({
    message: label,
    default: defaultValue,
  }, { input, output });
}

export async function promptSelect<const Value>(
  label: string,
  choices: readonly SelectChoice<Value>[],
  defaultValue: Value,
): Promise<Value> {
  if (!input.isTTY) {
    return defaultValue;
  }

  return selectPrompt({
    message: label,
    choices,
    default: defaultValue,
  }, { input, output });
}

export function printCliError(error: unknown, options: PrintCliErrorOptions = {}): void {
  const message = getErrorMessage(error);

  console.error(chalk.red('Error'));
  console.error(chalk.redBright(message));

  if (options.debug && error instanceof Error && error.stack) {
    console.error('');
    console.error(chalk.gray(error.stack));
  } else {
    console.error('');
    console.error(chalk.gray('Run with --debug to see the stack trace.'));
  }
}

export function printSection(title: string): void {
  console.log(chalk.bold(chalk.cyan(title)));
}

export function printKeyValue(label: string, value: string): void {
  const paddedLabel = `${label}:`.padEnd(12, ' ');
  console.log(`${chalk.gray(paddedLabel)} ${value}`);
}
