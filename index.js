#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec, execSync, spawn } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// Load environment variables from the directory of this script or fallback locations
const dir_name = path.dirname(fileURLToPath(import.meta.url));
process.env.DOTENV_LOG_LEVEL = 'none';
process.env.DOTENVX_LOG_LEVEL = 'none';
dotenv.config({ path: path.join(dir_name, '.env'), quiet: true });
dotenv.config({ path: path.join(os.homedir(), '.config', 'nono', '.env'), quiet: true });
dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });

const api_key = process.env.GEMINI_API_KEY;
const model_name = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const default_volume = process.env.NONO_VOLUME ? parseFloat(process.env.NONO_VOLUME) : 0.6;
const volume_scale = isNaN(default_volume) ? 0.6 : Math.max(0, Math.min(1, default_volume));

if (!api_key && process.argv[2] !== '--details' && process.argv[2] !== '--test-audio') {
	console.error('\x1b[31mError: GEMINI_API_KEY is not set.\x1b[0m');
	console.error('Please configure your GEMINI_API_KEY in a .env file.');
	process.exit(1);
}

const ai = api_key ? new GoogleGenAI({ apiKey: api_key }) : null;

// Global Progress & Logging State
let start_time = Date.now();
let details_path = '';

function writeDetails(text) {
	if (details_path) {
		fs.appendFileSync(details_path, text + '\n', 'utf8');
	}
}

function formatProgressLine(text) {
	let ansi_prefix = '\x1b[90m'; // Default gray
	if (text.includes('High-impact') || text.includes('caching required')) {
		ansi_prefix = '\x1b[31m'; // Red
	}
	const ansi_suffix = '\x1b[0m';

	let raw = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	return `${ansi_prefix}${raw}${ansi_suffix}`;
}

