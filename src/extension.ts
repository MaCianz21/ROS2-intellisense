import * as path from 'path';
import * as vscode from 'vscode';
import { ColconBuilder } from './build';
import { CONFIG_SECTION, CPPTOOLS_CONFIG_SECTION, EXTENSION_ID } from './constants';
import { RosController } from './controller';
import { CppToolsApi, getCppToolsApi, CPPTOOLS_API_VERSION } from './cpptools';
import { RosConfigurationProvider } from './provider';
import { RosPackage } from './rosPackage';
import { discoverRosInstalls } from './rosEnvironment';
import { RosWorkspace } from './rosWorkspace';
import { setupWorkspace } from './setup';
import { isConfigurationProviderEnabled, log, showWarning } from './util';

/** Coalesces bursts of filesystem/config events into a single callback. */
function debounce(callback: () => void, delayMs = 400): () => void {
    let handle: ReturnType<typeof setTimeout> | undefined;
    return () => {
        if (handle) {
            clearTimeout(handle);
        }
        handle = setTimeout(callback, delayMs);
    };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const controller = new RosController();
    const builder = new ColconBuilder();
    const provider = new RosConfigurationProvider(controller);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'ros2IntelliSense.showActivePackage';
    context.subscriptions.push(statusBar, controller, provider);

    let cppTools: CppToolsApi | undefined;

    const notify = (): void => {
        if (cppTools) {
            cppTools.didChangeCustomConfiguration(provider);
            cppTools.didChangeCustomBrowseConfiguration?.(provider);
        }
    };

    const updateStatusBar = (): void => {
        if (controller.workspaces.length === 0) {
            statusBar.hide();
            return;
        }
        let pkg: RosPackage | undefined;
        for (const workspace of controller.workspaces) {
            const active = controller.activePackage(workspace);
            if (active) {
                pkg = active;
                break;
            }
        }
        statusBar.text = pkg ? `$(symbol-package) ROS: ${pkg.name}` : '$(symbol-package) ROS 2';
        statusBar.tooltip = pkg
            ? `Active ROS 2 package: ${pkg.name}\n${pkg.dir}`
            : 'ROS 2 IntelliSense — no active package';
        statusBar.show();
    };

    context.subscriptions.push(controller.onDidUpdate.event(updateStatusBar));
    context.subscriptions.push(controller.onDidChangeProvider.event(notify));

    await controller.initialize();

    if (isConfigurationProviderEnabled()) {
        cppTools = await getCppToolsApi(CPPTOOLS_API_VERSION);
        if (cppTools) {
            cppTools.registerCustomConfigurationProvider(provider);
            if (typeof cppTools.notifyReady === 'function') {
                cppTools.notifyReady(provider);
            } else {
                notify();
            }
            context.subscriptions.push(cppTools);
            log('Registered ROS 2 configuration provider with ms-vscode.cpptools');
            // Make the extension work on a fresh clone without asking the user
            // to edit `.vscode/settings.json` by hand.
            void ensureProviderSelected(context, controller, provider, cppTools);
        } else {
            log('C/C++ extension API unavailable; IntelliSense provider disabled.');
        }
    }

    controller.setActiveEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => controller.setActiveEditor(editor)),
        vscode.workspace.onDidChangeConfiguration((event) => {
            // Our own settings (distro, include mode, compiler, …) and the
            // compiler default we fall back to all change what a workspace
            // resolves to, so rebuild it rather than only dropping caches.
            if (
                event.affectsConfiguration(CONFIG_SECTION) ||
                event.affectsConfiguration(`${CPPTOOLS_CONFIG_SECTION}.default.compilerPath`)
            ) {
                void controller.initialize();
            }
        }),
    );

    registerFileWatchers(context, controller);

    context.subscriptions.push(
        vscode.commands.registerCommand('ros2IntelliSense.build', () =>
            runBuild(controller, builder, {}),
        ),
        vscode.commands.registerCommand('ros2IntelliSense.buildPackage', () =>
            runBuildPackage(controller, builder),
        ),
        vscode.commands.registerCommand('ros2IntelliSense.buildMine', () =>
            runBuild(controller, builder, { mineOnly: true }),
        ),
        vscode.commands.registerCommand('ros2IntelliSense.merge', () =>
            runMerge(controller, builder),
        ),
        vscode.commands.registerCommand('ros2IntelliSense.refresh', async () => {
            await controller.refreshAll();
            void vscode.window.showInformationMessage('ROS 2 IntelliSense refreshed.');
        }),
        vscode.commands.registerCommand('ros2IntelliSense.showActivePackage', () =>
            showActivePackage(controller),
        ),
        vscode.commands.registerCommand('ros2IntelliSense.setupWorkspace', async () => {
            const workspace = await pickWorkspace(controller);
            if (workspace) {
                await setupWorkspace(workspace);
                await controller.refreshAll();
            }
        }),
        vscode.commands.registerCommand('ros2IntelliSense.selectDistro', () =>
            selectDistro(controller),
        ),
    );

    updateStatusBar();
}

