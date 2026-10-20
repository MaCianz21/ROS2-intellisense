/*
 * Headless activation smoke test.
 *
 * Loads the compiled extension with a stubbed `vscode` module, activates it
 * against a real temporary colcon workspace, and asserts that:
 *   - activation does not throw (catches module-scope errors such as the
 *     "Cannot access 'exports' before initialization" class of bug),
 *   - all commands and the status bar are registered,
 *   - the C/C++ configuration provider is wired up and returns the active
 *     package's include dirs (with no recursive globs).
 *
 * Usage: npm run smoke
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const OUT_DIR = path.join(__dirname, '..', 'out');

const EXPECTED_COMMANDS = [
    'ros2IntelliSense.build',
    'ros2IntelliSense.buildPackage',
    'ros2IntelliSense.buildMine',
    'ros2IntelliSense.merge',
    'ros2IntelliSense.refresh',
    'ros2IntelliSense.showActivePackage',
    'ros2IntelliSense.setupWorkspace',
    'ros2IntelliSense.selectDistro',
];

function makeWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-intellisense-smoke-'));
    const packageDir = path.join(root, 'src', 'demo_pkg');
    fs.mkdirSync(path.join(packageDir, 'include'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(packageDir, 'package.xml'),
        `<?xml version="1.0"?>
<package format="3">
  <name>demo_pkg</name>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <depend>rclcpp</depend>
</package>`,
    );
    const sourceFile = path.join(packageDir, 'src', 'demo_node.cpp');
    fs.writeFileSync(sourceFile, 'int main() { return 0; }\n');

    // A terminal-style build writes one database per package, not a merged file.
    const generatedInclude = path.join(root, 'build', 'generated', 'include');
    fs.mkdirSync(generatedInclude, { recursive: true });
    const buildDir = path.join(root, 'build', 'demo_pkg');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
        path.join(buildDir, 'compile_commands.json'),
        JSON.stringify([
            {
                directory: root,
                file: sourceFile,
                arguments: [
                    'c++',
                    '-DFOO=1',
                    '-std=gnu++20',
                    '-I',
                    generatedInclude,
                    '-c',
                    sourceFile,
                ],
            },
        ]),
    );

    return { root, packageDir, sourceFile, generatedInclude };
}

/** A repository that is the package itself: package.xml at the root. */
function makePackageWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-intellisense-pkg-'));
    fs.mkdirSync(path.join(root, 'include', 'demo_pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'package.xml'),
        `<?xml version="1.0"?>
<package format="3">
  <name>demo_pkg</name>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <depend>rclcpp</depend>
</package>`,
    );
    const sourceFile = path.join(root, 'src', 'demo_node.cpp');
    fs.writeFileSync(sourceFile, 'int main() { return 0; }\n');
    return { root, packageDir: root, sourceFile };
}

/** A repository with packages directly under the root (no colcon `src/`). */
function makeMultiPackageWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-intellisense-multi-'));
    const packageDir = path.join(root, 'pkg_a');
    fs.mkdirSync(path.join(packageDir, 'include', 'pkg_a'), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(packageDir, 'package.xml'),
        `<?xml version="1.0"?>
<package format="3">
  <name>pkg_a</name>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <depend>rclcpp</depend>
</package>`,
    );
    const sourceFile = path.join(packageDir, 'src', 'node.cpp');
    fs.writeFileSync(sourceFile, 'int main() { return 0; }\n');
    return { root, packageDir, sourceFile };
}

function cppToolsExtension(recorder) {
    return () => ({
        isActive: true,
        exports: {
            getApi: () => ({
                getVersion: () => 2,
                registerCustomConfigurationProvider: (provider) => {
                    recorder.provider = provider;
                    recorder.registered = true;
                },
                notifyReady: () => {
                    recorder.ready = true;
                },
                didChangeCustomConfiguration: () => {},
                didChangeCustomBrowseConfiguration: () => {},
                dispose() {},
            }),
        },
    });
}

