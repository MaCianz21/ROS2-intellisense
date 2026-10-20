import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';
import { shellQuote } from './parse';
import { RosWorkspace } from './rosWorkspace';
import { isDirectory, isFile, log, output, showError, showWarning } from './util';

export interface BuildOptions {
    packages?: string[];
    mineOnly?: boolean;
}

/** Runs `colcon build` and merges the resulting compile_commands.json files. */
export class ColconBuilder {
    private running?: cp.ChildProcess;

    async build(
        workspace: RosWorkspace,
        options: BuildOptions,
        token?: vscode.CancellationToken,
    ): Promise<boolean> {
        if (workspace.platform === 'windows') {
            showError('native Windows builds are not supported. Open the workspace inside WSL.');
            return false;
        }

        this.running?.kill('SIGINT');
        this.running = undefined;

        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const workers = configuration.get<number>('parallelWorkers', 4);

        const args = [
            'build',
            '--symlink-install',
            '--parallel-workers',
            String(workers),
            '--cmake-args',
            '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        ];

        if (options.mineOnly) {
            const base = this.mineBasePath(workspace);
            if (!base || !isDirectorySync(base)) {
                showError(`"mine" base path not found: ${base ?? '(unresolved)'}`);
                return false;
            }
            args.push('--base-paths', base);
        }

        if (options.packages && options.packages.length > 0) {
            args.push('--packages-select', ...options.packages);
        }

        const setupScripts = configuration.get<string[]>('sourceSetupScripts', []);
        // ROS is not always under /opt/ros: use the prefix that was discovered
        // from the environment (RoboStack/conda, custom installs, …).
        if (!workspace.rosPrefix) {
            showError(
                'ROS 2 installation not found. Source your ROS environment, or set ros2IntelliSense.rosPrefix.',
            );
            return false;
        }
        const setupScript = [
            path.join(workspace.rosPrefix, 'setup.bash'),
            path.join(workspace.rosPrefix, 'local_setup.bash'),
        ].find((candidate) => fs.existsSync(candidate));
        if (!setupScript) {
            // Conda/RoboStack environments are already set up by `conda activate`;
            // there may be no prefix-level setup script to source.
            log(`No setup.bash under ${workspace.rosPrefix}; relying on the current environment.`);
        }

        const script = [
            'set -e',
            ...(setupScript ? [`source ${shellQuote(setupScript)}`] : []),
            'if [ -f install/setup.bash ]; then source install/setup.bash; fi',
            ...setupScripts.map((script) => `source ${shellQuote(script)}`),
            `colcon ${args.map(shellQuote).join(' ')}`,
        ].join('\n');

        return this.run(workspace, script, token);
    }

    /** Merge every `build/<pkg>/compile_commands.json` into `build/compile_commands.json`. */
    async merge(workspace: RosWorkspace): Promise<boolean> {
        if (!(await isDirectory(workspace.buildDir))) {
            showWarning(`build directory not found: ${workspace.buildDir}`);
            return false;
        }

        const children = await fs.promises.readdir(workspace.buildDir, { withFileTypes: true });
        const merged: unknown[] = [];
        const seen = new Set<string>();
        let sources = 0;

        for (const child of children) {
            if (!child.isDirectory()) {
                continue;
            }
            const file = path.join(workspace.buildDir, child.name, 'compile_commands.json');
            if (!(await isFile(file))) {
                continue;
            }

            let entries: unknown;
            try {
                entries = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            } catch (error) {
                log(`Skipping unreadable ${file}: ${String(error)}`);
                continue;
            }
            if (!Array.isArray(entries)) {
                continue;
            }
            sources++;

            for (const entry of entries as Array<Record<string, unknown>>) {
                const argumentsKey = Array.isArray(entry.arguments)
                    ? (entry.arguments as string[]).join(' ')
                    : '';
                const key = `${entry.directory ?? ''}\u0000${entry.file ?? ''}\u0000${
                    entry.command ?? argumentsKey
                }`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                merged.push(entry);
            }
        }

        if (sources === 0) {
            showWarning(
                'no build/*/compile_commands.json found — build with CMAKE_EXPORT_COMPILE_COMMANDS=ON first.',
            );
            return false;
        }

        await fs.promises.writeFile(
            workspace.mergeFile,
            `${JSON.stringify(merged, null, 2)}\n`,
            'utf8',
        );
        log(`Merged ${sources} compile_commands.json file(s) -> ${merged.length} entries`);
        return true;
    }

    private mineBasePath(workspace: RosWorkspace): string {
        const configured = vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<string>('mineBasePath');
        if (configured) {
            return path.isAbsolute(configured) ? configured : path.join(workspace.root, configured);
        }
        const user = process.env.USER ?? process.env.USERNAME ?? '';
        const userBase = path.join(workspace.srcDir, user);
        if (isDirectorySync(userBase)) {
            return userBase;
        }
        // Repos that are the package itself or keep packages directly under the
        // root have no `src/<user>`; fall back to the layout that actually
        // contains the packages instead of failing the command.
        if (fs.existsSync(path.join(workspace.root, 'package.xml'))) {
            return workspace.root;
        }
        if (isDirectorySync(workspace.srcDir)) {
            return workspace.srcDir;
        }
        return workspace.root;
    }

    private run(
        workspace: RosWorkspace,
        script: string,
        token?: vscode.CancellationToken,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const channel = output();
            channel.show(true);
            channel.appendLine('');
            channel.appendLine(`$ ${script.replace(/\n/g, '\n$ ')}`);
            channel.appendLine('');

            const child = cp.spawn('bash', ['-lc', script], {
                cwd: workspace.root,
                env: process.env,
            });
            this.running = child;

            const disposables: vscode.Disposable[] = [];
            if (token) {
                disposables.push(token.onCancellationRequested(() => child.kill('SIGINT')));
            }

            child.stdout?.on('data', (data: Buffer) => channel.append(data.toString()));
            child.stderr?.on('data', (data: Buffer) => channel.append(data.toString()));
            child.on('error', (error) => {
                channel.appendLine(`[error] ${error.message}`);
                this.running = undefined;
                disposables.forEach((disposable) => disposable.dispose());
                resolve(false);
            });
            child.on('close', (code) => {
                this.running = undefined;
                disposables.forEach((disposable) => disposable.dispose());
                resolve(code === 0);
            });
        });
    }
}

function isDirectorySync(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}
