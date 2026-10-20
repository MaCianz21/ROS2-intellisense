import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceBrowsePaths } from './colcon';
import { EXTENSION_ID } from './constants';
import { RosWorkspace } from './rosWorkspace';
import { log } from './util';

async function readJson(uri: vscode.Uri): Promise<Record<string, any> | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, any>;
    } catch {
        return undefined;
    }
}

async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
    const text = `${JSON.stringify(value, null, 4)}\n`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

/**
 * Write the `.vscode` files that wire the C/C++ extension to this extension's
 * configuration provider. Existing files are updated non-destructively.
 */
export async function setupWorkspace(workspace: RosWorkspace): Promise<void> {
    const vscodeDir = vscode.Uri.joinPath(workspace.folder.uri, '.vscode');
    await vscode.workspace.fs.createDirectory(vscodeDir);

    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    const settings = (await readJson(settingsUri)) ?? {};
    settings['C_Cpp.default.configurationProvider'] = EXTENSION_ID;
    await writeJson(settingsUri, settings);

    const propertiesUri = vscode.Uri.joinPath(vscodeDir, 'c_cpp_properties.json');
    const properties = (await readJson(propertiesUri)) ?? {
        version: 4,
        configurations: [],
    };
    if (!Array.isArray(properties.configurations) || properties.configurations.length === 0) {
        properties.configurations = [{}];
    }

    const configuration = properties.configurations[0];
    configuration.name ??= 'ROS 2';
    // A light fallback for when the configuration provider is disabled: source
    // and include trees only (never `build/` or `install/`) plus the
    // non-recursive ROS root. The provider supplies the exact per-package list.
    const rosInclude = workspace.rosPrefix
        ? path.join(workspace.rosPrefix, 'include')
        : undefined;
    // `${workspaceFolder}` resolves to the opened folder, which is not
    // necessarily the workspace root; use an absolute path in that case.
    const rootExpr =
        workspace.root === workspace.folder.uri.fsPath ? '${workspaceFolder}' : workspace.root;
    const browsePath = workspaceBrowsePaths(workspace.root).map((value) =>
        value.startsWith(workspace.root)
            ? `${rootExpr}${value.slice(workspace.root.length)}`
            : value,
    );
    configuration.includePath ??= [
        ...browsePath,
        ...(rosInclude ? [rosInclude] : []),
    ];
    configuration.defines ??= [];
    configuration.browse ??= { path: browsePath };
    configuration.compilerPath ??= workspace.compilerPath;
    configuration.cStandard ??= 'gnu17';
    configuration.cppStandard ??= 'gnu++17';
    configuration.intelliSenseMode ??= workspace.intelliSenseMode;
    configuration.compileCommands ??=
        workspace.root === workspace.folder.uri.fsPath
            ? '${workspaceFolder}/build/compile_commands.json'
            : path.join(workspace.root, 'build', 'compile_commands.json');
    configuration.configurationProvider = EXTENSION_ID;
    await writeJson(propertiesUri, properties);

    log(`Configured IntelliSense for workspace ${workspace.root}`);

    const open = 'Open c_cpp_properties.json';
    const choice = await vscode.window.showInformationMessage(
        `ROS 2 IntelliSense configured for "${path.basename(workspace.root)}".`,
        open,
    );
    if (choice === open) {
        await vscode.window.showTextDocument(propertiesUri);
    }
}
