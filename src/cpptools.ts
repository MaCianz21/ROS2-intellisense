/**
 * Minimal, self-contained bindings for the Microsoft C/C++ extension API
 * (https://github.com/microsoft/vscode-cpptools-api).
 *
 * The API is MIT-licensed, Copyright (c) Microsoft Corporation. See
 * THIRD_PARTY_NOTICES.md for the upstream notice.
 *
 * We talk to the API through `ms-vscode.cpptools`'s exports instead of a
 * runtime npm dependency so that the packaged extension stays dependency-free.
 */
import * as vscode from 'vscode';

export const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';

/** API version requested from cpptools. v2 adds `notifyReady`. */
export const CPPTOOLS_API_VERSION = 2;

export interface SourceFileConfiguration {
    includePath: string[];
    defines: string[];
    compilerPath?: string;
    standard?: string;
    intelliSenseMode?: string;
    forcedInclude?: string[];
}

export interface SourceFileConfigurationItem {
    uri: vscode.Uri | string;
    configuration: SourceFileConfiguration;
}

export interface WorkspaceBrowseConfiguration {
    browsePath: string[];
    compilerPath?: string;
    standard?: string;
}

export interface CustomConfigurationProvider extends vscode.Disposable {
    readonly name: string;
    readonly extensionId: string;
    canProvideConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken): Thenable<boolean>;
    provideConfigurations(
        uris: vscode.Uri[],
        token?: vscode.CancellationToken,
    ): Thenable<SourceFileConfigurationItem[]>;
    canProvideBrowseConfiguration(token?: vscode.CancellationToken): Thenable<boolean>;
    provideBrowseConfiguration(
        token?: vscode.CancellationToken,
    ): Thenable<WorkspaceBrowseConfiguration | null>;
    canProvideBrowseConfigurationsPerFolder(
        token?: vscode.CancellationToken,
    ): Thenable<boolean>;
    provideFolderBrowseConfiguration(
        uri: vscode.Uri,
        token?: vscode.CancellationToken,
    ): Thenable<WorkspaceBrowseConfiguration | null>;
}

export interface CppToolsApi extends vscode.Disposable {
    getVersion?(): number;
    registerCustomConfigurationProvider(provider: CustomConfigurationProvider): void;
    notifyReady?(provider: CustomConfigurationProvider): void;
    didChangeCustomConfiguration(provider: CustomConfigurationProvider): void;
    didChangeCustomBrowseConfiguration?(provider: CustomConfigurationProvider): void;
}

/**
 * Resolve the C/C++ extension API, activating the extension if necessary.
 * Returns `undefined` when the C/C++ extension is missing or too old.
 */
export async function getCppToolsApi(version: number): Promise<CppToolsApi | undefined> {
    const extension = vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID);
    if (!extension) {
        return undefined;
    }

    // NOTE: never name this local `exports` — it would shadow CommonJS's
    // module `exports` and throw "Cannot access 'exports' before initialization".
    let extensionExports: unknown = extension.exports;
    if (!extension.isActive) {
        try {
            extensionExports = await extension.activate();
        } catch {
            return undefined;
        }
    }

    const candidate = extensionExports as { getApi?: (v: number) => CppToolsApi } &
        Partial<CppToolsApi>;
    if (typeof candidate.getApi === 'function') {
        try {
            return candidate.getApi(version);
        } catch {
            try {
                return candidate.getApi(1);
            } catch {
                return undefined;
            }
        }
    }

    // Very old cpptools exposed the API directly on exports.
    if (typeof candidate.registerCustomConfigurationProvider === 'function') {
        return candidate as CppToolsApi;
    }

    return undefined;
}
