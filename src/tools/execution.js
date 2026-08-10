import { exec, execSync } from 'child_process';
import { isHighImpactCommand } from '../utils/system.js';
import { stripAnsi } from '../utils/terminal.js';
import { playChime } from '../utils/sound.js';
import { formatProgressLine } from '../utils/terminal.js';

function updateProgress(raw_text, color) {
	const line = formatProgressLine(raw_text, color);
	console.log(line);
}

export async function executeSystemCommand({ command, timeout_ms = 30000 }) {
	if (isHighImpactCommand(command) && !global.allow_all_high_impact) {
		updateProgress(`• High-impact action detected: "${command}"`, 'red');
		const answer = await global.askUserInRoll(`Do you want to run this command? [Y/n/a]: `);
		const norm = answer.trim().toLowerCase();
		if (norm === 'a' || norm === 'all') global.allow_all_high_impact = true;
		else if (norm !== '' && norm !== 'y' && norm !== 'yes') {
			return {
				status: 'error',
				error: 'Execution cancelled by the user.'
			};
		}
	}

	// Pre-authenticate sudo if command uses sudo and credentials are not cached
	if (command.includes('sudo')) {
		try {
			execSync('sudo -n true', { stdio: 'ignore' });
		} catch (e) {
			updateProgress(`• sudo credential caching required. Please authenticate when prompted:`, 'red');
			playChime('fingerprint');
			try {
				await global.runInteractiveSudo();
			} catch (err) {
				return {
					status: 'error',
					error: 'Sudo authentication failed.'
				};
			}
		}
	}

	return new Promise(resolve => {
		exec(command, { timeout: timeout_ms }, (error, stdout, stderr) => {
			const clean_stdout = stripAnsi(stdout || '');
			const clean_stderr = stripAnsi(stderr || '');

			const max_chars = 30000;
			let truncated_stdout = clean_stdout;
			let truncated_stderr = clean_stderr;
			let stdout_truncated = false;
			let stderr_truncated = false;

			if (clean_stdout && clean_stdout.length > max_chars) {
				truncated_stdout = clean_stdout.slice(0, max_chars) + '\n[... stdout truncated to prevent excessive token usage ...]';
				stdout_truncated = true;
			}
			if (clean_stderr && clean_stderr.length > max_chars) {
				truncated_stderr = clean_stderr.slice(0, max_chars) + '\n[... stderr truncated to prevent excessive token usage ...]';
				stderr_truncated = true;
			}

			resolve({
				stdout: truncated_stdout,
				stderr: truncated_stderr,
				stdout_truncated,
				stderr_truncated,
				exit_code: error ? error.code || 1 : 0
			});
		});
	});
}

export function runNodeScript({ code, timeout_ms = 30000 }) {
	return new Promise(resolve => {
		const child = exec('node', { timeout: timeout_ms }, (error, stdout, stderr) => {
			const clean_stdout = stripAnsi(stdout || '');
			const clean_stderr = stripAnsi(stderr || '');

			const max_chars = 30000;
			let truncated_stdout = clean_stdout;
			let truncated_stderr = clean_stderr;
			let stdout_truncated = false;
			let stderr_truncated = false;

			if (clean_stdout && clean_stdout.length > max_chars) {
				truncated_stdout = clean_stdout.slice(0, max_chars) + '\n[... stdout truncated to prevent excessive token usage ...]';
				stdout_truncated = true;
			}
			if (clean_stderr && clean_stderr.length > max_chars) {
				truncated_stderr = clean_stderr.slice(0, max_chars) + '\n[... stderr truncated to prevent excessive token usage ...]';
				stderr_truncated = true;
			}

			resolve({
				stdout: truncated_stdout,
				stderr: truncated_stderr,
				stdout_truncated,
				stderr_truncated,
				exit_code: error ? error.code || 1 : 0
			});
		});

		if (child.stdin) {
			child.stdin.write(code);
			child.stdin.end();
		}
	});
}

export function runNodeSyntaxCheck(file_path) {
	if (!file_path.toLowerCase().endsWith('.js')) {
		return null;
	}
	try {
		execSync(`node -c ${JSON.stringify(file_path)}`, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		return {
			status: 'passed',
			output: 'Syntax check passed'
		};
	} catch (err) {
		const error_msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
		return {
			status: 'failed',
			error: error_msg.trim()
		};
	}
}