function createStub(options) {
    const calls = {
        commands: [],
        activeEditorListener: undefined,
        settingUpdates: [],
        messages: [],
        fileWrites: [],
    };

    class Disposable {
        constructor(fn) {
            this._fn = fn;
        }
        dispose() {
            if (this._fn) {
                this._fn();
            }
        }
    }

    class EventEmitter {
        constructor() {
            this._listeners = [];
        }
        get event() {
            return (listener) => {
                this._listeners.push(listener);
                return { dispose() {} };
            };
        }
        fire(value) {
            this._listeners.forEach((listener) => listener(value));
        }
        dispose() {
            this._listeners = [];
        }
    }

    class RelativePattern {
        constructor(base, pattern) {
            this.base = base;
            this.pattern = pattern;
        }
    }

    class Uri {
        constructor(fsPath) {
            this.fsPath = fsPath;
            this.scheme = 'file';
        }
        static file(p) {
            return new Uri(p);
        }
        static joinPath(uri, ...segments) {
            return new Uri(path.join(uri.fsPath, ...segments));
        }
    }

    const disposable = () => ({ dispose() {} });
    const watcher = {
        onDidCreate: disposable,
        onDidChange: disposable,
        onDidDelete: disposable,
        dispose() {},
    };

    const statusBar = {
        text: '',
        tooltip: '',
        command: '',
        visible: false,
        show() {
            this.visible = true;
        },
        hide() {
            this.visible = false;
        },
        dispose() {},
    };

    const folders = options.workspaceFolders || [];
    const configuration = {
        get: (key, fallback) =>
            key === 'default.configurationProvider' && options.configuredProvider
                ? options.configuredProvider
                : fallback,
        update: async (key, value, target) => {
            calls.settingUpdates.push({ key, value, target });
        },
    };

    const vscode = {
        Disposable,
        EventEmitter,
        RelativePattern,
        Uri,
        StatusBarAlignment: { Left: 1, Right: 2 },
        ProgressLocation: { Notification: 15, Window: 10 },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        window: {
            activeTextEditor: undefined,
            createStatusBarItem: () => statusBar,
            createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
            onDidChangeActiveTextEditor: (listener) => {
                calls.activeEditorListener = listener;
                return disposable();
            },
            showInformationMessage: async (message) => {
                calls.messages.push(message);
                return options.providerChoice;
            },
            showWarningMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showQuickPick: async () => undefined,
            showTextDocument: async () => ({}),
            withProgress: async (_options, task) =>
                task(
                    { report() {} },
                    { isCancellationRequested: false, onCancellationRequested: disposable },
                ),
        },
        workspace: {
            workspaceFolders: folders,
            getWorkspaceFolder: (uri) =>
                folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
            getConfiguration: () => configuration,
            onDidChangeConfiguration: disposable,
            onDidChangeWorkspaceFolders: disposable,
            onDidSaveTextDocument: disposable,
            createFileSystemWatcher: () => watcher,
            findFiles: async () => [],
            asRelativePath: (value) => String(value),
            fs: {
                createDirectory: async () => {},
                readFile: async () =>
                    Buffer.from(options.cppProperties ? JSON.stringify(options.cppProperties) : ''),
                writeFile: async (uri, contents) => {
                    calls.fileWrites.push({
                        fsPath: uri.fsPath,
                        contents: Buffer.from(contents).toString('utf8'),
                    });
                },
            },
        },
        commands: {
            registerCommand: (id, fn) => {
                calls.commands.push(id);
                void fn;
                return disposable();
            },
            executeCommand: async () => undefined,
        },
        extensions: {
            getExtension: (id) => (options.getExtension ? options.getExtension(id) : undefined),
        },
    };

    return { vscode, calls, statusBar };
}

function loadExtension(vscodeStub) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(OUT_DIR)) {
            delete require.cache[key];
        }
    }
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, ...rest) {
        if (request === 'vscode') {
            return vscodeStub;
        }
        return originalLoad.call(this, request, ...rest);
    };
    try {
        return require(path.join(OUT_DIR, 'extension.js'));
    } finally {
        Module._load = originalLoad;
    }
}

async function activateWith(options) {
    const stub = createStub(options);
    const extension = loadExtension(stub.vscode);
    assert.strictEqual(typeof extension.activate, 'function', 'activate is exported');

    const context = {
        subscriptions: [],
        extensionUri: stub.vscode.Uri.file(path.join(__dirname, '..')),
        extensionPath: path.join(__dirname, '..'),
        workspaceState: {
            get: () => undefined,
            update: async () => {},
        },
    };
    await extension.activate(context);

    for (const id of EXPECTED_COMMANDS) {
        assert.ok(stub.calls.commands.includes(id), `registered command ${id}`);
    }
    return stub;
}

