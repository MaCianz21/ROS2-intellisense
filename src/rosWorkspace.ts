import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { looksLikeRosWorkspace } from './colcon';
import { CONFIG_SECTION, CPPTOOLS_CONFIG_SECTION } from './constants';
import { discoverRosInstalls, resolveRosInstall } from './rosEnvironment';
import { detectCompilerPath, detectPlatform, intelliSenseModeFor, RosPlatform } from './toolchain';
import { existsSync, isDirectory, log } from './util';

export { detectCompilerPath, detectPlatform, intelliSenseModeFor } from './toolchain';
export type { RosPlatform } from './toolchain';

export interface RosWorkspace {
    readonly folder: vscode.WorkspaceFolder;
    readonly root: string;
    readonly srcDir: string;
    readonly buildDir: string;
    readonly installDir: string;
    /** Merged IntelliSense database written by this extension / the build script. */
    readonly mergeFile: string;
    readonly distro: string;
    /**
     * ROS 2 install prefix (`/opt/ros/jazzy`, a RoboStack/conda environment, …).
     * Empty when no ROS installation was found; the workspace is still usable
     * for project/compile_commands.json-only IntelliSense.
     */
    readonly rosPrefix: string;
    readonly platform: RosPlatform;
    readonly compilerPath: string;
    readonly intelliSenseMode: string;
}

/** Distributions found in the sourced environment or under `/opt/ros`. */
export function listRosDistros(): string[] {
    const distros = new Set(discoverRosInstalls().map((install) => install.distro));
    return [...distros].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Build a `RosWorkspace` for a VS Code workspace folder, or return `undefined`
 * when the folder does not look like a ROS 2 workspace.
 *
 * Accepted layouts: a colcon workspace (`src/`, `build/`, `install/`), a repo
 * that is the package itself (`package.xml` at the root), and a repo that keeps
 * packages directly under the root. `root` defaults to the folder itself but
 * may point at a nested workspace root discovered with
 * {@link discoverNestedWorkspaces}.
 */
export async function loadWorkspace(
    folder: vscode.WorkspaceFolder,
    root: string = folder.uri.fsPath,
): Promise<RosWorkspace | undefined> {
    const srcDir = path.join(root, 'src');
    const buildDir = path.join(root, 'build');
    const installDir = path.join(root, 'install');
    const envFile = path.join(root, '.ros-intellisense.env');

    const looksLikeWorkspace =
        (await isDirectory(srcDir)) ||
        ((await isDirectory(buildDir)) && (await isDirectory(path.join(root, 'log')))) ||
        (await isDirectory(installDir)) ||
        existsSync(envFile) ||
        looksLikeRosWorkspace(root);

    if (!looksLikeWorkspace) {
        return undefined;
    }

    let envFileContents: string | undefined;
    if (existsSync(envFile)) {
        try {
            envFileContents = await fs.promises.readFile(envFile, 'utf8');
        } catch {
            envFileContents = undefined;
        }
    }

    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const install = resolveRosInstall({
        configuredPrefix: configuration.get<string>('rosPrefix', ''),
        configuredDistro: configuration.get<string>('rosDistro', ''),
        envFileContents,
    });
    if (!install) {
        log(
            'No ROS 2 installation detected. Source your ROS environment or set ros2IntelliSense.rosPrefix.',
        );
    }

    const platform = detectPlatform();
    const compilerPath = detectCompilerPath(platform, {
        configured: configuration.get<string>('compilerPath', ''),
        cppToolsDefault: vscode.workspace
            .getConfiguration(CPPTOOLS_CONFIG_SECTION)
            .get<string>('default.compilerPath', ''),
    });

    return {
        folder,
        root,
        srcDir,
        buildDir,
        installDir,
        mergeFile: path.join(buildDir, 'compile_commands.json'),
        distro: install?.distro ?? '',
        rosPrefix: install?.prefix ?? '',
        platform,
        compilerPath,
        intelliSenseMode: intelliSenseModeFor(platform, compilerPath),
    };
}
