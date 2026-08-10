import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { stripAnsi, formatProgressLine } from './terminal.js';
import { playChime } from './sound.js';
import { writeDetails } from './logger.js';

// Local progress updater matching index.js's implementation
function updateProgress(raw_text, color) {
	const line = formatProgressLine(raw_text, color);
	console.log(line);
}

// Find project root
export function findProjectRoot(start_dir = process.cwd()) {
	const root_indicators = ['.git', 'package.json', 'cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Notes.md'];
	let current_dir = start_dir;
	while (true) {
		for (const indicator of root_indicators) {
			if (fs.existsSync(path.join(current_dir, indicator))) {
				return current_dir;
			}
		}
		const parent_dir = path.dirname(current_dir);
		if (parent_dir === current_dir) {
			break;
		}
		current_dir = parent_dir;
	}
	return null;
}

// Get kitty screen text
export function getKittyScreenText() {
	try {
		const output = execSync('kitty @ get-text', {
			timeout: 500,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		if (output) {
			const lines = output.split('\n');
			return lines.slice(-100).join('\n');
		}
	} catch (err) {
		// Ignore error (e.g. remote control disabled, or not in kitty)
	}
	return null;
}

// Read terminal buffer history
export function readTerminalBuffer() {
	const raw = getKittyScreenText();
	const buffer = raw ? stripAnsi(raw) : null;
	if (buffer === null) {
		return {
			status: 'error',
			message: 'Could not read terminal buffer (e.g. remote control disabled, or not in kitty)'
		};
	}
	return {
		status: 'success',
		buffer
	};
}

// Run project dry-run command if possible
export function runProjectDryRun(modified_file_path) {
	const project_root = findProjectRoot(path.dirname(modified_file_path));
	if (!project_root) {
		return null;
	}

	// Node project
	const pkg_json_path = path.join(project_root, 'package.json');
	if (fs.existsSync(pkg_json_path)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkg_json_path, 'utf8'));
			let command = null;
			if (pkg.scripts) {
				if (pkg.scripts.lint) {
					command = 'npm run lint';
				} else if (pkg.scripts.test) {
					command = 'npm test';
				} else if (pkg.scripts.build) {
					command = 'npm run build';
				}
			}

			const tsconfig_path = path.join(project_root, 'tsconfig.json');
			if (!command && fs.existsSync(tsconfig_path)) {
				command = 'npx tsc --noEmit';
			}

			if (command) {
				updateProgress(`• Running dry-run validation: ${command}`);
				writeDetails(`[Dry-Run] Executing "${command}" in ${project_root}...`);
				try {
					const stdout = execSync(command, {
						cwd: project_root,
						encoding: 'utf-8',
						stdio: ['ignore', 'pipe', 'pipe']
					});
					writeDetails(`[Dry-Run] Success:\n${stdout}`);
					updateProgress(`• Dry-run validation passed`);
					return {
						dry_run: {
							command,
							status: 'passed',
							output: stdout.trim()
						}
					};
				} catch (err) {
					const error_msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
					writeDetails(`[Dry-Run] Failed:\n${error_msg}`);
					updateProgress(`• Dry-run validation failed`);
					playChime('error');
					return {
						dry_run: {
							command,
							status: 'failed',
							error: error_msg.trim()
						}
					};
				}
			}
		} catch (e) {
			writeDetails(`[Dry-Run] Error parsing package.json: ${e.message}`);
		}
	}

	// Rust / Cargo project
	const cargo_toml_path = path.join(project_root, 'Cargo.toml');
	if (fs.existsSync(cargo_toml_path)) {
		const command = 'cargo check';
		updateProgress(`• Running dry-run validation: ${command}`);
		writeDetails(`[Dry-Run] Executing "${command}" in ${project_root}...`);
		try {
			const stdout = execSync(command, {
				cwd: project_root,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
			writeDetails(`[Dry-Run] Success:\n${stdout}`);
			updateProgress(`• Dry-run validation passed`);
			return {
				dry_run: {
					command,
					status: 'passed',
					output: stdout.trim()
				}
			};
		} catch (err) {
			const error_msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
			writeDetails(`[Dry-Run] Failed:\n${error_msg}`);
			updateProgress(`• Dry-run validation failed`);
			playChime('error');
			return {
				dry_run: {
					command,
					status: 'failed',
					error: error_msg.trim()
				}
			};
		}
	}

	return null;
}

// Check if a command is high-impact
export function isHighImpactCommand(command) {
	const normalized = command.toLowerCase();

	if (normalized.includes('sudo')) return true;
	if (normalized.includes('pacman') || normalized.includes('yay') || normalized.includes('paru')) return true;

	if (normalized.includes('systemctl') && (normalized.includes('start') || normalized.includes('stop') || normalized.includes('restart') || normalized.includes('enable') || normalized.includes('disable'))) {
		return true;
	}

	if (/\bgit\s+(add|commit)\b/.test(normalized)) {
		return true;
	}

	if (normalized.includes('/etc/') || normalized.includes('/sys/') || normalized.includes('/boot/') || normalized.includes('/usr/lib/systemd')) {
		const is_write = />|>>|tee|rm\s|mv\s|cp\s|chmod|chown|edit|mkdir|touch/g.test(command);
		if (is_write) return true;
	}

	return false;
}

export function getOSDescription() {
	try {
		if (process.platform === 'linux') {
			if (fs.existsSync('/etc/os-release')) {
				const release = fs.readFileSync('/etc/os-release', 'utf8');
				const name_match = /^PRETTY_NAME="([^"]+)"/m.exec(release) || /^NAME="([^"]+)"/m.exec(release);
				if (name_match) {
					return name_match[1];
				}
			}
			return 'Linux';
		}
		if (process.platform === 'darwin') {
			return 'macOS';
		}
		if (process.platform === 'win32') {
			return 'Windows';
		}
		return `${os.type()} ${os.release()}`;
	} catch (e) {
		return 'Linux';
	}
}

export function findNonoFiles(startDir) {
	const files = [];
	let currentDir = path.resolve(startDir);
	while (true) {
		const filePath = path.join(currentDir, 'nono.md');
		if (fs.existsSync(filePath)) {
			try {
				const stat = fs.statSync(filePath);
				if (stat.isFile()) {
					files.push(filePath);
				}
			} catch (e) {}
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}
	return files;
}