export function deactivate(): void {
    // Disposables are registered through the extension context.
}

/**
 * Select this extension as the C/C++ configuration provider when the workspace
 * does not have one yet, so a fresh clone needs no manual settings. If another
 * provider is already selected, do not fight it: offer the switch once and
 * remember the answer.
 */
async function ensureProviderSelected(
    context: vscode.ExtensionContext,
    controller: RosController,
    provider: RosConfigurationProvider,
    cppTools: CppToolsApi,
): Promise<void> {
    if (!isConfigurationProviderEnabled() || controller.workspaces.length === 0) {
        return;
    }

    const scope = vscode.workspace.workspaceFolders?.[0]?.uri;
    const configuration = vscode.workspace.getConfiguration(CPPTOOLS_CONFIG_SECTION, scope);
    const configured = configuration.get<string>('default.configurationProvider', '') || '';
    const fromProperties = await providerFromCppProperties();
    const otherProvider = [configured, fromProperties].find(
        (value) => value && value !== EXTENSION_ID,
    );
    if (!otherProvider && (configured === EXTENSION_ID || fromProperties === EXTENSION_ID)) {
        return;
    }
    try {
        if (otherProvider) {
            const promptKey = 'ros2IntelliSense.providerPrompted';
            if (context.workspaceState.get<boolean>(promptKey)) {
                return;
            }
            await context.workspaceState.update(promptKey, true);
            const useOurs = 'Use ROS 2 IntelliSense';
            const choice = await vscode.window.showInformationMessage(
                `The C/C++ extension is using "${otherProvider}" as configuration provider, so ROS 2 IntelliSense is inactive.`,
                useOurs,
            );
            if (choice !== useOurs) {
                return;
            }
            // Rewrite both settings.json and c_cpp_properties.json, because the
            // per-configuration provider in the latter takes precedence. The
            // workspace-level update also covers the other folders of a
            // multi-root window.
            await configuration.update(
                'default.configurationProvider',
                EXTENSION_ID,
                vscode.ConfigurationTarget.Workspace,
            );
            const workspace = controller.workspaces[0];
            if (workspace) {
                await setupWorkspace(workspace);
            }
        } else {
            await configuration.update(
                'default.configurationProvider',
                EXTENSION_ID,
                vscode.ConfigurationTarget.Workspace,
            );
            log(`Set ${CPPTOOLS_CONFIG_SECTION}.default.configurationProvider to ${EXTENSION_ID}`);
            void vscode.window.showInformationMessage(
                'ROS 2 IntelliSense enabled for this workspace.',
            );
        }

        cppTools.didChangeCustomConfiguration(provider);
        cppTools.didChangeCustomBrowseConfiguration?.(provider);
    } catch (error) {
        log(`Could not select the C/C++ configuration provider: ${String(error)}`);
        showWarning(
            'could not enable the C/C++ provider automatically. Run "ROS 2: Set Up Workspace for IntelliSense".',
        );
    }
}

/** The provider explicitly set in the first `.vscode/c_cpp_properties.json`. */
async function providerFromCppProperties(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'c_cpp_properties.json');
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
            configurations?: Array<{ configurationProvider?: unknown }>;
        };
        for (const configuration of parsed.configurations ?? []) {
            if (
                typeof configuration.configurationProvider === 'string' &&
                configuration.configurationProvider
            ) {
                return configuration.configurationProvider;
            }
        }
    } catch {
        // No file, unreadable file, or invalid JSON: nothing to respect.
    }
    return undefined;
}

/**
 * Watch only what we need:
 *  - `package.xml`, debounced (a `git pull` can touch many at once),
 *  - each workspace's merged `build/compile_commands.json` and the per-package
 *    `build/<pkg>/compile_commands.json` files written by a terminal build.
 */
function registerFileWatchers(context: vscode.ExtensionContext, controller: RosController): void {
    let watchers: vscode.FileSystemWatcher[] = [];
    const debouncedRefresh = debounce(() => void controller.refreshAll());
    const debouncedReload = debounce(() => void controller.reloadCompileIncludes());
    // build/, install/ and log/ contain generated package.xml copies; a colcon
    // build rewrites many of them and none affect how a source file resolves.
    const ignoredManifest = /(^|[\\/])(build|install|log|node_modules|\.git)([\\/]|$)/;
    const refreshManifest = (uri: vscode.Uri): void => {
        if (!ignoredManifest.test(uri.fsPath)) {
            debouncedRefresh();
        }
    };

    const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/package.xml');
    context.subscriptions.push(
        manifestWatcher,
        manifestWatcher.onDidCreate(refreshManifest),
        manifestWatcher.onDidChange(refreshManifest),
        manifestWatcher.onDidDelete(refreshManifest),
    );

    const installWatchers = (): void => {
        watchers.forEach((watcher) => watcher.dispose());
        watchers = controller.workspaces.flatMap((workspace) =>
            ['build/compile_commands.json', 'build/*/compile_commands.json'].map((pattern) =>
                vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(workspace.root), pattern),
                ),
            ),
        );
        for (const watcher of watchers) {
            watcher.onDidChange(debouncedReload);
            watcher.onDidCreate(debouncedReload);
            watcher.onDidDelete(debouncedReload);
        }
    };
    installWatchers();

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await controller.initialize();
            installWatchers();
        }),
        new vscode.Disposable(() => watchers.forEach((watcher) => watcher.dispose())),
    );
}

