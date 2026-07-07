#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec, execSync, spawn } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import cliHighlight from 'cli-highlight';
import prettier from 'prettier';

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

if (!api_key && !['--details', '--usage', '--help', '-h', '--summarize-background'].includes(process.argv[2])) {
	console.error('\x1b[31mError: GEMINI_API_KEY is not set.\x1b[0m');
	console.error('Please configure your GEMINI_API_KEY in a .env file.');
	process.exit(1);
}

const ai = api_key ? new GoogleGenAI({ apiKey: api_key }) : null;

// Global Progress & Logging State
let start_time = Date.now();
let details_path = '';

// Strip ANSI visual escape codes
function stripAnsi(str) {
	if (typeof str !== 'string') return str;
	return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

// Truncate old, massive tool responses in history to optimize context cache
function pruneHistory(history) {
	if (!Array.isArray(history)) return history;
	// We prune all messages except the very last one in history
	for (let i = 0; i < history.length - 1; i++) {
		const message = history[i];
		if (message && message.role === 'user' && Array.isArray(message.parts)) {
			for (const part of message.parts) {
				if (part && part.functionResponse && part.functionResponse.response) {
					const response = part.functionResponse.response;
					
					// Truncate view_file_contents
					if (part.functionResponse.name === 'view_file_contents' && typeof response.content === 'string') {
						if (response.content.length > 1000) {
							response.content = response.content.slice(0, 1000) + '\n[... Content truncated in history pruning ...]';
							response.is_truncated = true;
						}
					}
					// Truncate search_grep
					if (part.functionResponse.name === 'search_grep' && typeof response.matches === 'string') {
						if (response.matches.length > 1000) {
							response.matches = response.matches.slice(0, 1000) + '\n[... Matches truncated in history pruning ...]';
							response.is_truncated = true;
						}
					}
					// Truncate execute_system_command
					if (part.functionResponse.name === 'execute_system_command') {
						if (typeof response.stdout === 'string' && response.stdout.length > 1000) {
							response.stdout = response.stdout.slice(0, 1000) + '\n[... stdout truncated in history pruning ...]';
							response.stdout_truncated = true;
						}
						if (typeof response.stderr === 'string' && response.stderr.length > 1000) {
							response.stderr = response.stderr.slice(0, 1000) + '\n[... stderr truncated in history pruning ...]';
							response.stderr_truncated = true;
						}
					}
				}
			}
		}
	}
	return history;
}

// Helper to run a sub-agent for summarizing massive tool output
async function runSummarizationSubAgent(originalResult, query) {
	if (!ai) {
		return 'Error: Gemini AI client not initialized.';
	}
	try {
		const resultString = JSON.stringify(originalResult, null, 2);
		const prompt = `You are a helper sub-agent for a main coding assistant.
Your task is to summarize or extract the relevant parts of a tool output because the output is too large to fit in the context window.

The main agent is looking for: "${query}"

Here is the original tool output:
<tool_output>
${resultString}
</tool_output>

Please return a concise, targeted summary or extraction of the relevant parts that satisfies the main agent's query. Maintain crucial technical details, paths, variables, and line numbers if relevant.`;

		const response = await ai.models.generateContent({
			model: model_name,
			contents: [{ role: 'user', parts: [{ text: prompt }] }]
		});

		const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
		return text || 'Could not summarize the tool output.';
	} catch (err) {
		return `Error running summarization sub-agent: ${err.message || err}`;
	}
}

// Helper for background summarization process
async function handleBackgroundSummarization(session_path) {
	if (!fs.existsSync(session_path)) return;
	let history = [];
	let L_before = 0;
	try {
		history = JSON.parse(fs.readFileSync(session_path, 'utf8'));
		L_before = history.length;
	} catch (e) {
		return;
	}

	if (!Array.isArray(history) || history.length === 0) return;

	// Find the user prompt message indices (where role: 'user' and first part has text)
	const promptIndices = [];
	for (let i = 0; i < history.length; i++) {
		const msg = history[i];
		if (msg && msg.role === 'user' && Array.isArray(msg.parts) && msg.parts[0] && typeof msg.parts[0].text === 'string') {
			if (!msg.parts[0].text.startsWith('[System Memory:\n')) {
				promptIndices.push(i);
			}
		}
	}

	// We keep the last 2 turns in full (Turn N-1 and Turn N)
	// So we need at least 3 prompt messages to summarize (promptIndices.length >= 3)
	if (promptIndices.length < 3) return;

	const sliceIndex = promptIndices[promptIndices.length - 2];
	const historyToSummarize = history.slice(0, sliceIndex);
	const historyToKeep = history.slice(sliceIndex);

	const summaryPrompt = `Extract the key facts from this conversation history. You must retain exact file paths, critical variables, active error messages, and the current overall goal. Format as bullet points.`;
	const contents = [
		...historyToSummarize,
		{
			role: 'user',
			parts: [{ text: summaryPrompt }]
		}
	];

	try {
		const response = await ai.models.generateContent({
			model: model_name,
			contents: contents
		});

		const summary = response.candidates?.[0]?.content?.parts?.[0]?.text;
		if (summary && fs.existsSync(session_path)) {
			let currentHistory = [];
			try {
				currentHistory = JSON.parse(fs.readFileSync(session_path, 'utf8'));
			} catch (e) {
				currentHistory = history;
			}

			if (Array.isArray(currentHistory)) {
				// Any messages beyond L_before are new messages added since we started
				const newMessages = currentHistory.slice(L_before);

				const systemMemoryMsg = {
					role: 'user',
					parts: [{ text: `[System Memory:\n${summary.trim()}]` }]
				};
				const newHistory = [systemMemoryMsg, ...historyToKeep, ...newMessages];
				fs.writeFileSync(session_path, JSON.stringify(newHistory, null, 2), 'utf8');
			}
		}
	} catch (err) {
		// Ignore / fail silently
	}
}

function writeDetails(text) {
	if (details_path) {
		fs.appendFileSync(details_path, text + '\n', 'utf8');
	}
}

function loadCustomTheme() {
	let theme_json_str = '';

	// 1. Check if NONO_THEME is set in the environment
	if (process.env.NONO_THEME) {
		const theme_val = process.env.NONO_THEME.trim();
		if (theme_val.startsWith('{')) {
			theme_json_str = theme_val;
		} else {
			const resolved_path = path.resolve(theme_val.replace(/^~/, os.homedir()));
			if (fs.existsSync(resolved_path)) {
				try {
					theme_json_str = fs.readFileSync(resolved_path, 'utf8');
				} catch (e) {
					// Ignore read errors
				}
			}
		}
	}

	// 2. Fallback to default config location: ~/.config/nono/theme.json
	if (!theme_json_str) {
		const default_theme_path = path.join(os.homedir(), '.config', 'nono', 'theme.json');
		if (fs.existsSync(default_theme_path)) {
			try {
				theme_json_str = fs.readFileSync(default_theme_path, 'utf8');
			} catch (e) {
				// Ignore read errors
			}
		}
	}

	// 3. Fallback to hardcoded default theme (VS Code Material Theme Darker mapping)
	if (!theme_json_str) {
		theme_json_str = JSON.stringify({
			keyword: 'magenta',
			built_in: 'blue',
			type: 'yellow',
			literal: 'yellow',
			number: 'yellow',
			regexp: 'cyan',
			string: 'green',
			comment: 'gray',
			class: 'blue',
			function: 'blue',
			tag: 'red',
			name: 'blue',
			attr: 'cyan',
			addition: 'green',
			deletion: 'red',
			default: 'white'
		});
	}

	if (theme_json_str) {
		try {
			return cliHighlight.parse(theme_json_str);
		} catch (err) {
			writeDetails(`[Theme Load Error] Failed to parse custom theme JSON: ${err.message}`);
		}
	}
	return undefined;
}

const custom_theme = loadCustomTheme();

function formatProgressLine(text) {
	let ansi_prefix = '\x1b[90m'; // Default gray
	if (text.includes('High-impact') || text.includes('caching required')) {
		ansi_prefix = '\x1b[31m'; // Red
	}
	const ansi_suffix = '\x1b[0m';

	let raw = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	return `${ansi_prefix}${raw}${ansi_suffix}`;
}

function getCleanThoughtLine(text) {
	const lines = text
		.split('\n')
		.map(l => l.trim())
		.filter(l => l.length > 0);
	if (lines.length === 0) return '';
	let first_line = lines[0];
	first_line = first_line.replace(/[*_`#]/g, '');
	if (first_line.length > 120) {
		return first_line.slice(0, 117) + '...';
	}
	return first_line;
}

function formatToolCallProgress(name, args) {
	const basename = args.file_path ? path.basename(args.file_path) : '';

	switch (name) {
		case 'list_directory_structure': {
			const dir = args.directory_path ? path.basename(args.directory_path) || args.directory_path : '.';
			return `Listing directory structure of "${dir}"`;
		}
		case 'view_file_contents': {
			let lines_str = '';
			if (args.start_line !== undefined && args.end_line !== undefined) {
				lines_str = ` (lines ${args.start_line}-${args.end_line})`;
			} else if (args.start_line !== undefined) {
				lines_str = ` (from line ${args.start_line})`;
			} else if (args.end_line !== undefined) {
				lines_str = ` (up to line ${args.end_line})`;
			}
			return `Viewing ${basename}${lines_str}`;
		}
		case 'write_file': {
			return `Writing ${basename}`;
		}
		case 'patch_file': {
			return `Patching ${basename}`;
		}
		case 'search_grep': {
			return `Searching for "${args.pattern}"`;
		}
		case 'execute_system_command': {
			return `Running "${args.command}"`;
		}
		case 'propose_terminal_input': {
			return `Proposing terminal input: "${args.command_to_inject}"`;
		}
		case 'read_terminal_buffer': {
			return `Reading terminal buffer`;
		}
		default: {
			const arg_vals = Object.values(args)
				.map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
				.join(' ');
			return arg_vals ? `${name} ${arg_vals}` : name;
		}
	}
}

const languageToParser = {
	js: 'babel',
	javascript: 'babel',
	jsx: 'babel',
	mjs: 'babel',
	cjs: 'babel',
	ts: 'typescript',
	typescript: 'typescript',
	tsx: 'typescript',
	json: 'json',
	json5: 'json',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	yaml: 'yaml',
	yml: 'yaml',
	md: 'markdown',
	markdown: 'markdown'
};

async function formatCodeWithPrettier(code, lang) {
	if (!lang) return code;
	const parser = languageToParser[lang.toLowerCase()];
	if (!parser) {
		return code;
	}
	try {
		const config = (await prettier.resolveConfig(process.cwd())) || {};
		const formatted = await prettier.format(code, {
			...config,
			parser
		});
		return formatted.trimEnd();
	} catch (e) {
		return code;
	}
}

// Helper to format markdown text beautifully for the terminal output
async function formatMarkdownForTerminal(md) {
	if (!md) return '';
	const lines = md.split('\n');
	const formatted_lines = [];
	let in_code_block = false;
	let code_block_lines = [];
	let code_block_lang = '';

	for (let line of lines) {
		// Handle Code Block delimiters
		if (line.trim().startsWith('```')) {
			if (!in_code_block) {
				in_code_block = true;
				code_block_lang = line.trim().slice(3).trim();
				code_block_lines = [];
			} else {
				in_code_block = false;
				const code_text = code_block_lines.join('\n');
				const is_highlighted = code_block_lang && cliHighlight.supportsLanguage(code_block_lang);
				let highlighted_text = code_text;
				if (is_highlighted) {
					try {
						const formatted_code = await formatCodeWithPrettier(code_text, code_block_lang);
						highlighted_text = cliHighlight.highlight(formatted_code, { language: code_block_lang, ignoreIllegals: true, theme: custom_theme });
					} catch (e) {
						// fallback
					}
				}
				const highlighted_lines = highlighted_text.split('\n');
				for (const h_line of highlighted_lines) {
					if (is_highlighted) {
						formatted_lines.push(`  \x1b[90m│\x1b[0m  ${h_line}`);
					} else {
						formatted_lines.push(`  \x1b[90m│\x1b[0m  \x1b[37m${h_line}\x1b[0m`);
					}
				}
			}
			continue;
		}

		if (in_code_block) {
			code_block_lines.push(line);
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
		line = line.replace(/(?:^|(?<=\W))_([^_]+)_(?=\W|$)/g, '\x1b[4m$1\x1b[0m');

		formatted_lines.push(line);
	}

	if (in_code_block && code_block_lines.length > 0) {
		const code_text = code_block_lines.join('\n');
		const is_highlighted = code_block_lang && cliHighlight.supportsLanguage(code_block_lang);
		let highlighted_text = code_text;
		if (is_highlighted) {
			try {
				const formatted_code = await formatCodeWithPrettier(code_text, code_block_lang);
				highlighted_text = cliHighlight.highlight(formatted_code, { language: code_block_lang, ignoreIllegals: true, theme: custom_theme });
			} catch (e) {
				// fallback
			}
		}
		const highlighted_lines = highlighted_text.split('\n');
		for (const h_line of highlighted_lines) {
			if (is_highlighted) {
				formatted_lines.push(`  \x1b[90m│\x1b[0m  ${h_line}`);
			} else {
				formatted_lines.push(`  \x1b[90m│\x1b[0m  \x1b[37m${h_line}\x1b[0m`);
			}
		}
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

async function finishProgress(final_text) {
	clearProgress();
	const elapsed = Math.round((Date.now() - start_time) / 1000);
	console.log(`\x1b[90m• Worked for ${elapsed}s\x1b[0m`);
	const formatted = await formatMarkdownForTerminal(final_text.trim());
	console.log();
	console.log(`\x1b[35m✦\x1b[0m ${formatted}`);
	console.log();
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
	tones.forEach(t => (t.gain = (t.gain !== undefined ? t.gain : 0.15) * volume_scale));

	try {
		const wav_buffer = generateChimeWav(tones);
		const temp_path = path.join(os.tmpdir(), `nono-chime-${type}.wav`);
		fs.writeFileSync(temp_path, wav_buffer);

		const player = fs.existsSync('/usr/bin/pw-play') ? 'pw-play' : fs.existsSync('/usr/bin/paplay') ? 'paplay' : fs.existsSync('/usr/bin/aplay') ? 'aplay' : null;

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

	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true
		});
		rl.on('line', line => {
			rl.close();
			resolve(line);
		});
	});
}

// Helper to run sudo true interactively and capture stdout/stderr in the roll
function runInteractiveSudo() {
	return new Promise((resolve, reject) => {
		const child = spawn('sudo', ['true'], { stdio: ['inherit', 'pipe', 'pipe'] });

		child.stdout.on('data', data => {
			const text = data.toString().trim();
			if (text) {
				updateProgress(`• ${text}`);
			}
		});

		child.stderr.on('data', data => {
			const text = data.toString().trim();
			if (text) {
				updateProgress(`• ${text}`);
			}
		});

		child.on('close', code => {
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

// Read terminal buffer history
function readTerminalBuffer() {
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

function getPrettierFlagsFromVSCode() {
	const settings_path = path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');
	if (!fs.existsSync(settings_path)) {
		return '';
	}
	try {
		const raw = fs.readFileSync(settings_path, 'utf8');
		// Remove comments (single line and multi line) from settings.json
		const clean = raw.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
		const settings = JSON.parse(clean);
		const flags = [];
		const config_mapping = {
			'prettier.arrowParens': val => `--arrow-parens ${val}`,
			'prettier.printWidth': val => `--print-width ${val}`,
			'prettier.singleQuote': val => (val ? '--single-quote' : '--no-single-quote'),
			'prettier.tabWidth': val => `--tab-width ${val}`,
			'prettier.trailingComma': val => `--trailing-comma ${val}`,
			'prettier.useTabs': val => (val ? '--use-tabs' : '--no-use-tabs'),
			'prettier.semi': val => (val ? '--semi' : '--no-semi'),
			'prettier.bracketSpacing': val => (val ? '--bracket-spacing' : '--no-bracket-spacing'),
			'prettier.jsxSingleQuote': val => (val ? '--jsx-single-quote' : '--no-jsx-single-quote'),
			'prettier.proseWrap': val => `--prose-wrap ${val}`
		};
		for (const [key, map_fn] of Object.entries(config_mapping)) {
			if (settings[key] !== undefined) {
				flags.push(map_fn(settings[key]));
			}
		}
		return flags.join(' ');
	} catch (e) {
		return '';
	}
}

function hasProjectPrettierConfig(file_path) {
	let current_dir = path.dirname(file_path);
	const config_names = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js', '.prettierrc.mjs', '.prettierrc.cjs', 'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs'];
	const root = path.parse(current_dir).root;
	while (true) {
		for (const name of config_names) {
			if (fs.existsSync(path.join(current_dir, name))) {
				return true;
			}
		}
		const parent = path.dirname(current_dir);
		if (parent === current_dir || current_dir === root) {
			break;
		}
		current_dir = parent;
	}
	current_dir = path.dirname(file_path);
	while (true) {
		const pkg_path = path.join(current_dir, 'package.json');
		if (fs.existsSync(pkg_path)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkg_path, 'utf8'));
				if (pkg.prettier !== undefined) {
					return true;
				}
			} catch (e) {}
		}
		const parent = path.dirname(current_dir);
		if (parent === current_dir || current_dir === root) {
			break;
		}
		current_dir = parent;
	}
	return false;
}

// Helper to format supported text files using Prettier
function formatWithPrettier(file_path) {
	const ext = path.extname(file_path).toLowerCase();
	const formatable_exts = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md', '.markdown', '.yaml', '.yml'];
	if (formatable_exts.includes(ext)) {
		try {
			let flags = '';
			if (!hasProjectPrettierConfig(file_path)) {
				flags = getPrettierFlagsFromVSCode();
			}
			const cmd = `npx -y prettier ${flags} --write ${JSON.stringify(file_path)}`;
			execSync(cmd, { stdio: 'ignore' });
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
	updateProgress(`• Writing ${path.basename(file_path)} \x1b[31m-${deleted}\x1b[90m \x1b[32m+${added}\x1b[90m`);

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
	updateProgress(`• Patching ${path.basename(file_path)} \x1b[31m-${deleted}\x1b[90m \x1b[32m+${added}\x1b[90m`);

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
	propose_terminal_input: proposeTerminalInput,
	read_terminal_buffer: readTerminalBuffer
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
	},
	{
		name: 'read_terminal_buffer',
		description: 'Reads the active terminal buffer history (last 100 lines) from the Kitty terminal.',
		parameters: {
			type: 'OBJECT',
			properties: {}
		}
	}
];

const system_prompt = `You are Nono, an ultra-efficient CLI AI Agent & Coding Workspace Specialist.
You run on a ${os_name} host and operate in one of two modes:
1. System Admin Mode: Focused on minimal, precise system calls (NetworkManager, systemctl, diagnostics).
2. Workspace Developer Mode: Focused on codebase understanding, editing, and software engineering.

CRITICAL INSTRUCTIONS:
- You operate using an Agentic Loop (ReAct: Reason + Act). Before invoking any tool, you MUST output your plan and reasoning.
- Plan-Before-Code Protocol: Before writing or patching any file, you must output a clear technical strategy. Do NOT dump the actual file contents or write full code blocks in your reasoning/thought block; keep the actual code strictly inside the tool parameters (arguments) to conserve tokens.
- Deterministic Patching: Prefer patch_file over complete rewrites for existing files to conserve tokens and reduce errors.
- Dry-run validation: After modifying files, the local engine automatically runs dry-run checks (like linting or tsc), but you should review the results and fix any errors.
- If you need to search for code or references, use search_grep.
- If you need up-to-date web information, use the googleSearch tool.
- Do NOT use emojis, special icons, or graphical characters in your reasoning or output responses. Stick to clean, plain text and standard terminal markdown.

Guidelines:
- Keep your final output concise and accurate.
- Maintain documentation integrity.
- Always specify the language name (e.g., \`\`\`javascript, \`\`\`python, \`\`\`bash) when writing a markdown code block to ensure proper terminal syntax highlighting.
`;

// Helper to log token consumption metrics
function logTokenUsage(model, usageMetadata) {
	if (!usageMetadata) return;
	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	if (!fs.existsSync(cache_dir)) {
		fs.mkdirSync(cache_dir, { recursive: true });
	}
	const log_file = path.join(cache_dir, 'consumption.json');
	let logs = [];
	if (fs.existsSync(log_file)) {
		try {
			logs = JSON.parse(fs.readFileSync(log_file, 'utf8'));
		} catch (e) {
			// ignore corrupt file
		}
	}
	const record = {
		timestamp: new Date().toISOString(),
		ppid: process.ppid,
		model: model,
		promptTokenCount: usageMetadata.promptTokenCount || 0,
		candidatesTokenCount: usageMetadata.candidatesTokenCount || 0,
		cachedContentTokenCount: usageMetadata.cachedContentTokenCount || 0
	};
	logs.push(record);
	try {
		fs.writeFileSync(log_file, JSON.stringify(logs, null, 2), 'utf8');
	} catch (e) {
		// ignore write error
	}
}

// ----------------------------------------------------
// Main Agentic Loop Orchestrator
// ----------------------------------------------------

async function main() {
	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	if (!fs.existsSync(cache_dir)) {
		fs.mkdirSync(cache_dir, { recursive: true });
	}

	// Handle background summarization worker invocation
	if (process.argv[2] === '--summarize-background') {
		const session_path = process.argv[3];
		if (session_path) {
			try {
				await handleBackgroundSummarization(session_path);
			} catch (e) {
				// Fail silently
			}
		}
		process.exit(0);
		return;
	}

	// Handle nono --help or -h argument
	if (process.argv[2] === '--help' || process.argv[2] === '-h') {
		console.log(`
\x1b[35m✦ Nono - Ultra-efficient CLI AI Agent & Coding Workspace Specialist ✦\x1b[0m

\x1b[1mUsage:\x1b[0m
  nono [prompt]              Start Nono in interactive mode or run a prompt directly
  nono --usage               Display token consumption and estimated costs
  nono --clear               Clear terminal screen, scrollback, and current session history
  nono --details             Open the logs and details of the current session in VS Code
  nono --help, -h            Show this help information
`);
		process.exit(0);
		return;
	}

	// Handle nono --clear argument
	if (process.argv[2] === '--clear') {
		// Clear terminal screen and scrollback
		process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

		// Delete session and details files for current session
		const session_path = path.join(cache_dir, `session-${process.ppid}.json`);
		const details_file = path.join(cache_dir, `details-${process.ppid}.log`);

		try {
			if (fs.existsSync(session_path)) {
				fs.unlinkSync(session_path);
			}
			if (fs.existsSync(details_file)) {
				fs.unlinkSync(details_file);
			}
			console.log('\x1b[32m✔ Nono session cleared. Ready for a new chat!\x1b[0m\n');
		} catch (err) {
			console.error(`\x1b[31mError clearing session: ${err.message}\x1b[0m`);
			process.exit(1);
		}
		process.exit(0);
		return;
	}

	// Handle nono --usage argument
	if (process.argv[2] === '--usage') {
		const log_file = path.join(cache_dir, 'consumption.json');
		if (!fs.existsSync(log_file)) {
			console.log('No usage yet');
			process.exit(0);
		}
		let logs = [];
		try {
			logs = JSON.parse(fs.readFileSync(log_file, 'utf8'));
		} catch (e) {
			console.log('No usage yet');
			process.exit(0);
		}
		if (logs.length === 0) {
			console.log('No usage yet');
			process.exit(0);
		}

		const priceInput = parseFloat(process.env.NONO_PRICE_INPUT_EUR_PER_M) || 1.38;
		const priceOutput = parseFloat(process.env.NONO_PRICE_OUTPUT_EUR_PER_M) || 8.28;
		const priceCache = parseFloat(process.env.NONO_PRICE_CACHE_EUR_PER_M) || 0.138;

		let sessionInput = 0;
		let sessionCache = 0;
		let sessionOutput = 0;

		let monthInput = 0;
		let monthCache = 0;
		let monthOutput = 0;

		const now = new Date();
		const year = now.getFullYear();
		const month = now.getMonth();

		const startOfMonth = new Date(year, month, 1);
		const nextMonth = new Date(year, month + 1, 1);
		const elapsedFraction = Math.max(0.0001, (now - startOfMonth) / (nextMonth - startOfMonth));

		for (const log of logs) {
			const logDate = new Date(log.timestamp);
			const isInCurrentMonth = logDate.getFullYear() === year && logDate.getMonth() === month;

			const inputVal = (log.promptTokenCount || 0) - (log.cachedContentTokenCount || 0);
			const cacheVal = log.cachedContentTokenCount || 0;
			const outputVal = log.candidatesTokenCount || 0;

			if (log.ppid === process.ppid) {
				sessionInput += inputVal;
				sessionCache += cacheVal;
				sessionOutput += outputVal;
			}

			if (isInCurrentMonth) {
				monthInput += inputVal;
				monthCache += cacheVal;
				monthOutput += outputVal;
			}
		}

		// Helper to pad strings for alignment
		const pad = (str, length, align = 'left') => {
			str = String(str);
			if (str.length >= length) return str;
			const diff = length - str.length;
			if (align === 'right') {
				return ' '.repeat(diff) + str;
			}
			return str + ' '.repeat(diff);
		};

		const sessionCostInput = (sessionInput * priceInput) / 1000000;
		const sessionCostCache = (sessionCache * priceCache) / 1000000;
		const sessionCostOutput = (sessionOutput * priceOutput) / 1000000;
		const sessionTotalCost = sessionCostInput + sessionCostCache + sessionCostOutput;
		const sessionTotalTokens = sessionInput + sessionCache + sessionOutput;

		const monthCostInput = (monthInput * priceInput) / 1000000;
		const monthCostCache = (monthCache * priceCache) / 1000000;
		const monthCostOutput = (monthOutput * priceOutput) / 1000000;
		const monthTotalCost = monthCostInput + monthCostCache + monthCostOutput;
		const monthTotalTokens = monthInput + monthCache + monthOutput;

		const projectedCostInput = monthCostInput / elapsedFraction;
		const projectedCostCache = monthCostCache / elapsedFraction;
		const projectedCostOutput = monthCostOutput / elapsedFraction;
		const projectedTotalCost = monthTotalCost / elapsedFraction;

		console.log(`\n\x1b[35m=== Nono Token Consumption & Costs ===\x1b[0m`);
		console.log(`Active Model: ${model_name}`);
		console.log(`Month elapsed: ${(elapsedFraction * 100).toFixed(2)}%\n`);

		// ----------------------------------------------------
		// 1. Session Consumption Table
		// ----------------------------------------------------
		console.log(`\x1b[1;35m✦ Session Consumption (PPID: ${process.ppid})\x1b[0m`);
		
		const headers1 = ['Token Type', 'Price / 1M', 'Tokens', 'Estimated Cost'];
		const colWidths1 = [20, 12, 14, 16];

		// Print Headers
		const headerStr1 = 
			pad(headers1[0], colWidths1[0], 'left') + ' │ ' +
			pad(headers1[1], colWidths1[1], 'right') + ' │ ' +
			pad(headers1[2], colWidths1[2], 'right') + ' │ ' +
			pad(headers1[3], colWidths1[3], 'right');
		console.log(`\x1b[1;37m${headerStr1}\x1b[0m`);

		// Print Separator
		const separator1 = 
			'─'.repeat(colWidths1[0]) + '─┼─' +
			'─'.repeat(colWidths1[1]) + '─┼─' +
			'─'.repeat(colWidths1[2]) + '─┼─' +
			'─'.repeat(colWidths1[3]);
		console.log(`\x1b[90m${separator1}\x1b[0m`);

		const printRow1 = (label, priceStr, tokens, cost) => {
			const formattedTokens = tokens.toLocaleString();
			const formattedCost = label === 'Total' ? `${cost.toFixed(2)}€` : `${cost.toFixed(2)}€`;
			
			const line = 
				pad(label, colWidths1[0], 'left') + ' │ ' +
				pad(priceStr, colWidths1[1], 'right') + ' │ ' +
				pad(formattedTokens, colWidths1[2], 'right') + ' │ ' +
				pad(formattedCost, colWidths1[3], 'right');
			
			if (label === 'Total') {
				console.log(`\x1b[1m${line}\x1b[0m`);
			} else {
				console.log(line);
			}
		};

		printRow1('Input (non-cached)', `${priceInput.toFixed(2)}€`, sessionInput, sessionCostInput);
		printRow1('Cache Hit', `${priceCache.toFixed(2)}€`, sessionCache, sessionCostCache);
		printRow1('Output', `${priceOutput.toFixed(2)}€`, sessionOutput, sessionCostOutput);
		
		console.log(`\x1b[90m${separator1}\x1b[0m`);
		printRow1('Total', '-', sessionTotalTokens, sessionTotalCost);
		console.log();

		// ----------------------------------------------------
		// 2. Monthly Consumption & Projections Table
		// ----------------------------------------------------
		const monthsList = [
			'January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December'
		];
		const monthName = monthsList[month];

		console.log(`\x1b[1;35m✦ Monthly Consumption & Projections (${monthName} ${year})\x1b[0m`);

		const headers2 = ['Token Type', 'Price / 1M', 'Month Tokens', 'Month Cost', 'Projected Cost'];
		const colWidths2 = [20, 12, 14, 12, 16];

		// Print Headers
		const headerStr2 = 
			pad(headers2[0], colWidths2[0], 'left') + ' │ ' +
			pad(headers2[1], colWidths2[1], 'right') + ' │ ' +
			pad(headers2[2], colWidths2[2], 'right') + ' │ ' +
			pad(headers2[3], colWidths2[3], 'right') + ' │ ' +
			pad(headers2[4], colWidths2[4], 'right');
		console.log(`\x1b[1;37m${headerStr2}\x1b[0m`);

		// Print Separator
		const separator2 = 
			'─'.repeat(colWidths2[0]) + '─┼─' +
			'─'.repeat(colWidths2[1]) + '─┼─' +
			'─'.repeat(colWidths2[2]) + '─┼─' +
			'─'.repeat(colWidths2[3]) + '─┼─' +
			'─'.repeat(colWidths2[4]);
		console.log(`\x1b[90m${separator2}\x1b[0m`);

		const printRow2 = (label, priceStr, tokens, cost, projectedCost) => {
			const formattedTokens = tokens.toLocaleString();
			const formattedCost = `${cost.toFixed(2)}€`;
			const formattedProjected = `${projectedCost.toFixed(2)}€`;

			const line = 
				pad(label, colWidths2[0], 'left') + ' │ ' +
				pad(priceStr, colWidths2[1], 'right') + ' │ ' +
				pad(formattedTokens, colWidths2[2], 'right') + ' │ ' +
				pad(formattedCost, colWidths2[3], 'right') + ' │ ' +
				pad(formattedProjected, colWidths2[4], 'right');

			if (label === 'Total') {
				console.log(`\x1b[1m${line}\x1b[0m`);
			} else {
				console.log(line);
			}
		};

		printRow2('Input (non-cached)', `${priceInput.toFixed(2)}€`, monthInput, monthCostInput, projectedCostInput);
		printRow2('Cache Hit', `${priceCache.toFixed(2)}€`, monthCache, monthCostCache, projectedCostCache);
		printRow2('Output', `${priceOutput.toFixed(2)}€`, monthOutput, monthCostOutput, projectedCostOutput);

		console.log(`\x1b[90m${separator2}\x1b[0m`);
		printRow2('Total', '-', monthTotalTokens, monthTotalCost, projectedTotalCost);
		console.log();

		process.exit(0);
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

	let context_bonus = '';
	if (project_root) {
		context_bonus += `\n\n[Workspace Developer Mode active. Project root: ${project_root}]`;
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

	// Start the ReAct execution loop
	let pendingSummaryTriggers = [];
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

			if (response.usageMetadata) {
				logTokenUsage(model_name, response.usageMetadata);
			}

			const candidate = response.candidates?.[0];
			const model_message = candidate?.content;
			if (!model_message) {
				finishProgressError('No response received from model.');
				break;
			}

			if (pendingSummaryTriggers.length > 0) {
				const text_part = model_message.parts?.find(p => p.text);
				const query = text_part ? text_part.text.trim() : 'relevant details';

				writeDetails(`\n[Summarizer Trigger] Model specified search query: "${query}"`);
				updateProgress('• Summarizing tool output via sub-agent...');

				const last_user_msg = history[history.length - 1];
				if (last_user_msg && last_user_msg.role === 'user' && Array.isArray(last_user_msg.parts)) {
					for (const trigger of pendingSummaryTriggers) {
						const summary = await runSummarizationSubAgent(trigger.originalResult, query);
						writeDetails(`[Summarizer Trigger] Summary generated for ${trigger.name}:\n${summary}`);

						const matching_part = last_user_msg.parts.find(p => 
							p.functionResponse && 
							p.functionResponse.name === trigger.name && 
							(!trigger.callId || p.functionResponse.id === trigger.callId)
						);
						if (matching_part) {
							matching_part.functionResponse.response = {
								status: 'success',
								summary: summary,
								is_summarized: true
							};
						}
					}
				}

				pendingSummaryTriggers = [];

				pruneHistory(history);
				fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');

				continue;
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
					const thought_summary = getCleanThoughtLine(text_part.text);
					if (thought_summary) {
						updateProgress(`• ${thought_summary}`);
					}
				}
			}

			if (!has_function_calls) {
				// No functions to call, we have reached the final state
				await finishProgress(text_part ? text_part.text : 'Task completed.');
				break;
			}

			// Execute requested functions sequentially to prevent interleaved console logs & cursor corruption
			const response_parts = [];
			for (const call_part of function_calls) {
				const call = call_part.functionCall;
				const { name, args, id } = call;

				// Formulate a clean progress line for the tool call
				if (name !== 'write_file' && name !== 'patch_file') {
					const tool_progress = formatToolCallProgress(name, args);
					updateProgress(`• ${tool_progress}`);
				}
				writeDetails(`\n[Tool Call] Running: ${name} with args:\n${JSON.stringify(args, null, 2)}`);

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

				writeDetails(`[Tool Result] for ${name}:\n${JSON.stringify(result, null, 2)}`);

				// Check if output exceeds 1000 characters
				const result_str = JSON.stringify(result);
				if (result_str.length > 1000) {
					pendingSummaryTriggers.push({
						name,
						callId: id,
						originalResult: result
					});
					result = {
						status: 'error',
						error: `Tool output is too long (${result_str.length} characters). What specific information or pattern are you looking for in this output? Please describe it in your next turn so a sub-agent can extract/summarize it.`
					};
				}

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

			pruneHistory(history);

			// Save intermediate history state
			fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');
		} catch (err) {
			finishProgressError(err.message || String(err));
			break;
		}
	}

	// Save final history state
	pruneHistory(history);
	fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');

	// Check token count and prompt for background summarization if needed
	try {
		if (ai && process.stdin.isTTY) {
			const tokenCountRes = await ai.models.countTokens({
				model: model_name,
				contents: history
			});
			const totalTokens = tokenCountRes.totalTokens || 0;

			// Count user turns
			const userTurns = history.filter(msg => 
				msg && msg.role === 'user' && 
				Array.isArray(msg.parts) && msg.parts[0] && 
				typeof msg.parts[0].text === 'string' && 
				!msg.parts[0].text.startsWith('[System Memory:\n')
			).length;

			const token_limit = process.env.NONO_SUMMARIZE_TOKEN_LIMIT ? parseInt(process.env.NONO_SUMMARIZE_TOKEN_LIMIT, 10) : 20000;
			const turn_limit = process.env.NONO_SUMMARIZE_TURN_LIMIT ? parseInt(process.env.NONO_SUMMARIZE_TURN_LIMIT, 10) : 5;

			if (totalTokens > token_limit && userTurns > turn_limit) {
				console.log(`\n\x1b[33m⚡ Session history is growing large (${totalTokens} tokens, ${userTurns} turns).\x1b[0m`);
				const answer = await askUser('Would you like to compress history in the background? [y/N]: ');
				const norm = answer.trim().toLowerCase();
				if (norm === 'y' || norm === 'yes') {
					console.log('Spawning background summarization process...');
					const child = spawn(process.execPath, [
						fileURLToPath(import.meta.url),
						'--summarize-background',
						session_path
					], {
						detached: true,
						stdio: 'ignore'
					});
					child.unref();
				}
			}
		}
	} catch (e) {
		// Fail silently
	}
}

main().catch(err => {
	console.error('\x1b[31mFatal error:\x1b[0m', err);
	playChime('error');
	process.exit(1);
});