// Helper to format markdown text beautifully for the terminal output
function formatMarkdownForTerminal(md) {
	if (!md) return '';
	const lines = md.split('\n');
	const formatted_lines = [];
	let in_code_block = false;

	for (let line of lines) {
		// Handle Code Block delimiters
		if (line.trim().startsWith('```')) {
			in_code_block = !in_code_block;
			continue;
		}

		if (in_code_block) {
			// Style code block lines: dim gray with a left border
			formatted_lines.push(`  \x1b[90m│\x1b[0m  \x1b[37m${line}\x1b[0m`);
			continue;
		}

		// Handle Headers: convert ### Title to Bold Purple
		const header_match = /^#{1,6}\s+(.*)$/.exec(line);
		if (header_match) {
			const header_text = header_match[1];
			formatted_lines.push(`\x1b[1;35m${header_text}\x1b[0m`);
			continue;
		}

		// Handle Unordered List Items: convert * item or - item to • item
		const list_match = /^(\s*)[-*]\s+(.*)$/.exec(line);
		if (list_match) {
			const indent = list_match[1];
			const content = list_match[2];
			line = `${indent}• ${content}`;
		}

		// Process inline styles
		// 1. Inline code: `code` -> cyan
		line = line.replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m');

		// 2. Bold: **text** -> Bold
		line = line.replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[0m');

		// 3. Italics: *text* or _text_ -> Underline
		line = line.replace(/\*([^*]+)\*/g, '\x1b[4m$1\x1b[0m');
		line = line.replace(/_([^_]+)_/g, '\x1b[4m$1\x1b[0m');

		formatted_lines.push(line);
	}

	return formatted_lines.join('\n');
}

function updateProgress(raw_text) {
	const line = formatProgressLine(raw_text);
	console.log(line);
}

function clearProgress() {
	// No-op since we don't roll/clear progress lines anymore
}

function finishProgress(final_text) {
	clearProgress();
	const elapsed = Math.round((Date.now() - start_time) / 1000);
	console.log(`\x1b[90m• Worked for ${elapsed}s\x1b[0m`);
	const formatted = formatMarkdownForTerminal(final_text.trim());
	console.log(`\x1b[35m✦\x1b[0m ${formatted}`);
	playChime('complete');
	writeDetails(`\n[Final Message]\n✦ ${final_text.trim()}`);
}

function finishProgressError(err_msg) {
	clearProgress();
	const elapsed = Math.round((Date.now() - start_time) / 1000);
	console.log(`\x1b[90m• Worked for ${elapsed}s\x1b[0m`);
	console.log(`\x1b[31m✦ Error: ${err_msg}\x1b[0m`);
	playChime('error');
	writeDetails(`\n[Fatal Error]\n${err_msg}`);
}

// Helper to generate a WAV file buffer containing pure synthesized tones
function generateChimeWav(tones, sample_rate = 44100) {
	let max_duration = 0;
	for (const tone of tones) {
		max_duration = Math.max(max_duration, tone.start + tone.duration);
	}

	const num_samples = Math.floor(sample_rate * max_duration);
	const buffer = Buffer.alloc(44 + num_samples * 2); // 16-bit mono PCM

	const samples = new Float32Array(num_samples);

	for (const tone of tones) {
		const start_sample = Math.floor(sample_rate * tone.start);
		const tone_samples = Math.floor(sample_rate * tone.duration);
		const freq = tone.freq;
		const type = tone.type || 'sine';
		const gain = tone.gain !== undefined ? tone.gain : 0.15;

		for (let i = 0; i < tone_samples; i++) {
			const idx = start_sample + i;
			if (idx >= num_samples) break;

			const t = i / sample_rate;
			let val = 0;

			if (type === 'sine') {
				val = Math.sin(2 * Math.PI * freq * t);
			} else if (type === 'triangle') {
				const period = 1 / freq;
				const phase = (t % period) / period;
				val = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
			}

			// Apply smooth fade out to avoid clicks
			const fade_out_start = tone_samples - Math.floor(sample_rate * 0.04); // 40ms fade
			if (i > fade_out_start) {
				const fade_ratio = (tone_samples - i) / (tone_samples - fade_out_start);
				val *= fade_ratio;
			}

			samples[idx] += val * gain;
		}
	}

	const data_size = num_samples * 2;
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + data_size, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // Mono
	buffer.writeUInt32LE(sample_rate, 24);
	buffer.writeUInt32LE(sample_rate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(data_size, 40);

	for (let i = 0; i < num_samples; i++) {
		const sample = Math.max(-32768, Math.min(32767, Math.floor(samples[i] * 32767)));
		buffer.writeInt16LE(sample, 44 + i * 2);
	}

	return buffer;
}

// Helper to play synthesized chimes matching Nono-Terminal
function playChime(type) {
	process.stdout.write('\x07');

	let tones = [];
	if (type === 'question' || type === 'fingerprint' || type === 'user_interaction_needed') {
		// Soft two-tone major 6th chime (A4 to E5) - User Interaction Needed
		tones = [
			{ freq: 440, start: 0, duration: 0.35, type: 'sine', gain: 0.18 },
			{ freq: 659.25, start: 0.18, duration: 0.45, type: 'sine', gain: 0.18 }
		];
	} else if (type === 'complete') {
		// Smooth major chord cascade chime (C5, E5, G5)
		tones = [
			{ freq: 523.25, start: 0, duration: 0.15, type: 'sine', gain: 0.12 },
			{ freq: 659.25, start: 0.08, duration: 0.15, type: 'sine', gain: 0.12 },
			{ freq: 783.99, start: 0.16, duration: 0.4, type: 'sine', gain: 0.15 }
		];
	} else if (type === 'error') {
		// Low descending minor sound (A4 to F4)
		tones = [
			{ freq: 440, start: 0, duration: 0.15, type: 'sine', gain: 0.15 },
			{ freq: 349.23, start: 0.12, duration: 0.4, type: 'sine', gain: 0.15 }
		];
	} else {
		return;
	}

	// Scale volume using the configured volume scale factor
	tones.forEach(t => t.gain = (t.gain !== undefined ? t.gain : 0.15) * volume_scale);

	try {
		const wav_buffer = generateChimeWav(tones);
		const temp_path = path.join(os.tmpdir(), `nono-chime-${type}.wav`);
		fs.writeFileSync(temp_path, wav_buffer);

		const player = fs.existsSync('/usr/bin/pw-play') 
			? 'pw-play' 
			: (fs.existsSync('/usr/bin/paplay') ? 'paplay' : (fs.existsSync('/usr/bin/aplay') ? 'aplay' : null));

		if (player) {
			spawn(player, [temp_path], { stdio: 'ignore', detached: true }).unref();
		}
	} catch (err) {
		// Ignore audio errors
	}
}

// Helper to ask the user a question / confirmation
function askUser(question) {
	clearProgress();
	playChime('question');
	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});
		rl.question(question, answer => {
			rl.close();
			resolve(answer);
		});
	});
}

