import * as fs from 'fs';
import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';

let outputChannel: vscode.OutputChannel | undefined;

/** Lazily created output channel shared by the whole extension. */
export function output(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('ROS 2 IntelliSense');
    }
    return outputChannel;
}

export function log(message: string): void {
    output().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export async function isDirectory(target: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(target)).isDirectory();
    } catch {
        return false;
    }
}

export async function isFile(target: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(target)).isFile();
    } catch {
        return false;
    }
}

export function existsSync(target: string): boolean {
    try {
        fs.accessSync(target);
        return true;
    } catch {
        return false;
    }
}

export function isConfigurationProviderEnabled(): boolean {
    return vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>('enableConfigurationProvider', true);
}

export function showError(message: string): void {
    void vscode.window.showErrorMessage(`ROS 2 IntelliSense: ${message}`);
}

export function showWarning(message: string): void {
    void vscode.window.showWarningMessage(`ROS 2 IntelliSense: ${message}`);
}
