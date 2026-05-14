import { spawnSync } from 'node:child_process';
export function run(command, args, options = {}) {
    const stdio = options.stdio ?? 'pipe';
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        input: options.input,
        encoding: 'utf8',
        stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
        throw new Error(`Failed to run ${command}: ${result.error.message}`);
    }
    const status = result.status ?? 1;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (status !== 0 && options.allowFailure !== true) {
        throw new Error(stderr.trim() || `${command} ${args.join(' ')} failed with status ${status}`);
    }
    return { status, stdout, stderr };
}