function askUserInRoll(question) {
	playChime('question');
	updateProgress(question);

	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true
		});
		rl.on('line', (line) => {
			rl.close();
			resolve(line);
		});
	});
}

// Helper to run sudo true interactively and capture stdout/stderr in the roll
function runInteractiveSudo() {
	return new Promise((resolve, reject) => {
		const child = spawn('sudo', ['true'], { stdio: ['inherit', 'pipe', 'pipe'] });

		child.stdout.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				updateProgress(`• ${text}`);
			}
		});

		child.stderr.on('data', (data) => {
			const text = data.toString().trim();
			if (text) {
				updateProgress(`• ${text}`);
			}
		});

		child.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Sudo authentication failed.`));
			}
		});
	});
}

// Find project root
function findProjectRoot(start_dir = process.cwd()) {
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
function getKittyScreenText() {
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

// Run project dry-run command if possible
function runProjectDryRun(modified_file_path) {
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
function isHighImpactCommand(command) {
	const normalized = command.toLowerCase();

	if (normalized.includes('sudo')) return true;
	if (normalized.includes('pacman') || normalized.includes('yay') || normalized.includes('paru')) return true;

	if (normalized.includes('systemctl') && (normalized.includes('start') || normalized.includes('stop') || normalized.includes('restart') || normalized.includes('enable') || normalized.includes('disable'))) {
		return true;
	}

	if (normalized.includes('/etc/') || normalized.includes('/sys/') || normalized.includes('/boot/') || normalized.includes('/usr/lib/systemd')) {
		const is_write = />|>>|tee|rm\s|mv\s|cp\s|chmod|chown|edit|mkdir|touch/g.test(command);
		if (is_write) return true;
	}

	return false;
}

// ----------------------------------------------------
// Tool Implementations
// ----------------------------------------------------

function listDirectoryStructure({ directory_path, depth = 2 }) {
	const abs_path = path.resolve(directory_path);

	function recurse(dir, current_depth = 1) {
		if (!fs.existsSync(dir)) {
			throw new Error(`Directory does not exist: ${dir}`);
		}
		const stat = fs.statSync(dir);
		if (!stat.isDirectory()) {
			throw new Error(`Path is not a directory: ${dir}`);
		}

		const items = fs.readdirSync(dir);
		const result = [];

		for (const item of items) {
			if (item === '.git' || item === 'node_modules' || item === '.cache') {
				continue;
			}
			const item_path = path.join(dir, item);
			const item_stat = fs.statSync(item_path);
			const is_dir = item_stat.isDirectory();

			const entry = {
				name: item,
				path: path.relative(process.cwd(), item_path),
				type: is_dir ? 'directory' : 'file'
			};

			if (is_dir && current_depth < depth) {
				try {
					entry.children = recurse(item_path, current_depth + 1);
				} catch (e) {
					entry.error = e.message;
				}
			}
			result.push(entry);
		}
		return result;
	}

	return { files: recurse(abs_path, 1) };
}

function viewFileContents({ file_path, start_line, end_line }) {
	const abs_path = path.resolve(file_path);
	if (!fs.existsSync(abs_path)) {
		throw new Error(`File does not exist: ${file_path}`);
	}
	const stat = fs.statSync(abs_path);
	if (!stat.isFile()) {
		throw new Error(`Path is not a file: ${file_path}`);
	}

	const content = fs.readFileSync(abs_path, 'utf8');
	const lines = content.split(/\r?\n/);

	const start = start_line ? Math.max(1, start_line) : 1;
	const end = end_line ? Math.min(lines.length, end_line) : lines.length;

	const sliced_lines = lines.slice(start - 1, end);
	let raw_content = sliced_lines.join('\n');
	let is_truncated = false;
	const max_chars = 30000;
	if (raw_content.length > max_chars) {
		raw_content = raw_content.slice(0, max_chars) + '\n[... Content truncated to prevent excessive token usage ...]';
		is_truncated = true;
	}

	return {
		file_path,
		total_lines: lines.length,
		start_line: start,
		end_line: end,
		is_truncated,
		content: raw_content
	};
}

// Helper to format supported text files using Prettier
function formatWithPrettier(file_path) {
	const ext = path.extname(file_path).toLowerCase();
	const formatable_exts = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.markdown', '.yaml', '.yml'];
	if (formatable_exts.includes(ext)) {
		try {
			execSync(`npx -y prettier --write ${JSON.stringify(file_path)}`, { stdio: 'ignore' });
		} catch (err) {
			// Ignore formatter errors (e.g. syntax errors or missing prettier)
		}
	}
}

// Helper to compute added and removed lines count between two file states (using LCS)
function getLineDiff(oldStr, newStr) {
	if (!oldStr) {
		const added = newStr ? newStr.split(/\r?\n/).length : 0;
		return { deleted: 0, added };
	}
	const oldLines = oldStr.split(/\r?\n/);
	const newLines = newStr ? newStr.split(/\r?\n/) : [];
	const m = oldLines.length;
	const n = newLines.length;

	// Cap to avoid high memory/CPU on massive files
	if (m > 1000 || n > 1000) {
		return { deleted: m, added: n };
	}

	const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}
	const lcs = dp[m][n];
	return { deleted: m - lcs, added: n - lcs };
}

function writeFile({ file_path, content }) {
	const abs_path = path.resolve(file_path);
	const dir = path.dirname(abs_path);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const old_content = fs.existsSync(abs_path) ? fs.readFileSync(abs_path, 'utf8') : '';
	fs.writeFileSync(abs_path, content, 'utf8');

	formatWithPrettier(abs_path);

	const final_content = fs.readFileSync(abs_path, 'utf8');
	const { deleted, added } = getLineDiff(old_content, final_content);
	updateProgress(`• Edited ${path.basename(file_path)} \x1b[31m-${deleted}\x1b[90m \x1b[32m+${added}\x1b[90m`);

	const lint_result = runProjectDryRun(abs_path);
	return {
		file_path,
		status: 'success',
		...lint_result
	};
}

function patchFile({ file_path, search_block, replace_block }) {
	const abs_path = path.resolve(file_path);
	if (!fs.existsSync(abs_path)) {
		throw new Error(`File does not exist: ${file_path}`);
	}
	const old_content = fs.readFileSync(abs_path, 'utf8');

	const normalized_content = old_content.replace(/\r\n/g, '\n');
	const normalized_search = search_block.replace(/\r\n/g, '\n');
	const normalized_replace = replace_block.replace(/\r\n/g, '\n');

	const index = normalized_content.indexOf(normalized_search);
	if (index === -1) {
		throw new Error(`Search block not found in file: ${file_path}`);
	}

	const last_index = normalized_content.lastIndexOf(normalized_search);
	if (index !== last_index) {
		throw new Error(`Search block is not unique. It appears multiple times in file: ${file_path}`);
	}

	const patched_content = normalized_content.slice(0, index) + normalized_replace + normalized_content.slice(index + normalized_search.length);
	fs.writeFileSync(abs_path, patched_content, 'utf8');

	formatWithPrettier(abs_path);

	const final_content = fs.readFileSync(abs_path, 'utf8');
	const { deleted, added } = getLineDiff(old_content, final_content);
	updateProgress(`• Edited ${path.basename(file_path)} \x1b[31m-${deleted}\x1b[90m \x1b[32m+${added}\x1b[90m`);

	const lint_result = runProjectDryRun(abs_path);
	return {
		file_path,
		status: 'success',
		...lint_result
	};
}

function searchGrep({ pattern, directory_path }) {
	return new Promise(resolve => {
		const search_dir = directory_path ? path.resolve(directory_path) : process.cwd();
		const cmd = `/usr/bin/rg -n --no-heading --color=never --max-count=100 ${JSON.stringify(pattern)} ${JSON.stringify(search_dir)}`;

		exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
			if (error && error.code !== 1) {
				// 1 means no matches
				resolve({
					status: 'error',
					error: stderr || error.message
				});
			} else {
				const max_chars = 30000;
				let matches = stdout.trim() || 'No matches found.';
				let is_truncated = false;
				if (matches.length > max_chars) {
					matches = matches.slice(0, max_chars) + '\n[... Matches truncated to prevent excessive token usage ...]';
					is_truncated = true;
				}
				resolve({
					status: 'success',
					is_truncated,
					matches: matches
				});
			}
		});
	});
}

async function executeSystemCommand({ command, timeout_ms = 30000 }) {
	if (isHighImpactCommand(command)) {
		updateProgress(`• High-impact action detected: "${command}"`);
		const answer = await askUserInRoll(`Do you want to run this command? [Y/n]: `);
		const norm = answer.trim().toLowerCase();
		if (norm !== '' && norm !== 'y' && norm !== 'yes') {
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
			updateProgress(`• sudo credential caching required. Please authenticate when prompted:`);
			playChime('fingerprint');
			try {
				await runInteractiveSudo();
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
			const max_chars = 30000;
			let truncated_stdout = stdout;
			let truncated_stderr = stderr;
			let stdout_truncated = false;
			let stderr_truncated = false;

			if (stdout && stdout.length > max_chars) {
				truncated_stdout = stdout.slice(0, max_chars) + '\n[... stdout truncated to prevent excessive token usage ...]';
				stdout_truncated = true;
			}
			if (stderr && stderr.length > max_chars) {
				truncated_stderr = stderr.slice(0, max_chars) + '\n[... stderr truncated to prevent excessive token usage ...]';
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

function proposeTerminalInput({ command_to_inject }) {
	return new Promise(resolve => {
		const window_id = process.env.KITTY_WINDOW_ID;
		const match_arg = window_id ? `--match id:${window_id}` : '';
		const cmd = `kitty @ send-text ${match_arg} ${JSON.stringify(command_to_inject)}`;

		exec(cmd, (error, stdout, stderr) => {
			if (error) {
				resolve({
					status: 'error',
					error: stderr || error.message
				});
			} else {
				resolve({
					status: 'success',
					message: `Injected command into terminal prompt: "${command_to_inject}"`
				});
			}
		});
	});
}

// Map tool name to implementation function
const tools_mapping = {
	list_directory_structure: listDirectoryStructure,
	view_file_contents: viewFileContents,
	write_file: writeFile,
	patch_file: patchFile,
	search_grep: searchGrep,
	execute_system_command: executeSystemCommand,
	propose_terminal_input: proposeTerminalInput
};

// Helper to get OS description dynamically
function getOSDescription() {
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

const os_name = getOSDescription();

// ----------------------------------------------------
// Gemini Tool Declarations
// ----------------------------------------------------

const tools_declarations = [
	{
		name: 'list_directory_structure',
		description: 'Lists the files and folders in a directory recursively up to a certain depth to understand the project workspace layout.',
		parameters: {
			type: 'OBJECT',
			properties: {
				directory_path: { type: 'STRING', description: 'The absolute or relative path to the directory.' },
				depth: { type: 'INTEGER', description: 'Maximum depth of recursion (default: 2).' }
			},
			required: ['directory_path']
		}
	},
	{
		name: 'view_file_contents',
		description: 'Reads the content of a file. Supports line-range targeting. Note: Outputs exceeding 30,000 characters will be truncated.',
		parameters: {
			type: 'OBJECT',
			properties: {
				file_path: { type: 'STRING', description: 'The path to the file.' },
				start_line: { type: 'INTEGER', description: 'Optional line number to start reading from.' },
				end_line: { type: 'INTEGER', description: 'Optional line number to stop reading at.' }
			},
			required: ['file_path']
		}
	},
	{
		name: 'write_file',
		description: 'Creates a new file or overwrites an existing file with complete fresh content.',
		parameters: {
			type: 'OBJECT',
			properties: {
				file_path: { type: 'STRING', description: 'Path where the file should be created/written.' },
				content: { type: 'STRING', description: 'The exact textual content to write.' }
			},
			required: ['file_path', 'content']
		}
	},
	{
		name: 'patch_file',
		description: 'Applies a specific diff, line replacement, or block modification to a file to minimize rewriting huge files.',
		parameters: {
			type: 'OBJECT',
			properties: {
				file_path: { type: 'STRING', description: 'Path to the target file.' },
				search_block: { type: 'STRING', description: 'The original code block to find.' },
				replace_block: { type: 'STRING', description: 'The new code block to substitute.' }
			},
			required: ['file_path', 'search_block', 'replace_block']
		}
	},
	{
		name: 'search_grep',
		description: 'Performs a fast regex-based substring search across the workspace (equivalent to ripgrep) to find references or declarations. Note: Outputs exceeding 30,000 characters will be truncated.',
		parameters: {
			type: 'OBJECT',
			properties: {
				pattern: { type: 'STRING', description: 'The regex pattern or substring to search for.' },
				directory_path: { type: 'STRING', description: 'The directory root to search inside.' }
			},
			required: ['pattern']
		}
	},
	{
		name: 'execute_system_command',
		description: `Executes a non-blocking or blocking bash command on the ${os_name} host. Returns stdout, stderr, and exit status code. Note: stdout and stderr exceeding 30,000 characters each will be truncated.`,
		parameters: {
			type: 'OBJECT',
			properties: {
				command: { type: 'STRING', description: "The exact terminal command to run (e.g. 'nmcli dev wifi list', 'cargo build')." },
				timeout_ms: { type: 'INTEGER', description: 'Maximum execution time in milliseconds (default: 30000).' }
			},
			required: ['command']
		}
	},
	{
		name: 'propose_terminal_input',
		description: "Injects text straight into the user's active Zsh prompt using Kitty's remote control feature, leaving the user to hit Enter.",
		parameters: {
			type: 'OBJECT',
			properties: {
				command_to_inject: { type: 'STRING', description: 'The command string to stage on the user shell line.' }
			},
			required: ['command_to_inject']
		}
	}
];

const system_prompt = `You are Nono, an ultra-efficient CLI AI Agent & Coding Workspace Specialist.
You run on a ${os_name} host and operate in one of two modes:
1. System Admin Mode: Focused on minimal, precise system calls (NetworkManager, systemctl, diagnostics).
2. Workspace Developer Mode: Focused on codebase understanding, editing, and software engineering.

CRITICAL INSTRUCTIONS:
- You operate using an Agentic Loop (ReAct: Reason + Act). Before invoking any tool, you MUST output your plan and reasoning.
- Plan-Before-Code Protocol: Before writing or patching any file, you must output a clear technical strategy.
- Deterministic Patching: Prefer patch_file over complete rewrites for existing files to conserve tokens and reduce errors.
- Dry-run validation: After modifying files, the local engine automatically runs dry-run checks (like linting or tsc), but you should review the results and fix any errors.
- If you need to search for code or references, use search_grep.
- If you need up-to-date web information, use the googleSearch tool.
- Do NOT use emojis, special icons, or graphical characters in your reasoning or output responses. Stick to clean, plain text and standard terminal markdown.

Guidelines:
- Keep your final output concise and accurate.
- Maintain documentation integrity.
`;

// ----------------------------------------------------
// Main Agentic Loop Orchestrator
// ----------------------------------------------------

async function main() {
	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	if (!fs.existsSync(cache_dir)) {
		fs.mkdirSync(cache_dir, { recursive: true });
	}

	// Handle nono --details argument
	if (process.argv[2] === '--details') {
		const details_file = path.join(cache_dir, `details-${process.ppid}.log`);
		if (fs.existsSync(details_file)) {
			console.log(`Opening session details in VS Code...`);
			exec(`code ${JSON.stringify(details_file)}`, error => {
				if (error) {
					console.error(`Failed to open VS Code: ${error.message}`);
					process.exit(1);
				}
				process.exit(0);
			});
			return;
		} else {
			console.error(`No details log found for this terminal session.`);
			process.exit(1);
		}
	}

	// Handle nono --test-audio argument
	if (process.argv[2] === '--test-audio') {
		const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
		
		console.log(`\n\x1b[35m=== Nono Audio Diagnostics ===\x1b[0m`);
		console.log(`Current Volume Level: ${Math.round(volume_scale * 100)}%\n`);

		console.log(`• Playing: User Interaction Needed Chime`);
		console.log(`  \x1b[90mMeaning: Played when Nono asks a question or requires sudo credential authentication.\x1b[0m`);
		playChime('user_interaction_needed');
		await sleep(1500);

		console.log(`• Playing: Success Chime`);
		console.log(`  \x1b[90mMeaning: Played at the end of a task when Nono finishes successfully.\x1b[0m`);
		playChime('complete');
		await sleep(1500);

		console.log(`• Playing: Error Chime`);
		console.log(`  \x1b[90mMeaning: Played when a task fails or a dry-run check throws errors.\x1b[0m`);
		playChime('error');
		await sleep(1500);

		console.log(`\n\x1b[32m✔ Audio diagnostics complete!\x1b[0m\n`);
		process.exit(0);
		return;
	}

	// Handle nono --test-format argument
	if (process.argv[2] === '--test-format') {
		const test_markdown = `### System Status & Sudo Verification
Here is the diagnostics output from the elevated test environment:

- **Command executed**: \`sudo systemctl status fprintd\`
- **Status**: \`active (running)\`
- **Elapsed execution time**: 4s

### Security & Access Policy
1. **Passwordless Access**: Active.
2. **Elevated Privileges**: Fully verified.

Here is the raw system logs payload:
\`\`\`text
Jun 29 00:34:40 host systemd[1]: Starting Fingerprint Authentication Daemon...
Jun 29 00:34:41 host fprintd[465101]: Goodix Fingerprint Sensor 53xc active.
\`\`\`

*Note: Please ensure the PAM module rules are kept aligned with the security constraints.*`;

		console.log(`\n\x1b[35m=== Nono Markdown Formatting Test ===\x1b[0m\n`);
		console.log(`\x1b[35m✦\x1b[0m ${formatMarkdownForTerminal(test_markdown)}`);
		console.log();
		process.exit(0);
		return;
	}

	// Capture CLI arguments
	let user_query = process.argv.slice(2).join(' ');

	// If no arguments, prompt interactively
	if (!user_query.trim()) {
		console.log('\x1b[32mNono Workspace Specialist\x1b[0m');
		user_query = await askUser('How can I help you today? ');
		if (!user_query.trim()) {
			console.log('No prompt provided. Exiting.');
			process.exit(0);
		}
	}

	// Reset the elapsed timer to exclude prompt typing time
	start_time = Date.now();

	// Create/Clear details file for this command run
	details_path = path.join(cache_dir, `details-${process.ppid}.log`);
	fs.writeFileSync(details_path, '', 'utf8');

	// Load or initialize session
	const session_path = path.join(cache_dir, `session-${process.ppid}.json`);
	let history = [];
	if (fs.existsSync(session_path)) {
		try {
			history = JSON.parse(fs.readFileSync(session_path, 'utf8'));
		} catch (e) {
			// Clear corrupt file
		}
	}

	// Ingest environmental context
	const project_root = findProjectRoot();
	const screen_text = getKittyScreenText();

	let context_bonus = '';
	if (screen_text) {
		context_bonus += `\n\n[Live Terminal Buffer (last 100 lines)]:\n${screen_text}`;
	}
	if (project_root) {
		context_bonus += `\n\n[Workspace Developer Mode active. Project root: ${project_root}]`;
		try {
			const root_structure = listDirectoryStructure({ directory_path: project_root, depth: 1 });
			context_bonus += `\n[Project Root Directory Structure (depth 1)]:\n${JSON.stringify(root_structure, null, 2)}`;
		} catch (e) {
			// Ignore directory structure listing error
		}
	} else {
		context_bonus += `\n\n[System Admin Mode active]`;
	}

	// Add the new user query to the history
	const full_user_prompt = `${user_query}${context_bonus}`;
	history.push({
		role: 'user',
		parts: [{ text: full_user_prompt }]
	});

	writeDetails(`[User Query] ${user_query}\n[PPID] ${process.ppid}\n`);

	updateProgress('• Thinking...');

	// Start the ReAct execution loop
	while (true) {
		try {
			const response = await ai.models.generateContent({
				model: model_name,
				contents: history,
				config: {
					systemInstruction: system_prompt,
					tools: [{ functionDeclarations: tools_declarations }, { googleSearch: {} }],
					toolConfig: {
						functionCallingConfig: {
							mode: 'AUTO'
						},
						includeServerSideToolInvocations: true
					}
				}
			});

			const candidate = response.candidates?.[0];
			const model_message = candidate?.content;
			if (!model_message) {
				finishProgressError('No response received from model.');
				break;
			}

			// Add model's turn to history
			history.push(model_message);

			// Print any thoughts/explanations the model outputs in this turn
			const text_part = model_message.parts?.find(p => p.text);
			const function_calls = model_message.parts?.filter(p => p.functionCall);
			const has_function_calls = function_calls && function_calls.length > 0;

			if (text_part && text_part.text) {
				writeDetails(`\n[Model Thought]\n${text_part.text.trim()}`);
				if (has_function_calls) {
					updateProgress(`• ${text_part.text.trim()}`);
				}
			}

			if (!has_function_calls) {
				// No functions to call, we have reached the final state
				finishProgress(text_part ? text_part.text : 'Task completed.');
				break;
			}

			// Execute requested functions sequentially to prevent interleaved console logs & cursor corruption
			const response_parts = [];
			for (const call_part of function_calls) {
				const call = call_part.functionCall;
				const { name, args, id } = call;

				// Formulate a clean progress line for the tool call
				let tool_str = name;
				if (name === 'execute_system_command' && args.command) {
					tool_str = args.command;
				} else {
					const arg_vals = Object.values(args)
						.map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
						.join(' ');
					if (arg_vals) {
						tool_str = `${name} ${arg_vals}`;
					}
				}

				updateProgress(`• Running "${tool_str}"`);
				writeDetails(`\n⚙️ [Tool Call] Running: ${name} with args:\n${JSON.stringify(args, null, 2)}`);

				const tool_fn = tools_mapping[name];
				let result;
				if (!tool_fn) {
					result = { error: `Tool "${name}" is not implemented.` };
				} else {
					try {
						result = await tool_fn(args);
					} catch (err) {
						result = { error: err.message || String(err) };
					}
				}

				writeDetails(`⚙️ [Tool Result] for ${name}:\n${JSON.stringify(result, null, 2)}`);

				const function_response_part = {
					functionResponse: {
						name,
						response: result
					}
				};
				if (id) {
					function_response_part.functionResponse.id = id;
				}
				response_parts.push(function_response_part);
			}

			// Push user/tool execution results back into the conversation history
			history.push({
				role: 'user',
				parts: response_parts
			});

			// Save intermediate history state
			fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');
		} catch (err) {
			finishProgressError(err.message || String(err));
			break;
		}
	}

	// Save final history state
	fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');
}

main().catch(err => {
	console.error('\x1b[31mFatal error:\x1b[0m', err);
	playChime('error');
	process.exit(1);
});