async function main() {
    const workspace = makeWorkspace();
    const folder = { uri: { fsPath: workspace.root, scheme: 'file' }, name: 'ws', index: 0 };

    const recorder = { provider: undefined, registered: false, ready: false };
    const stub = await activateWith({
        workspaceFolders: [folder],
        getExtension: cppToolsExtension(recorder),
    });

    assert.strictEqual(stub.statusBar.visible, true, 'status bar item is shown in a ROS workspace');
    assert.ok(recorder.registered, 'provider registered with cpptools');
    assert.ok(recorder.ready, 'cpptools notified that the provider is ready');

    // The extension selects itself when no other provider is configured, and
    // reads the per-package compile database in the background.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
        stub.calls.settingUpdates.some(
            (update) =>
                update.key === 'default.configurationProvider' &&
                update.value === 'macianz.ros2-intellisense',
        ),
        'provider selected automatically when no other provider is configured',
    );

    // Simulate the user opening a file inside the package.
    assert.strictEqual(typeof stub.calls.activeEditorListener, 'function', 'editor listener wired');
    stub.calls.activeEditorListener({
        document: { uri: { scheme: 'file', fsPath: workspace.sourceFile } },
    });
    assert.ok(
        stub.statusBar.text.includes('demo_pkg'),
        `status bar shows the active package (got "${stub.statusBar.text}")`,
    );

    // The provider must produce a concrete include path for that file.
    const fileUri = { scheme: 'file', fsPath: workspace.sourceFile };
    assert.strictEqual(
        await recorder.provider.canProvideConfiguration(fileUri),
        true,
        'provider can serve the source file',
    );
    const items = await recorder.provider.provideConfigurations([fileUri]);
    assert.strictEqual(items.length, 1, 'provider returns one configuration');
    const includePath = items[0].configuration.includePath;
    assert.ok(
        includePath.includes(path.join(workspace.packageDir, 'include')),
        'include path contains the active package include dir',
    );
    assert.ok(
        includePath.includes('/opt/ros/jazzy/include'),
        'include path contains the non-recursive ROS root',
    );
    assert.ok(
        !includePath.some((p) => p.endsWith('/**')),
        'include path contains no recursive globs',
    );
    assert.ok(
        includePath.includes(workspace.generatedInclude),
        'terminal build include is picked up without a manual merge',
    );
    assert.ok(
        items[0].configuration.defines.includes('FOO=1'),
        'per-file defines are forwarded from build/<pkg>/compile_commands.json',
    );
    assert.strictEqual(items[0].configuration.standard, 'gnu++20', 'per-file standard set');

    // Browse includes source directories (symbol search / Find All References).
    const browse = await recorder.provider.provideFolderBrowseConfiguration(folder.uri);
    assert.ok(browse, 'browse configuration available');
    assert.ok(
        browse.browsePath.includes(path.join(workspace.root, 'src', '**')),
        'browse path covers src/**',
    );

    // A ROS header opened via go-to-definition is served by the same workspace.
    if (fs.existsSync('/opt/ros/jazzy/include')) {
        const rosHeader = {
            scheme: 'file',
            fsPath: '/opt/ros/jazzy/include/rclcpp/rclcpp/rclcpp.hpp',
        };
        assert.strictEqual(
            await recorder.provider.canProvideConfiguration(rosHeader),
            true,
            'provider serves headers inside the ROS install prefix',
        );
        const rosItems = await recorder.provider.provideConfigurations([rosHeader]);
        assert.strictEqual(rosItems.length, 1, 'ROS header gets a configuration');
        assert.ok(
            rosItems[0].configuration.includePath.includes('/opt/ros/jazzy/include'),
            'ROS header configuration contains the ROS roots',
        );
    }

    // A repository that is the package itself (package.xml at the root).
    const packageWorkspace = makePackageWorkspace();
    const packageFolder = {
        uri: { fsPath: packageWorkspace.root, scheme: 'file' },
        name: 'pkg',
        index: 0,
    };
    const packageRecorder = { provider: undefined, registered: false, ready: false };
    const packageStub = await activateWith({
        workspaceFolders: [packageFolder],
        getExtension: cppToolsExtension(packageRecorder),
    });
    packageStub.calls.activeEditorListener({
        document: { uri: { scheme: 'file', fsPath: packageWorkspace.sourceFile } },
    });
    assert.ok(
        packageStub.statusBar.text.includes('demo_pkg'),
        'package-at-root repo is detected',
    );
    const packageItems = await packageRecorder.provider.provideConfigurations([
        { scheme: 'file', fsPath: packageWorkspace.sourceFile },
    ]);
    assert.ok(
        packageItems[0].configuration.includePath.includes(
            path.join(packageWorkspace.packageDir, 'include'),
        ),
        'package-at-root include path is served',
    );
    const packageBrowse = await packageRecorder.provider.provideFolderBrowseConfiguration(
        packageFolder.uri,
    );
    assert.ok(
        packageBrowse.browsePath.includes(path.join(packageWorkspace.root, 'include', '**')),
        'package-at-root browse path covers include/**',
    );

    // A repository with packages directly under the root (no colcon `src/`).
    const multiWorkspace = makeMultiPackageWorkspace();
    const multiFolder = {
        uri: { fsPath: multiWorkspace.root, scheme: 'file' },
        name: 'multi',
        index: 0,
    };
    const multiRecorder = { provider: undefined, registered: false, ready: false };
    const multiStub = await activateWith({
        workspaceFolders: [multiFolder],
        getExtension: cppToolsExtension(multiRecorder),
    });
    multiStub.calls.activeEditorListener({
        document: { uri: { scheme: 'file', fsPath: multiWorkspace.sourceFile } },
    });
    assert.ok(
        multiStub.statusBar.text.includes('pkg_a'),
        'multi-package repo without src/ is detected',
    );
    const multiBrowse = await multiRecorder.provider.provideFolderBrowseConfiguration(
        multiFolder.uri,
    );
    assert.ok(
        multiBrowse.browsePath.includes(path.join(multiWorkspace.packageDir, 'include', '**')),
        'multi-package browse path covers the package include/**',
    );

    // A workspace that already uses CMake Tools must not be overridden silently.
    const conflictRecorder = { provider: undefined, registered: false, ready: false };
    const conflictStub = await activateWith({
        workspaceFolders: [folder],
        configuredProvider: 'ms-vscode.cmake-tools',
        getExtension: cppToolsExtension(conflictRecorder),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
        conflictStub.calls.messages.some((message) => message.includes('ms-vscode.cmake-tools')),
        'conflicting provider is announced',
    );
    assert.strictEqual(
        conflictStub.calls.settingUpdates.length,
        0,
        'conflicting provider is not overridden when the prompt is dismissed',
    );

    // Accepting the prompt rewrites both settings and c_cpp_properties.json.
    const switchRecorder = { provider: undefined, registered: false, ready: false };
    const switchStub = await activateWith({
        workspaceFolders: [folder],
        configuredProvider: 'ms-vscode.cmake-tools',
        providerChoice: 'Use ROS 2 IntelliSense',
        cppProperties: {
            version: 4,
            configurations: [
                { name: 'Linux', configurationProvider: 'ms-vscode.cmake-tools' },
            ],
        },
        getExtension: cppToolsExtension(switchRecorder),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
        switchStub.calls.fileWrites.some(
            (write) =>
                write.fsPath.endsWith('.vscode/settings.json') &&
                write.contents.includes('macianz.ros2-intellisense'),
        ),
        'accepting the prompt rewrites .vscode/settings.json',
    );
    assert.ok(
        switchStub.calls.fileWrites.some(
            (write) =>
                write.fsPath.endsWith('.vscode/c_cpp_properties.json') &&
                write.contents.includes('macianz.ros2-intellisense'),
        ),
        'accepting the prompt rewrites c_cpp_properties.json',
    );

    // A non-ROS project with a bare build/ folder is not claimed.
    const genericRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-intellisense-generic-'));
    fs.mkdirSync(path.join(genericRoot, 'build'), { recursive: true });
    const genericStub = await activateWith({
        workspaceFolders: [
            { uri: { fsPath: genericRoot, scheme: 'file' }, name: 'generic', index: 0 },
        ],
        getExtension: cppToolsExtension({
            provider: undefined,
            registered: false,
            ready: false,
        }),
    });
    assert.strictEqual(
        genericStub.statusBar.visible,
        false,
        'bare build/ is not a ROS workspace',
    );
    fs.rmSync(genericRoot, { recursive: true, force: true });

    // And it must survive a missing C/C++ extension.
    await activateWith({ workspaceFolders: [folder], getExtension: () => undefined });

    fs.rmSync(workspace.root, { recursive: true, force: true });
    fs.rmSync(packageWorkspace.root, { recursive: true, force: true });
    fs.rmSync(multiWorkspace.root, { recursive: true, force: true });
    console.log('Smoke test passed: activation, commands, status bar and provider all work.');
}

main().catch((error) => {
    console.error('Smoke test FAILED:');
    console.error(error);
    process.exit(1);
});