async function pickWorkspace(controller: RosController): Promise<RosWorkspace | undefined> {
    const workspaces = controller.workspaces;
    if (workspaces.length === 0) {
        showWarning(
            'no ROS 2 workspace found in this window (expected a package.xml, a src/ folder, or an install/ folder).',
        );
        return undefined;
    }
    if (workspaces.length === 1) {
        return workspaces[0];
    }
    const picked = await vscode.window.showQuickPick(
        workspaces.map((workspace) => ({
            label: vscode.workspace.asRelativePath(workspace.folder.uri, false),
            description: workspace.root,
            workspace,
        })),
        { placeHolder: 'Select a ROS 2 workspace' },
    );
    return picked?.workspace;
}

async function runBuild(
    controller: RosController,
    builder: ColconBuilder,
    options: { mineOnly?: boolean },
): Promise<void> {
    const workspace = await pickWorkspace(controller);
    if (!workspace) {
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `ROS 2: building ${path.basename(workspace.root)}`,
            cancellable: true,
        },
        async (_progress, token) => {
            const succeeded = await builder.build(workspace, options, token);
            if (!succeeded) {
                showWarning('build failed or was cancelled.');
                return;
            }
            if (await builder.merge(workspace)) {
                await controller.refreshAll();
            }
        },
    );
}

async function runBuildPackage(controller: RosController, builder: ColconBuilder): Promise<void> {
    const workspace = await pickWorkspace(controller);
    if (!workspace) {
        return;
    }

    const packages = await controller.discoverPackages(workspace);
    if (packages.length === 0) {
        showWarning('no ROS 2 packages were found in this workspace.');
        return;
    }

    const selected = await vscode.window.showQuickPick(
        packages.map((pkg: RosPackage) => ({
            label: pkg.name,
            description: path.relative(workspace.root, pkg.dir),
            pkg,
        })),
        { canPickMany: true, placeHolder: 'Select package(s) to build' },
    );
    if (!selected || selected.length === 0) {
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'ROS 2: building selected package(s)',
            cancellable: true,
        },
        async (_progress, token) => {
            const succeeded = await builder.build(
                workspace,
                { packages: selected.map((item) => item.pkg.name) },
                token,
            );
            if (!succeeded) {
                showWarning('build failed or was cancelled.');
                return;
            }
            if (await builder.merge(workspace)) {
                await controller.refreshAll();
            }
        },
    );
}

async function runMerge(controller: RosController, builder: ColconBuilder): Promise<void> {
    const workspace = await pickWorkspace(controller);
    if (!workspace) {
        return;
    }
    if (await builder.merge(workspace)) {
        await controller.refreshAll();
        void vscode.window.showInformationMessage('compile_commands.json merged.');
    }
}

async function showActivePackage(controller: RosController): Promise<void> {
    const workspace = await pickWorkspace(controller);
    if (!workspace) {
        return;
    }
    const pkg = controller.activePackage(workspace);
    if (!pkg) {
        void vscode.window.showInformationMessage(
            'No active ROS 2 package. Open a file inside a package directory.',
        );
        return;
    }
    const dependencies = pkg.dependencies.length > 0 ? pkg.dependencies.join(', ') : '—';
    const reveal = 'Reveal package.json';
    const choice = await vscode.window.showInformationMessage(
        `Active package: ${pkg.name}`,
        {
            modal: true,
            detail: `Path: ${pkg.dir}\nBuild type: ${pkg.buildType ?? 'unknown'}\nDependencies: ${dependencies}`,
        },
        reveal,
    );
    if (choice === reveal) {
        await vscode.window.showTextDocument(vscode.Uri.file(pkg.manifest));
    }
}

async function selectDistro(controller: RosController): Promise<void> {
    const installs = discoverRosInstalls();
    const current = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('rosDistro', '');
    const candidates = [
        ...new Set(
            [
                ...installs.map((install) => install.distro),
                'humble',
                'iron',
                'jazzy',
                'kilted',
                'lyrical',
                'rolling',
                current,
            ].filter(Boolean),
        ),
    ];
    const picked = await vscode.window.showQuickPick(
        candidates.map((distro) => {
            const install = installs.find((candidate) => candidate.distro === distro);
            return { label: distro, description: install?.prefix };
        }),
        { placeHolder: 'Select ROS 2 distribution (empty = auto-detect)' },
    );
    if (picked === undefined) {
        return;
    }
    await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update('rosDistro', picked.label, vscode.ConfigurationTarget.Workspace);
    await controller.refreshAll();
}
