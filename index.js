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
import * as Diff from 'diff';

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
const default_output_limit = process.env.NONO_SUMMARIZE_OUTPUT_LIMIT ? parseInt(process.env.NONO_SUMMARIZE_OUTPUT_LIMIT, 10) : 10000;
const output_limit = isNaN(default_output_limit) ? 10000 : default_output_limit;

if (!api_key && !['--details', '--usage', '--help', '-h', '--summarize-background', '--raw', '--resume'].includes(process.argv[2])) {
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

// Helper to extract JSON block from markdown response
function extractJsonBlock(text) {
	if (!text) return null;

	const tryLooseJsonParse = str => {
		try {
			return JSON.parse(str);
		} catch (e) {}

		const cleaned = str.replace(/,\s*([\]}])/g, '$1');
		try {
			return JSON.parse(cleaned);
		} catch (e) {}

		try {
			const fn = new Function(`return (${cleaned});`);
			const val = fn();
			if (val && typeof val === 'object') {
				return val;
			}
		} catch (e) {}

		return null;
	};

	// Try to find all ```json ... ``` blocks
	const regex = /```json\s*([\s\S]*?)\s*```/g;
	let match;
	const blocks = [];
	while ((match = regex.exec(text)) !== null) {
		blocks.push(match[1].trim());
	}

	// Try parsing them in reverse order (last one first)
	for (let i = blocks.length - 1; i >= 0; i--) {
		const parsed = tryLooseJsonParse(blocks[i]);
		if (parsed) return parsed;
	}

	// Fallback: try to find curly braces in reverse
	const curlyRegex = /(\{[\s\S]*?\})/g;
	const curlyMatches = text.match(curlyRegex);
	if (curlyMatches) {
		for (let i = curlyMatches.length - 1; i >= 0; i--) {
			const parsed = tryLooseJsonParse(curlyMatches[i]);
			if (parsed) return parsed;
		}
	}

	// Another fallback: scan for any JSON-like structure from the end of the text
	const lastBrace = text.lastIndexOf('}');
	if (lastBrace !== -1) {
		const firstBrace = text.lastIndexOf('{', lastBrace);
		if (firstBrace !== -1 && firstBrace < lastBrace) {
			const candidate = text.substring(firstBrace, lastBrace + 1);
			const parsed = tryLooseJsonParse(candidate);
			if (parsed) return parsed;
		}
	}

	writeDetails(`[JSON Parse Failure] Failed to parse JSON block from: \n${text}\n`);
	return null;
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
					// Truncate view_file_git_diff
					if (part.functionResponse.name === 'view_file_git_diff' && typeof response.diff === 'string') {
						if (response.diff.length > 1000) {
							response.diff = response.diff.slice(0, 1000) + '\n[... Diff truncated in history pruning ...]';
							response.is_truncated = true;
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

		case 'view_file_git_diff': {
			return `Viewing git diff for ${basename}`;
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

		// Skip horizontal rules/thematic breaks ('---')
		if (line.trim() === '---') continue;

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

function getPRNameFromPPID(ppid) {
	if (!ppid) return null;
	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	const prMetaPath = path.join(cache_dir, `pr-meta-${ppid}.json`);
	if (fs.existsSync(prMetaPath)) {
		try {
			const meta = JSON.parse(fs.readFileSync(prMetaPath, 'utf8'));
			if (meta) {
				if (meta.owner && meta.repo && meta.pullNumber) {
					return `${meta.owner}/${meta.repo}#${meta.pullNumber}`;
				}
				if (meta.tempDir) {
					const folderName = path.basename(meta.tempDir);
					// Format: nono-pr-owner-repo-pullNumber-timestamp
					const match = folderName.match(/nono-pr-(.+)-([0-9]+)-([0-9]+)$/);
					if (match) {
						const ownerRepo = match[1];
						const pullNumber = match[2];
						const firstHyphenIdx = ownerRepo.indexOf('-');
						if (firstHyphenIdx !== -1) {
							const owner = ownerRepo.substring(0, firstHyphenIdx);
							const repo = ownerRepo.substring(firstHyphenIdx + 1);
							return `${owner}/${repo}#${pullNumber}`;
						}
					}
				}
			}
		} catch (e) {
			// ignore
		}
	}
	return null;
}

function findSessionModelMessages() {
	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	if (!fs.existsSync(cache_dir)) return [];

	const files = fs.readdirSync(cache_dir);
	const sessionFiles = files
		.filter(file => (file.startsWith('session-') || file.startsWith('session-pr-')) && file.endsWith('.json'))
		.map(file => {
			const filePath = path.join(cache_dir, file);
			const stat = fs.statSync(filePath);
			return { path: filePath, mtime: stat.mtimeMs };
		});

	if (sessionFiles.length === 0) return [];

	sessionFiles.sort((a, b) => b.mtime - a.mtime);

	for (const sessionFile of sessionFiles) {
		try {
			const history = JSON.parse(fs.readFileSync(sessionFile.path, 'utf8'));
			if (Array.isArray(history)) {
				const modelTexts = [];
				for (const msg of history) {
					if (msg && msg.role === 'model' && Array.isArray(msg.parts)) {
						const textPart = msg.parts.find(p => p.text);
						if (textPart && textPart.text.trim()) {
							modelTexts.push(textPart.text.trim());
						}
					}
				}
				if (modelTexts.length > 0) {
					return modelTexts;
				}
			}
		} catch (e) {
			// ignore corrupt files
		}
	}
	return [];
}

async function highlightRawMarkdown(md) {
	if (!md) return '';
	const lines = md.split('\n');
	const output_lines = [];
	let in_code_block = false;
	let code_block_lines = [];
	let code_block_lang = '';

	for (let line of lines) {
		if (line.trim().startsWith('```')) {
			if (!in_code_block) {
				in_code_block = true;
				code_block_lang = line.trim().slice(3).trim();
				code_block_lines = [];
				// Highlight the code block opening tag as markdown
				output_lines.push(cliHighlight.highlight(line, { language: 'markdown', ignoreIllegals: true, theme: custom_theme }).trimEnd());
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
				output_lines.push(highlighted_text.trimEnd());
				// Highlight the code block closing tag as markdown
				output_lines.push(cliHighlight.highlight(line, { language: 'markdown', ignoreIllegals: true, theme: custom_theme }).trimEnd());
			}
			continue;
		}

		if (in_code_block) {
			code_block_lines.push(line);
		} else {
			// Highlight standard markdown line
			output_lines.push(cliHighlight.highlight(line, { language: 'markdown', ignoreIllegals: true, theme: custom_theme }).trimEnd());
		}
	}
	return output_lines.join('\n');
}

function updateProgress(raw_text) {
	const line = formatProgressLine(raw_text);
	console.log(line);
}

function clearProgress() {
	// No-op since we don't roll/clear progress lines anymore
}

function formatElapsedTime(seconds) {
	if (seconds >= 60) {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return `${m}m ${s}s`;
	}
	return `${seconds}s`;
}

async function finishProgress(final_text) {
	clearProgress();
	const elapsed = Math.round((Date.now() - start_time) / 1000);
	console.log(`\x1b[90m• Worked for ${formatElapsedTime(elapsed)}\x1b[0m`);
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
	console.log(`\x1b[90m• Worked for ${formatElapsedTime(elapsed)}\x1b[0m`);
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
function askUser(question, play_sound = true) {
	clearProgress();
	if (play_sound) playChime('question');

	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			completer: function completer(line) {
				const lastAtIdx = line.lastIndexOf('@');
				if (lastAtIdx !== -1 && (lastAtIdx === 0 || /\s/.test(line[lastAtIdx - 1]))) {
					const query = line.substring(lastAtIdx + 1); // e.g., "src/u" or "src/" or ""

					let dirPath = '';
					let filePrefix = query;

					if (query.includes('/')) {
						const lastSlashIdx = query.lastIndexOf('/');
						dirPath = query.substring(0, lastSlashIdx + 1); // e.g., "src/"
						filePrefix = query.substring(lastSlashIdx + 1); // e.g., "u"
					}

					const absDir = path.resolve(process.cwd(), dirPath);
					if (fs.existsSync(absDir)) {
						try {
							const stat = fs.statSync(absDir);
							if (stat.isDirectory()) {
								const items = fs.readdirSync(absDir);
								const hits = [];
								for (const item of items) {
									if (item === '.git' || item === 'node_modules' || item === '.cache') {
										continue;
									}
									if (item.startsWith(filePrefix)) {
										const itemPath = path.join(absDir, item);
										let isDir = false;
										try {
											isDir = fs.statSync(itemPath).isDirectory();
										} catch (e) {}

										const itemDisplay = isDir ? item + '/' : item;
										hits.push(dirPath + itemDisplay);
									}
								}
								return [hits.map(h => '@' + h), '@' + query];
							}
						} catch (e) {
							// Ignore
						}
					}
				}
				return [[], line];
			}
		});
		rl.question(question, answer => {
			rl.close();
			resolve(answer);
		});
	});
}

// Reusable helper for key-selected choices with chevron selector
async function chooseOption(options, headerText = null) {
	if (headerText) {
		console.log(headerText);
	}

	let selectedIndex = 0;
	let hasRendered = false;

	// Hide cursor
	process.stdout.write('\x1b[?25l');

	function render() {
		if (hasRendered) {
			process.stdout.write(`\x1b[${options.length}A`);
		}
		hasRendered = true;

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === selectedIndex;
			process.stdout.write('\x1b[2K\r');
			if (isSelected) {
				process.stdout.write(`\x1b[32m\x1b[1m> ${option}\x1b[0m\n`);
			} else {
				process.stdout.write(`  ${option}\n`);
			}
		}
	}

	return new Promise(resolve => {
		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}

		render();

		const keypressHandler = (str, key) => {
			try {
				if ((key && key.ctrl && key.name === 'c') || (key && (key.name === 'escape' || key.name === 'q'))) {
					process.stdout.write('\x1b[?25h');
					if (process.stdin.isTTY) {
						process.stdin.setRawMode(false);
					}
					process.stdin.removeListener('keypress', keypressHandler);
					process.exit(0);
				}

				if (key && key.name === 'up') {
					selectedIndex = (selectedIndex - 1 + options.length) % options.length;
					render();
				} else if (key && key.name === 'down') {
					selectedIndex = (selectedIndex + 1) % options.length;
					render();
				} else if (key && (key.name === 'return' || key.name === 'enter')) {
					process.stdout.write('\x1b[?25h');
					if (process.stdin.isTTY) {
						process.stdin.setRawMode(false);
					}
					process.stdin.pause();
					process.stdin.removeListener('keypress', keypressHandler);
					resolve(selectedIndex);
				}
			} catch (err) {
				// Ignore
			}
		};

		process.stdin.on('keypress', keypressHandler);
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

	if (/\bgit\s+(add|commit)\b/.test(normalized)) {
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
		if (!fs.existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);

		const stat = fs.statSync(dir);
		if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${dir}`);

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

// Helper to compute added and removed lines count between two file states using git diff with a pure JS fallback
function getLineDiff(oldStr, newStr) {
	if (!oldStr) {
		const added = newStr ? newStr.split(/\r?\n/).length : 0;
		return { deleted: 0, added };
	}

	try {
		const tempDir = os.tmpdir();
		const oldTempPath = path.join(tempDir, `nono_diff_old_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.txt`);
		const newTempPath = path.join(tempDir, `nono_diff_new_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.txt`);

		fs.writeFileSync(oldTempPath, oldStr, 'utf8');
		fs.writeFileSync(newTempPath, newStr, 'utf8');

		try {
			let stdout;
			try {
				stdout = execSync(`git diff --no-index --numstat ${JSON.stringify(oldTempPath)} ${JSON.stringify(newTempPath)}`, {
					encoding: 'utf8',
					stdio: ['pipe', 'pipe', 'ignore']
				});
			} catch (err) {
				stdout = err.stdout;
			}

			try {
				fs.unlinkSync(oldTempPath);
			} catch (e) {}
			try {
				fs.unlinkSync(newTempPath);
			} catch (e) {}

			if (stdout) {
				const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
				const parts = stdoutStr.trim().split(/\s+/);
				if (parts.length >= 2) {
					const added = parseInt(parts[0], 10);
					const deleted = parseInt(parts[1], 10);
					if (!isNaN(added) && !isNaN(deleted)) {
						return { added, deleted };
					}
				}
			}
			return { added: 0, deleted: 0 };
		} catch (gitErr) {
			try {
				fs.unlinkSync(oldTempPath);
			} catch (e) {}
			try {
				fs.unlinkSync(newTempPath);
			} catch (e) {}
		}
	} catch (e) {
		// Fall through
	}

	const oldLines = oldStr.split(/\r?\n/);
	const newLines = newStr ? newStr.split(/\r?\n/) : [];
	const m = oldLines.length;
	const n = newLines.length;

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

// Helper to generate standard unified diff between two file states using Diff library
function getFileDiffText(oldStr, newStr, file_path) {
	return Diff.createPatch(file_path, oldStr || '', newStr || '', '', '', { context: 3 });
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

	const diff_text = getFileDiffText(old_content, final_content, file_path);

	const lint_result = runProjectDryRun(abs_path);
	return {
		file_path,
		status: 'success',
		diff: diff_text,
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

	const diff_text = getFileDiffText(old_content, final_content, file_path);

	const lint_result = runProjectDryRun(abs_path);
	return {
		file_path,
		status: 'success',
		diff: diff_text,
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

const IGNORED_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'];

function isIgnoredFile(filepath) {
	return IGNORED_FILES.some(ignored => filepath.endsWith(ignored));
}

function viewFileGitDiff({ base_branch, file_path }) {
	if (file_path && isIgnoredFile(file_path)) {
		return Promise.resolve({ status: 'success', diff: '(Diff ignored for lockfile)' });
	}
	return new Promise(resolve => {
		const cmd = file_path ? `git diff origin/${base_branch}...HEAD -- ${JSON.stringify(file_path)}` : `git diff origin/${base_branch}...HEAD -- . ':!*package-lock.json' ':!*yarn.lock' ':!*pnpm-lock.yaml' ':!*Cargo.lock' ':!*go.sum'`;
		exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
			if (error && error.code !== 1) {
				resolve({ status: 'error', error: stderr || error.message });
			} else {
				resolve({ status: 'success', diff: (stdout || '').trim() || 'No differences.' });
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
	read_terminal_buffer: readTerminalBuffer,
	view_file_git_diff: viewFileGitDiff
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

const view_file_git_diff_declaration = {
	name: 'view_file_git_diff',
	description: 'Shows the line-by-line git diff of a specific file in the PR branch compared to the base branch, or the entire PR git diff if file_path is omitted.',
	parameters: {
		type: 'OBJECT',
		properties: {
			base_branch: { type: 'STRING', description: 'The base branch of the PR.' },
			file_path: { type: 'STRING', description: 'The relative path of the file to inspect. If omitted, returns the diff for all changed files.' }
		},
		required: ['base_branch']
	}
};

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
- Tool Output Summarization: Any tool output exceeding the configured character limit is intercepted and returns a "Tool output is too long" error. In your next turn, describe what specific information, patterns, or sections you want to find. A sub-agent will automatically extract/summarize it for you from the raw output, returning it as the tool response in your subsequent turn. Keep your queries specific to get accurate details.
- Do NOT use emojis, special icons, or graphical characters in your reasoning or output responses. Stick to clean, plain text and standard terminal markdown.
- Git Safety Protocol: Never use "git add" or "git commit" without explicit user instruction.

Guidelines:
- Keep your final output concise and accurate.
- Maintain documentation integrity.
- Always specify the language name (e.g., \`\`\`javascript, \`\`\`python, \`\`\`bash) when writing a markdown code block to ensure proper terminal syntax highlighting.
`;

const pr_review_system_prompt = `You are Nono, performing an expert, codebase-aware Pull Request Review.
You are running in a temporary clone of the repository.

Your objectives:
1. Identify the changed files and overall repository diff from your initial prompt context.
2. Use "view_file_git_diff" (preferably without a file_path to fetch all changes at once in a single call) to see the specific code changes.
3. Keep the analysis highly focused and light-weight: do NOT use "search_grep" or "view_file_contents" to trace dependencies unless you suspect a high-impact bug, architectural regression, or API misalignment.
4. Focus on deep code logic, API consistency, performance issues, architectural alignments, or potential logical bugs.
5. Identify potential bugs, logical issues, or regression risks.
6. Compile a comprehensive, professional PR review report in Markdown format.

Constraints:
- You must NOT modify any files (avoid "write_file" or "patch_file" unless absolutely necessary or requested).
- Do NOT run automated static checks (like ESLint, Prettier, or style formatters) using "execute_system_command". These checks are already done by the GitHub CI/Actions pipeline. Focus instead on semantic correctness and business logic.
- Focus on high-impact feedback. Ignore lockfiles as they are filtered out.
- Tool Output Summarization: Any tool output exceeding the configured character limit is intercepted and returns a "Tool output is too long" error. In your next turn, describe what specific information, patterns, or sections you want to find. A sub-agent will automatically extract/summarize it for you from the raw output, returning it as the tool response in your subsequent turn. Keep your queries specific to get accurate details.

Provide your final report as your final text message without calling any more tools.`;

const pr_review_comment_system_prompt = `You are Nono, performing an expert, codebase-aware Pull Request Review.
You are running in a temporary clone of the repository.

Your objectives:
1. Identify the changed files and overall repository diff from your initial prompt context.
2. Use "view_file_git_diff" (preferably without a file_path to fetch all changes at once in a single call) to see the specific code changes.
3. Keep the analysis highly focused and light-weight: do NOT use "search_grep" or "view_file_contents" to trace dependencies unless you suspect a high-impact bug, architectural regression, or API misalignment.
4. Focus on deep code logic, API consistency, performance issues, architectural alignments, or potential logical bugs.
5. Identify potential bugs, logical issues, or regression risks.

Constraints:
- You must NOT modify any files (avoid "write_file" or "patch_file" unless absolutely necessary or requested).
- Do NOT run automated static checks (like ESLint, Prettier, or style formatters) using "execute_system_command". Focus instead on semantic correctness and business logic.
- Focus on high-impact feedback. Ignore lockfiles as they are filtered out.
- Tool Output Summarization: Any tool output exceeding the configured character limit is intercepted and returns a "Tool output is too long" error. In your next turn, describe what specific information, patterns, or sections you want to find. A sub-agent will automatically extract/summarize it for you from the raw output, returning it as the tool response in your subsequent turn. Keep your queries specific to get accurate details.

Interaction Flow:
- You MUST present issues one by one.
- For each issue, you must output a description/explanation for the user, and you MUST end your message with a JSON block in the following format:
\`\`\`json
{
  "file": "relative/path/to/file",
  "line": <line_number_in_file>,
  "severity": "critical" | "high" | "medium" | "low",
  "message": "A clear, concise, actionable feedback message to be posted as a comment on GitHub."
}
\`\`\`
- Only present ONE issue per turn. Do not present multiple issues at once.
- The file path must be relative to the repository root and must be one of the files changed in the PR.
- The line number must be a valid 1-based line number inside the file where the issue occurs (it must be on one of the added or modified lines in the pull request diff).
- If the user asks questions or provides clarification (e.g. by choosing "write"), answer their question. If you still think there is an issue (or a modified version of it), output the JSON block with the same or updated details. If you realize the issue is not valid after the user's input, explain to the user and ask for the next step.
- Once you have completed analyzing all changed files and there are no more issues to present, or if the user asks you to go to the next issue but no more issues exist, you MUST output:
\`\`\`json
{
  "no_more_issues": true
}
\`\`\`
and state that there are no further issues.`;

// Helper to log token consumption metrics
function logTokenUsage(model, usageMetadata, prompt) {
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
	let loggedPrompt = prompt || '';
	if (loggedPrompt.startsWith('Perform a pull request review for the Github Pull Request:')) {
		const match = loggedPrompt.match(/Perform a pull request review for the Github Pull Request:\s*([^\n\s.]+)/);
		if (match) {
			loggedPrompt = `PR review ${match[1]}`;
		} else {
			loggedPrompt = 'PR review';
		}
	}
	const record = {
		timestamp: new Date().toISOString(),
		ppid: process.ppid,
		pid: process.pid,
		model: model,
		promptTokenCount: usageMetadata.promptTokenCount || 0,
		candidatesTokenCount: usageMetadata.candidatesTokenCount || 0,
		cachedContentTokenCount: usageMetadata.cachedContentTokenCount || 0,
		prompt: loggedPrompt
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

	// Clean up old nono-pr- directories in tmp (older than 2 hours)
	try {
		const files = fs.readdirSync(os.tmpdir());
		const now = Date.now();
		for (const file of files) {
			if (file.startsWith('nono-pr-')) {
				const fullPath = path.join(os.tmpdir(), file);
				const stat = fs.statSync(fullPath);
				if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
					fs.rmSync(fullPath, { recursive: true, force: true });
				}
			}
		}
	} catch (e) {}

	let is_pr_review = false;
	let is_initial_pr_review = false;
	let pr_review_base_branch = '';
	let pr_review_temp_dir = '';
	let user_query = '';
	let isCommentMode = false;
	let isAutoMode = false;
	const prComments = [];
	let lastIssueJson = null;
	let prOwner = '';
	let prRepo = '';
	let prPullNumber = '';
	let githubFetch;

	// Check if we are in a follow-up session for a PR review
	const prMetaPath = path.join(cache_dir, `pr-meta-${process.ppid}.json`);
	if (fs.existsSync(prMetaPath) && process.argv[2] !== '--clear' && process.argv[2] !== '--pr-review' && process.argv[2] !== 'pr-review' && process.argv[2] !== '--commit') {
		try {
			const meta = JSON.parse(fs.readFileSync(prMetaPath, 'utf8'));
			if (meta.tempDir && fs.existsSync(meta.tempDir)) {
				is_pr_review = true;
				pr_review_base_branch = meta.baseBranch;
				pr_review_temp_dir = meta.tempDir;
				process.chdir(pr_review_temp_dir);
			}
		} catch (e) {
			// ignore corrupt meta file
		}
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
  nono                       Start Nono in interactive mode
  nono [prompt]              Run a prompt directly from the command line
  nono --full, -f            Open a temp file in vim to write a prompt
  nono --selection, -s       Retrieve VSCode selection and use it as context with its file path
  nono --usage               Display token consumption and estimated costs (use --list <n> or -l <n> to list last prompts)
  nono --clear               Clear terminal screen, scrollback, and current session history
  nono --resume              List and interactively select previous session context to resume
  nono --commit              Generate commit message suggestions for staged edits and commit
  nono --details             Open the logs and details of the current session in VS Code
  nono --get-pricing         Retrieve model pricing from web search and update configuration
  nono --pr-review [url] [--comment] [--auto] Run a GitHub PR review on the specified PR URL, optionally with interactive comment selection or automatic submission
  nono --raw                 Print the last final message in raw markdown with syntax highlighting
  nono --help, -h            Show this help information
`);
		process.exit(0);
		return;
	}

	// Handle nono --get-pricing command
	if (process.argv[2] === '--get-pricing') {
		console.log('\x1b[35m✦ Fetching current pricing and country information... ✦\x1b[0m\n');

		const countryName = process.env.NONO_COUNTRY || 'France';

		console.log(`Current Model: \x1b[36m${model_name}\x1b[0m`);
		console.log(`Current Location: \x1b[36m${countryName}\x1b[0m`);
		const currency = process.env.NONO_CURRENCY || '€';
		console.log(`Currency: \x1b[36m${currency}\x1b[0m\n`);

		console.log('• Querying Gemini API pricing details via Google Search...');

		const pricingPrompt = `Use Google Search to find the latest developer pricing for the Gemini API model "${model_name}" (specifically input tokens, output tokens, and cached input tokens) ${countryName ? `for users in ${countryName}` : ''} in the currency "${currency}".

Search for the official Google AI Studio/Gemini API pricing. Find:
1. Input token price (per 1 million tokens)
2. Output token price (per 1 million tokens)
3. Cached input token price (per 1 million tokens)

If the pricing is only listed in USD, convert it to ${currency} using the current exchange rate.

Return ONLY a JSON object. Do not include markdown code block formatting (like \`\`\`json). The JSON object MUST have the following structure:
{
  "input_price_per_m": <number>,
  "output_price_per_m": <number>,
  "cache_price_per_m": <number>
}`;

		try {
			const pricingResponse = await ai.models.generateContent({
				model: model_name,
				contents: [{ role: 'user', parts: [{ text: pricingPrompt }] }],
				config: {
					tools: [{ googleSearch: {} }]
				}
			});

			let text = pricingResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
			// Clean up potential markdown code blocks
			text = text
				.replace(/```json/gi, '')
				.replace(/```/g, '')
				.trim();

			let newPricing;
			try {
				newPricing = JSON.parse(text);
			} catch (parseErr) {
				console.error('\x1b[31mError: Failed to parse pricing response from Gemini.\x1b[0m');
				console.log('Raw response:');
				console.log(text);
				process.exit(1);
			}

			// Validate response fields
			const newPriceInput = parseFloat(newPricing.input_price_per_m);
			const newPriceOutput = parseFloat(newPricing.output_price_per_m);
			const newPriceCache = parseFloat(newPricing.cache_price_per_m);

			if (isNaN(newPriceInput) || isNaN(newPriceOutput) || isNaN(newPriceCache)) {
				console.error('\x1b[31mError: Pricing response did not return valid numeric values.\x1b[0m');
				console.log(JSON.stringify(newPricing, null, 2));
				process.exit(1);
			}

			// Current pricing from env (or fallbacks)
			const currentPriceInput = parseFloat(process.env.NONO_PRICE_INPUT_PER_M || process.env.NONO_PRICE_INPUT_EUR_PER_M) || 1.38;
			const currentPriceOutput = parseFloat(process.env.NONO_PRICE_OUTPUT_PER_M || process.env.NONO_PRICE_OUTPUT_EUR_PER_M) || 8.28;
			const currentPriceCache = parseFloat(process.env.NONO_PRICE_CACHE_PER_M || process.env.NONO_PRICE_CACHE_EUR_PER_M) || 0.138;

			// Compare in a table
			console.log('\n\x1b[35m=== Pricing Comparison (per 1 Million Tokens) ===\x1b[0m');
			console.log(`Token Type          │ Current Price │ New Found Price`);
			console.log(`────────────────────┼───────────────┼─────────────────`);

			const pad = (str, length) => str + ' '.repeat(Math.max(0, length - String(str).length));
			const padLeft = (str, length) => ' '.repeat(Math.max(0, length - String(str).length)) + str;

			console.log(`${pad('Input (non-cached)', 19)} │ ${padLeft(`${currentPriceInput.toFixed(2)}${currency}`, 13)} │ ${padLeft(`${newPriceInput.toFixed(2)}${currency}`, 15)}`);
			console.log(`${pad('Cache Hit', 19)} │ ${padLeft(`${currentPriceCache.toFixed(2)}${currency}`, 13)} │ ${padLeft(`${newPriceCache.toFixed(2)}${currency}`, 15)}`);
			console.log(`${pad('Output', 19)} │ ${padLeft(`${currentPriceOutput.toFixed(2)}${currency}`, 13)} │ ${padLeft(`${newPriceOutput.toFixed(2)}${currency}`, 15)}`);
			console.log(`────────────────────┴───────────────┴─────────────────`);

			// Prompt the user
			const answer = await askUser('\nDo you want to update the pricing values? [y/N]: ');
			const norm = answer.trim().toLowerCase();
			if (norm === 'y' || norm === 'yes') {
				const localEnvPath = path.join(process.cwd(), '.env');
				const configEnvPath = path.join(os.homedir(), '.config', 'nono', '.env');
				const scriptEnvPath = path.join(dir_name, '.env');

				let targetEnvPath = '';
				if (fs.existsSync(localEnvPath)) {
					targetEnvPath = localEnvPath;
				} else if (fs.existsSync(configEnvPath)) {
					targetEnvPath = configEnvPath;
				} else {
					targetEnvPath = scriptEnvPath;
				}

				console.log(`Updating configuration in: ${targetEnvPath}...`);

				let envContent = '';
				if (fs.existsSync(targetEnvPath)) {
					envContent = fs.readFileSync(targetEnvPath, 'utf8');
				}

				const lines = envContent.split(/\r?\n/);
				const keysToUpdate = {
					NONO_PRICE_INPUT_PER_M: newPriceInput.toString(),
					NONO_PRICE_OUTPUT_PER_M: newPriceOutput.toString(),
					NONO_PRICE_CACHE_PER_M: newPriceCache.toString()
				};

				const keysToRemove = ['NONO_PRICE_INPUT_EUR_PER_M', 'NONO_PRICE_OUTPUT_EUR_PER_M', 'NONO_PRICE_CACHE_EUR_PER_M'];

				let updatedLines = [];
				const processedKeys = new Set();

				for (let line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('#') || trimmed === '') {
						updatedLines.push(line);
						continue;
					}
					const eqIdx = trimmed.indexOf('=');
					if (eqIdx !== -1) {
						const key = trimmed.slice(0, eqIdx).trim();
						if (keysToRemove.includes(key)) {
							continue;
						}
						if (keysToUpdate[key] !== undefined) {
							updatedLines.push(`${key}=${keysToUpdate[key]}`);
							processedKeys.add(key);
						} else {
							updatedLines.push(line);
						}
					} else {
						updatedLines.push(line);
					}
				}

				for (const [key, val] of Object.entries(keysToUpdate)) {
					if (!processedKeys.has(key)) {
						updatedLines.push(`${key}=${val}`);
					}
				}

				fs.writeFileSync(targetEnvPath, updatedLines.join('\n'), 'utf8');
				console.log('\x1b[32m✔ Pricing values updated successfully in .env file!\x1b[0m\n');
			} else {
				console.log('Update cancelled. Pricing kept unchanged.');
			}
		} catch (err) {
			console.error(`\x1b[31mError during pricing lookup: ${err.message || err}\x1b[0m`);
			process.exit(1);
		}
		process.exit(0);
		return;
	}

	// Handle nono --clear argument
	if (process.argv[2] === '--clear') {
		// Clear terminal screen and scrollback
		process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

		// Delete session and details files for current session
		const session_path = path.join(cache_dir, `session-${process.ppid}.json`);
		const session_pr_path = path.join(cache_dir, `session-pr-${process.ppid}.json`);
		const details_file = path.join(cache_dir, `details-${process.ppid}.log`);
		const pr_meta_path = path.join(cache_dir, `pr-meta-${process.ppid}.json`);

		try {
			if (fs.existsSync(session_path)) {
				fs.unlinkSync(session_path);
			}
			if (fs.existsSync(session_pr_path)) {
				fs.unlinkSync(session_pr_path);
			}
			if (fs.existsSync(details_file)) {
				fs.unlinkSync(details_file);
			}
			if (fs.existsSync(pr_meta_path)) {
				try {
					const meta = JSON.parse(fs.readFileSync(pr_meta_path, 'utf8'));
					if (meta.tempDir && fs.existsSync(meta.tempDir)) {
						fs.rmSync(meta.tempDir, { recursive: true, force: true });
					}
				} catch (e) {}
				fs.unlinkSync(pr_meta_path);
			}
			console.log('\x1b[32m✔ Nono session cleared. Ready for a new chat!\x1b[0m\n');
		} catch (err) {
			console.error(`\x1b[31mError clearing session: ${err.message}\x1b[0m`);
			process.exit(1);
		}
		process.exit(0);
		return;
	}

	// Handle nono --resume argument
	if (process.argv[2] === '--resume') {
		const files = fs.readdirSync(cache_dir);
		const sessions = [];
		for (const file of files) {
			if ((file.startsWith('session-') || file.startsWith('session-pr-')) && file.endsWith('.json')) {
				const filePath = path.join(cache_dir, file);
				try {
					const stat = fs.statSync(filePath);
					const content = fs.readFileSync(filePath, 'utf8');
					const history = JSON.parse(content);
					if (Array.isArray(history) && history.length > 0) {
						// Extract first prompt
						let firstPrompt = 'No prompt found';
						for (const msg of history) {
							if (msg && msg.role === 'user' && Array.isArray(msg.parts)) {
								const textPart = msg.parts.find(p => p.text);
								if (textPart && textPart.text) {
									const text = textPart.text.trim();
									if (!text.startsWith('[System Memory:')) {
										let cleanText = text;
										const bonusIdx = cleanText.indexOf('\n\n[');
										if (bonusIdx !== -1) {
											cleanText = cleanText.substring(0, bonusIdx).trim();
										}
										firstPrompt = cleanText || 'Empty prompt';
										break;
									}
								}
							}
						}

						sessions.push({
							file,
							path: filePath,
							mtime: stat.mtimeMs,
							prompt: firstPrompt,
							history
						});
					}
				} catch (e) {
					// ignore corrupt files
				}
			}
		}

		if (sessions.length === 0) {
			console.log('\x1b[31m✦ No sessions available to resume.\x1b[0m');
			process.exit(0);
			return;
		}

		sessions.sort((a, b) => b.mtime - a.mtime);

		// Limit to top 15 most recent sessions
		const displayedSessions = sessions.slice(0, 15);

		const cols = process.stdout.columns || 80;
		const limit = Math.max(40, cols - 30);

		const formattedSessions = displayedSessions.map(s => {
			let clean = s.prompt.replace(/\s+/g, ' ').trim();
			if (clean.length > limit) {
				clean = clean.substring(0, limit - 3) + '...';
			}
			return {
				...s,
				displayPrompt: clean
			};
		});

		const options = formattedSessions.map(s => {
			const dateStr = new Date(s.mtime).toLocaleString();
			return `${s.displayPrompt} \x1b[90m(${dateStr})\x1b[0m`;
		});

		let selectedIndex;
		try {
			selectedIndex = await chooseOption(options, '\x1b[35mSelect a session to resume:\x1b[0m');
		} catch (e) {
			console.error(e);
			process.exit(1);
		}

		const session = formattedSessions[selectedIndex];

		// Copy/Link the chosen session file to the current process's session file
		const currentSessionPath = session.file.startsWith('session-pr-') ? path.join(cache_dir, `session-pr-${process.ppid}.json`) : path.join(cache_dir, `session-${process.ppid}.json`);

		// Clear other mode's session/meta to avoid collision
		if (session.file.startsWith('session-pr-')) {
			const standardPath = path.join(cache_dir, `session-${process.ppid}.json`);
			if (fs.existsSync(standardPath)) {
				fs.unlinkSync(standardPath);
			}
			const oldPpid = session.file.replace('session-pr-', '').replace('.json', '');
			const oldMetaPath = path.join(cache_dir, `pr-meta-${oldPpid}.json`);
			const currentMetaPath = path.join(cache_dir, `pr-meta-${process.ppid}.json`);
			if (fs.existsSync(oldMetaPath)) {
				try {
					fs.copyFileSync(oldMetaPath, currentMetaPath);
				} catch (e) {}
			}
		} else {
			const prPath = path.join(cache_dir, `session-pr-${process.ppid}.json`);
			if (fs.existsSync(prPath)) {
				fs.unlinkSync(prPath);
			}
			const currentMetaPath = path.join(cache_dir, `pr-meta-${process.ppid}.json`);
			if (fs.existsSync(currentMetaPath)) {
				fs.unlinkSync(currentMetaPath);
			}
		}

		try {
			fs.writeFileSync(currentSessionPath, JSON.stringify(session.history, null, 2), 'utf8');
		} catch (e) {
			console.error(`\x1b[31mError writing session file: ${e.message}\x1b[0m`);
			process.exit(1);
		}

		// Print all retrieved messages
		console.log(`\n\x1b[32m✔ Resumed session: ${session.prompt}\x1b[0m`);
		console.log(`\x1b[90m--------------------------------------------------\x1b[0m`);

		for (const msg of session.history) {
			if (!msg || !Array.isArray(msg.parts)) continue;

			if (msg.role === 'user') {
				const textPart = msg.parts.find(p => p.text);
				if (textPart && textPart.text) {
					const text = textPart.text.trim();
					if (text.startsWith('[System Memory:')) {
						const cleanMemory = text
							.replace(/^\[System Memory:\s*/, '')
							.replace(/\]$/, '')
							.trim();
						console.log(`\n\x1b[33m🧠 System Memory:\x1b[0m`);
						console.log(`\x1b[90m${cleanMemory}\x1b[0m`);
					} else {
						let cleanText = text;
						const bonusIdx = cleanText.indexOf('\n\n[');
						if (bonusIdx !== -1) {
							cleanText = cleanText.substring(0, bonusIdx).trim();
						}
						console.log(`\n\x1b[36m\x1b[1m👤 User:\x1b[0m \x1b[1m${cleanText}\x1b[0m`);
					}
				}
			} else if (msg.role === 'model') {
				const textPart = msg.parts.find(p => p.text);
				if (textPart && textPart.text) {
					const modelText = textPart.text.trim();
					try {
						const highlighted = await highlightRawMarkdown(modelText);
						console.log(`\n\x1b[35m✦ Nono:\x1b[0m\n${highlighted}`);
					} catch (err) {
						console.log(`\n\x1b[35m✦ Nono:\x1b[0m\n${modelText}`);
					}
				}
			}
		}
		console.log(`\n\x1b[90m--------------------------------------------------\x1b[0m`);
		console.log(`\x1b[32mSession context loaded! The next nono command will continue this session.\x1b[0m\n`);

		process.exit(0);
		return;
	}

	// Handle nono --commit command
	if (process.argv[2] === '--commit') {
		// 1. Verify inside git repo
		try {
			execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
		} catch (e) {
			console.log('\x1b[31m✦ Not a git repository (or any of the parent directories)\x1b[0m');
			process.exit(1);
		}

		// 2. Fetch cached/staged diff
		const diff = execSync('git diff --cached', { encoding: 'utf8' }).trim();
		if (!diff) {
			console.log('\x1b[31m✦ No staged changes found. Use "git add" to stage files first.\x1b[0m');
			process.exit(1);
		}

		console.log('\x1b[35m✦ Generating git commit message suggestions... ✦\x1b[0m\n');

		// 3. Call Gemini to generate suggestions
		try {
			const prompt = `You are an expert assistant generating professional git commit messages based on staged changes (the git diff).
Here is the staged git diff:
<git_diff>
${diff}
</git_diff>

Based on these changes, generate exactly 3 distinct, professional, and descriptive git commit message suggestions.
Follow the Conventional Commits style (e.g., feat(scope): message, fix: message, chore: message, docs: message, style: message, refactor: message) where appropriate.
Keep each suggestion concise (ideally under 72 characters) and on a single line.

Return ONLY the 3 suggestions, each on its own line, with absolutely no numbering, bullet points, headers, explanations, markdown formatting (no code blocks), or other text.
Example response:
feat: implement payment gateway integration
refactor: streamline user authentication middleware
fix: resolve null pointer exception in checkout flow`;

			const response = await ai.models.generateContent({
				model: model_name,
				contents: [{ role: 'user', parts: [{ text: prompt }] }]
			});

			const text = response.text || '';
			const suggestions = text
				.split('\n')
				.map(line => line.replace(/^[\s-*•\d.]+\s*/, '').trim())
				.filter(line => line.length > 0)
				.slice(0, 3);

			if (suggestions.length === 0) {
				console.log('\x1b[31m✦ Could not generate suggestions. Please try again or write your own message.\x1b[0m');
				process.exit(1);
			}

			const options = [...suggestions, 'Write my own commit message...'];

			const selectedIdx = await chooseOption(options, '\x1b[35mSelect a git commit message suggestion:\x1b[0m');
			let commitMessage = '';

			if (selectedIdx === suggestions.length) {
				// User wants to write their own message
				process.stdout.write('\n');
				commitMessage = await askUser('Enter your custom commit message: ', false);
				commitMessage = commitMessage.trim();
				if (!commitMessage) {
					console.log('\x1b[31m✦ Commit message cannot be empty. Cancelled.\x1b[0m');
					process.exit(1);
				}
			} else {
				commitMessage = options[selectedIdx];
			}

			console.log(`\n\x1b[36m✦ Committing changes with message: "${commitMessage}"...\x1b[0m`);
			const commitOutput = execSync(`git commit -m ${JSON.stringify(commitMessage)}`, { encoding: 'utf8' });
			console.log(commitOutput);
			console.log('\x1b[32m✔ Commit successful!\x1b[0m');
		} catch (err) {
			console.error(`\x1b[31mError during commit generation or execution: ${err.stdout || err.message}\x1b[0m`);
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

		let listCount = null;
		const listIdx = process.argv.findIndex(arg => arg === '--list' || arg === '-l');
		if (listIdx !== -1) {
			listCount = 10;
			if (listIdx < process.argv.length - 1) {
				const count = parseInt(process.argv[listIdx + 1], 10);
				if (!isNaN(count) && count > 0) {
					listCount = count;
				}
			}
		}

		if (listCount !== null) {
			const currency = process.env.NONO_CURRENCY || '€';
			const priceInput = parseFloat(process.env.NONO_PRICE_INPUT_PER_M || process.env.NONO_PRICE_INPUT_EUR_PER_M) || 1.38;
			const priceOutput = parseFloat(process.env.NONO_PRICE_OUTPUT_PER_M || process.env.NONO_PRICE_OUTPUT_EUR_PER_M) || 8.28;
			const priceCache = parseFloat(process.env.NONO_PRICE_CACHE_PER_M || process.env.NONO_PRICE_CACHE_EUR_PER_M) || 0.138;

			// Group logs by run (pid) or contiguous timestamps (legacy)
			const groupedLogs = [];
			let currentGroup = null;

			for (const log of logs) {
				const hasPid = typeof log.pid === 'number';
				const logTime = new Date(log.timestamp).getTime();

				let shouldGroup = false;

				if (currentGroup) {
					if (hasPid && currentGroup.pid === log.pid) {
						shouldGroup = true;
					} else if (!hasPid && !currentGroup.pid && currentGroup.ppid === log.ppid) {
						const groupTime = new Date(currentGroup.timestamp).getTime();
						if (Math.abs(logTime - groupTime) < 300000) {
							shouldGroup = true;
						}
					}
				}

				if (shouldGroup && currentGroup) {
					currentGroup.promptTokenCount += log.promptTokenCount || 0;
					currentGroup.candidatesTokenCount += log.candidatesTokenCount || 0;
					currentGroup.cachedContentTokenCount += log.cachedContentTokenCount || 0;
					if (!currentGroup.prompt && log.prompt) {
						currentGroup.prompt = log.prompt;
					}
				} else {
					currentGroup = {
						timestamp: log.timestamp,
						ppid: log.ppid,
						pid: log.pid,
						model: log.model,
						promptTokenCount: log.promptTokenCount || 0,
						candidatesTokenCount: log.candidatesTokenCount || 0,
						cachedContentTokenCount: log.cachedContentTokenCount || 0,
						prompt: log.prompt || ''
					};
					groupedLogs.push(currentGroup);
				}
			}

			const lastLogs = groupedLogs.slice(-listCount);

			console.log(`\n\x1b[35m=== Last ${lastLogs.length} Prompts Cost ===\x1b[0m\n`);

			const headers = ['Day Time', 'Prompt (truncated to 60 chars)', 'Cost'];
			const colWidths = [19, 60, 10];

			const pad = (str, length, align = 'left') => {
				str = String(str);
				if (str.length >= length) return str.slice(0, length);
				const diff = length - str.length;
				if (align === 'right') {
					return ' '.repeat(diff) + str;
				}
				return str + ' '.repeat(diff);
			};

			const headerStr = pad(headers[0], colWidths[0], 'left') + ' | ' + pad(headers[1], colWidths[1], 'left') + ' | ' + pad(headers[2], colWidths[2], 'right');
			console.log(`\x1b[1;37m${headerStr}\x1b[0m`);

			const separator = '─'.repeat(colWidths[0]) + '─+─' + '─'.repeat(colWidths[1]) + '─+─' + '─'.repeat(colWidths[2]);
			console.log(`\x1b[90m${separator}\x1b[0m`);

			let totalCostSum = 0;

			for (const log of lastLogs) {
				const d = new Date(log.timestamp);
				const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

				const inputVal = (log.promptTokenCount || 0) - (log.cachedContentTokenCount || 0);
				const cacheVal = log.cachedContentTokenCount || 0;
				const outputVal = log.candidatesTokenCount || 0;

				const costInput = (inputVal * priceInput) / 1000000;
				const costCache = (cacheVal * priceCache) / 1000000;
				const costOutput = (outputVal * priceOutput) / 1000000;
				const totalCost = costInput + costCache + costOutput;

				totalCostSum += totalCost;

				let displayPrompt = log.prompt || '';
				if (!displayPrompt) {
					if (log.cachedContentTokenCount > 0 || log.promptTokenCount > 5000) {
						const legacyPrName = getPRNameFromPPID(log.ppid);
						displayPrompt = legacyPrName ? `PR review ${legacyPrName}` : 'PR review';
					} else {
						displayPrompt = `(${log.model || 'unknown model'})`;
					}
				}
				displayPrompt = displayPrompt.replace(/\s+/g, ' ');
				if (displayPrompt.length > colWidths[1]) {
					displayPrompt = displayPrompt.slice(0, colWidths[1] - 3) + '...';
				}

				const formattedCost = `${totalCost.toFixed(2)}${currency}`;

				const line = pad(dateStr, colWidths[0], 'left') + ' | ' + pad(displayPrompt, colWidths[1], 'left') + ' | ' + pad(formattedCost, colWidths[2], 'right');
				console.log(line);
			}

			console.log(`\x1b[90m${separator}\x1b[0m`);

			const totalCostStr = `${totalCostSum.toFixed(2)}${currency}`;
			const totalLine = pad('Total', colWidths[0], 'left') + ' | ' + pad('-', colWidths[1], 'left') + ' | ' + pad(totalCostStr, colWidths[2], 'right');
			console.log(`\x1b[1m${totalLine}\x1b[0m\n`);

			process.exit(0);
		}

		const currency = process.env.NONO_CURRENCY || '€';
		const priceInput = parseFloat(process.env.NONO_PRICE_INPUT_PER_M || process.env.NONO_PRICE_INPUT_EUR_PER_M) || 1.38;
		const priceOutput = parseFloat(process.env.NONO_PRICE_OUTPUT_PER_M || process.env.NONO_PRICE_OUTPUT_EUR_PER_M) || 8.28;
		const priceCache = parseFloat(process.env.NONO_PRICE_CACHE_PER_M || process.env.NONO_PRICE_CACHE_EUR_PER_M) || 0.138;

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
		const headerStr1 = pad(headers1[0], colWidths1[0], 'left') + ' │ ' + pad(headers1[1], colWidths1[1], 'right') + ' │ ' + pad(headers1[2], colWidths1[2], 'right') + ' │ ' + pad(headers1[3], colWidths1[3], 'right');
		console.log(`\x1b[1;37m${headerStr1}\x1b[0m`);

		// Print Separator
		const separator1 = '─'.repeat(colWidths1[0]) + '─┼─' + '─'.repeat(colWidths1[1]) + '─┼─' + '─'.repeat(colWidths1[2]) + '─┼─' + '─'.repeat(colWidths1[3]);
		console.log(`\x1b[90m${separator1}\x1b[0m`);

		const printRow1 = (label, priceStr, tokens, cost) => {
			const formattedTokens = tokens.toLocaleString();
			const formattedCost = label === 'Total' ? `${cost.toFixed(2)}${currency}` : `${cost.toFixed(2)}${currency}`;

			const line = pad(label, colWidths1[0], 'left') + ' │ ' + pad(priceStr, colWidths1[1], 'right') + ' │ ' + pad(formattedTokens, colWidths1[2], 'right') + ' │ ' + pad(formattedCost, colWidths1[3], 'right');

			if (label === 'Total') {
				console.log(`\x1b[1m${line}\x1b[0m`);
			} else {
				console.log(line);
			}
		};

		printRow1('Input (non-cached)', `${priceInput.toFixed(2)}${currency}`, sessionInput, sessionCostInput);
		printRow1('Cache Hit', `${priceCache.toFixed(2)}${currency}`, sessionCache, sessionCostCache);
		printRow1('Output', `${priceOutput.toFixed(2)}${currency}`, sessionOutput, sessionCostOutput);

		console.log(`\x1b[90m${separator1}\x1b[0m`);
		printRow1('Total', '-', sessionTotalTokens, sessionTotalCost);
		console.log();

		// ----------------------------------------------------
		// 2. Monthly Consumption & Projections Table
		// ----------------------------------------------------
		const monthsList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		const monthName = monthsList[month];

		console.log(`\x1b[1;35m✦ Monthly Consumption & Projections (${monthName} ${year})\x1b[0m`);

		const headers2 = ['Token Type', 'Price / 1M', 'Month Tokens', 'Month Cost', 'Projected Cost'];
		const colWidths2 = [20, 12, 14, 12, 16];

		// Print Headers
		const headerStr2 =
			pad(headers2[0], colWidths2[0], 'left') +
			' │ ' +
			pad(headers2[1], colWidths2[1], 'right') +
			' │ ' +
			pad(headers2[2], colWidths2[2], 'right') +
			' │ ' +
			pad(headers2[3], colWidths2[3], 'right') +
			' │ ' +
			pad(headers2[4], colWidths2[4], 'right');
		console.log(`\x1b[1;37m${headerStr2}\x1b[0m`);

		// Print Separator
		const separator2 = '─'.repeat(colWidths2[0]) + '─┼─' + '─'.repeat(colWidths2[1]) + '─┼─' + '─'.repeat(colWidths2[2]) + '─┼─' + '─'.repeat(colWidths2[3]) + '─┼─' + '─'.repeat(colWidths2[4]);
		console.log(`\x1b[90m${separator2}\x1b[0m`);

		const printRow2 = (label, priceStr, tokens, cost, projectedCost) => {
			const formattedTokens = tokens.toLocaleString();
			const formattedCost = `${cost.toFixed(2)}${currency}`;
			const formattedProjected = `${projectedCost.toFixed(2)}${currency}`;

			const line =
				pad(label, colWidths2[0], 'left') +
				' │ ' +
				pad(priceStr, colWidths2[1], 'right') +
				' │ ' +
				pad(formattedTokens, colWidths2[2], 'right') +
				' │ ' +
				pad(formattedCost, colWidths2[3], 'right') +
				' │ ' +
				pad(formattedProjected, colWidths2[4], 'right');

			if (label === 'Total') {
				console.log(`\x1b[1m${line}\x1b[0m`);
			} else {
				console.log(line);
			}
		};

		printRow2('Input (non-cached)', `${priceInput.toFixed(2)}${currency}`, monthInput, monthCostInput, projectedCostInput);
		printRow2('Cache Hit', `${priceCache.toFixed(2)}${currency}`, monthCache, monthCostCache, projectedCostCache);
		printRow2('Output', `${priceOutput.toFixed(2)}${currency}`, monthOutput, monthCostOutput, projectedCostOutput);

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

	// Handle nono --raw argument
	if (process.argv[2] === '--raw') {
		const messages = findSessionModelMessages();
		if (messages.length > 0) {
			try {
				const highlightedMessages = [];
				for (const msg of messages) {
					const highlighted = await highlightRawMarkdown(msg);
					highlightedMessages.push(highlighted);
				}
				console.log(highlightedMessages.join('\n\n'));
			} catch (err) {
				// Fallback to plain text if highlighting fails
				console.log(messages.join('\n\n'));
			}
			process.exit(0);
		} else {
			console.error('\x1b[31mError: No previous final message found in session history.\x1b[0m');
			process.exit(1);
		}
		return;
	}

	// Handle nono --pr-review <pr-url> command
	if (process.argv[2] === '--pr-review' || process.argv[2] === 'pr-review') {
		is_initial_pr_review = true;
		const prUrl = process.argv[3];
		if (!prUrl) {
			console.error('\x1b[31mError: Pull request URL is required.\x1b[0m');
			console.error('Usage: nono --pr-review <github-pr-url> [--comment] [--auto]');
			playChime('error');
			process.exit(1);
		}

		isCommentMode = process.argv.includes('--comment') || process.argv.includes('--auto');
		isAutoMode = process.argv.includes('--auto');

		const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
		if (!match) {
			console.error('\x1b[31mError: Invalid Github Pull Request URL.\x1b[0m');
			console.error('Expected format: https://github.com/owner/repo/pull/number');
			playChime('error');
			process.exit(1);
		}

		const [_, owner, repo, pullNumber] = match;
		prOwner = owner;
		prRepo = repo;
		prPullNumber = pullNumber;

		const githubToken = process.env.GITHUB_ACCESS_TOKEN;
		if (!githubToken) {
			console.error('\x1b[31mError: GITHUB_ACCESS_TOKEN is not set.\x1b[0m');
			console.error('Please configure GITHUB_ACCESS_TOKEN in your .env file.');
			playChime('error');
			process.exit(1);
		}

		console.log(`\x1b[35m✦ Initiating Github PR Review for ${owner}/${repo}#${pullNumber}... ✦\x1b[0m\n`);

		githubFetch = async function (url, options = {}) {
			const headers = {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${githubToken}`,
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'Nono-CLI',
				...options.headers
			};
			if (options.body && !headers['Content-Type']) {
				headers['Content-Type'] = 'application/json';
			}
			const response = await fetch(url, {
				method: options.method || 'GET',
				headers,
				body: options.body
			});
			if (!response.ok) {
				const oauthScopes = response.headers.get('x-oauth-scopes') || 'none';
				const acceptedScopes = response.headers.get('x-accepted-oauth-scopes') || 'none';
				throw new Error(`GitHub API returned ${response.status}: ${response.statusText}\n  [Diagnostics: Token scopes: "${oauthScopes}", Required/Accepted scopes: "${acceptedScopes}"]`);
			}
			return response.json();
		};

		let tempDir;
		const cleanup = () => {
			try {
				if (tempDir && fs.existsSync(tempDir)) {
					fs.rmSync(tempDir, { recursive: true, force: true });
				}
			} catch (e) {}
		};

		try {
			updateProgress('• Fetching pull request details from GitHub...');
			const prData = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`);
			const prTitle = prData.title;
			const prAuthor = prData.user.login;
			pr_review_base_branch = prData.base.ref;
			const compareBranch = prData.head.ref;
			const headRepoFullName = prData.head.repo.full_name;

			updateProgress('• Fetching list of changed files...');
			const filesData = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files`);

			const filteredFiles = filesData.filter(file => !isIgnoredFile(file.filename));

			updateProgress(`• Cloning repository branch "${compareBranch}" for analysis...`);
			tempDir = path.join(os.tmpdir(), `nono-pr-${owner}-${repo}-${pullNumber}-${Date.now()}`);
			pr_review_temp_dir = tempDir;

			const shellEscape = arg => `'` + String(arg).replace(/'/g, "'\\''") + `'`;
			const cloneUrl = `https://${githubToken}@github.com/${headRepoFullName}.git`;
			const cloneCmd = `git clone --no-single-branch --branch ${shellEscape(compareBranch)} ${shellEscape(cloneUrl)} ${shellEscape(tempDir)}`;

			execSync(cloneCmd, { stdio: 'ignore' });

			// Switch working directory to the cloned repo
			process.chdir(tempDir);

			// Pre-fetch the repo diff to provide it in the initial prompt
			let repoDiff = '';
			try {
				repoDiff = execSync(`git diff --name-status origin/${pr_review_base_branch}...HEAD`, { encoding: 'utf8' }).trim();
			} catch (e) {
				try {
					repoDiff = execSync(`git diff --name-status origin/${pr_review_base_branch} HEAD`, { encoding: 'utf8' }).trim();
				} catch (e2) {
					repoDiff = '(Could not retrieve git diff automatically)';
				}
			}

			if (repoDiff && repoDiff !== '(Could not retrieve git diff automatically)') {
				repoDiff = repoDiff
					.split('\n')
					.filter(line => {
						if (!line) return false;
						const parts = line.split(/\s+/);
						const filepath = parts[parts.length - 1];
						return !isIgnoredFile(filepath);
					})
					.join('\n');
			}

			// Fetch the full diff (excluding lockfiles) to include in prompt if small
			let fullGitDiff = '';
			try {
				fullGitDiff = execSync(`git diff origin/${pr_review_base_branch}...HEAD -- . ':!*package-lock.json' ':!*yarn.lock' ':!*pnpm-lock.yaml' ':!*Cargo.lock' ':!*go.sum'`, { encoding: 'utf8' }).trim();
			} catch (e) {
				try {
					fullGitDiff = execSync(`git diff origin/${pr_review_base_branch} HEAD -- . ':!*package-lock.json' ':!*yarn.lock' ':!*pnpm-lock.yaml' ':!*Cargo.lock' ':!*go.sum'`, { encoding: 'utf8' }).trim();
				} catch (e2) {}
			}

			let diffContext = '';
			if (fullGitDiff && fullGitDiff.length < 15000) {
				diffContext = `\nHere is the full git diff for this PR:\n\`\`\`diff\n${fullGitDiff}\n\`\`\`\n`;
			}

			is_pr_review = true;
			if (isCommentMode) {
				user_query = `Perform a pull request review for the Github Pull Request: ${owner}/${repo}#${pullNumber}.
Title: ${prTitle}
Author: ${prAuthor}
Base branch: ${pr_review_base_branch}
Compare branch: ${compareBranch}

Here is the list of changed files in this PR (excluding lockfiles):
${filteredFiles.map(f => `- ${f.filename} (+${f.additions} -${f.deletions})`).join('\n')}

Here is the status of modified files against the base branch:
\`\`\`
${repoDiff || 'No differences found.'}
\`\`\`
${diffContext}
Analyze the changed files, identify potential bugs or logic errors, and present the first issue you find. Remember to output the JSON block with the file path, line number, and message for this issue.`;
			} else {
				user_query = `Perform a pull request review for the Github Pull Request: ${owner}/${repo}#${pullNumber}.
Title: ${prTitle}
Author: ${prAuthor}
Base branch: ${pr_review_base_branch}
Compare branch: ${compareBranch}

Here is the list of changed files in this PR (excluding lockfiles):
${filteredFiles.map(f => `- ${f.filename} (+${f.additions} -${f.deletions})`).join('\n')}

Here is the status of modified files against the base branch:
\`\`\`
${repoDiff || 'No differences found.'}
\`\`\`
${diffContext}
Analyze the changed files, trace references in the codebase, and write your final PR review report in Markdown format.`;
			}

			// Save metadata to support subsequent follow-up commands in the same shell
			const prMetaPath = path.join(cache_dir, `pr-meta-${process.ppid}.json`);
			fs.writeFileSync(
				prMetaPath,
				JSON.stringify({
					tempDir,
					baseBranch: pr_review_base_branch,
					owner,
					repo,
					pullNumber
				}),
				'utf8'
			);
		} catch (err) {
			cleanup();
			console.error(`\x1b[31mError during PR review setup: ${err.message || err}\x1b[0m`);
			playChime('error');
			process.exit(1);
		}
	}

	// Helper functions for VSCode selection feature
	function globFiles(dir, maxDepth = 4, currentDepth = 0) {
		if (currentDepth > maxDepth) return [];
		let results = [];
		try {
			const list = fs.readdirSync(dir);
			for (const file of list) {
				if (['.git', 'node_modules', 'dist', 'build', 'venv', '.venv', 'target', '.cache'].includes(file)) continue;
				const fullPath = path.join(dir, file);
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory()) {
					results = results.concat(globFiles(fullPath, maxDepth, currentDepth + 1));
				} else if (stat.isFile()) {
					results.push(fullPath);
				}
			}
		} catch (e) {}
		return results;
	}

	function findFileContainingSelection(selection, rootDir) {
		if (!selection) return null;
		const trimmed = selection.trim();
		if (trimmed.length < 5) return null;

		const normalizedSelection = trimmed.replace(/\r\n/g, '\n');

		let files = [];
		if (rootDir) {
			try {
				const gitOutput = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
				files = gitOutput
					.split('\n')
					.filter(Boolean)
					.map(f => path.join(rootDir, f));
			} catch (e) {
				files = globFiles(rootDir);
			}
		} else {
			files = globFiles(process.cwd());
		}

		const fileStats = [];
		for (const file of files) {
			try {
				const stats = fs.statSync(file);
				if (stats.isFile() && stats.size <= 1024 * 1024) {
					fileStats.push({ file, mtime: stats.mtimeMs });
				}
			} catch (e) {}
		}

		// Prioritize recently modified files
		fileStats.sort((a, b) => b.mtime - a.mtime);

		for (const item of fileStats) {
			try {
				const content = fs.readFileSync(item.file, 'utf8');
				const normalizedContent = content.replace(/\r\n/g, '\n');
				if (normalizedContent.includes(normalizedSelection)) {
					return item.file;
				}
			} catch (e) {}
		}

		return null;
	}

	function getLanguageFromExtension(filePath) {
		if (!filePath) return 'javascript';
		const ext = path.extname(filePath).toLowerCase();
		const extensionMap = {
			'.js': 'javascript',
			'.mjs': 'javascript',
			'.cjs': 'javascript',
			'.ts': 'typescript',
			'.tsx': 'typescript',
			'.jsx': 'javascript',
			'.py': 'python',
			'.rs': 'rust',
			'.go': 'go',
			'.java': 'java',
			'.cpp': 'cpp',
			'.c': 'c',
			'.h': 'cpp',
			'.cs': 'csharp',
			'.sh': 'bash',
			'.bash': 'bash',
			'.zsh': 'bash',
			'.rb': 'ruby',
			'.php': 'php',
			'.html': 'html',
			'.css': 'css',
			'.json': 'json',
			'.yml': 'yaml',
			'.yaml': 'yaml',
			'.md': 'markdown',
			'.toml': 'ini',
			'.ini': 'ini',
			'.sql': 'sql',
			'.xml': 'xml'
		};
		return extensionMap[ext] || 'plain';
	}

	function getVscodeSelection() {
		const commands = ['wl-paste -p', 'wl-paste', 'xclip -o -selection primary', 'xclip -o -selection clipboard', 'xsel -p -o', 'xsel -b -o'];

		for (const cmd of commands) {
			try {
				const output = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
				if (output && output.trim()) {
					return output;
				}
			} catch (e) {
				// ignore and try next
			}
		}
		return null;
	}

	// Capture CLI arguments
	if (!is_initial_pr_review) {
		let hasSelectionFlag = false;
		let selection_context = '';

		const selectionIdx = process.argv.findIndex((arg, i) => i >= 2 && (arg === '-s' || arg === '--selection'));
		if (selectionIdx !== -1) {
			hasSelectionFlag = true;
			process.argv.splice(selectionIdx, 1);
		}

		if (hasSelectionFlag) {
			const selectionText = getVscodeSelection();
			if (!selectionText || !selectionText.trim()) {
				console.error('\x1b[31mError: No selected text found in VS Code / system clipboard.\x1b[0m');
				console.error('Please highlight some text in VS Code first.');
				process.exit(1);
			}

			const root = is_pr_review ? pr_review_temp_dir : findProjectRoot();
			const detectedFile = findFileContainingSelection(selectionText, root);
			const detectedLang = getLanguageFromExtension(detectedFile);

			console.log('\n\x1b[36m✦ VSCode Selected Text Detected:\x1b[0m');
			if (detectedFile) {
				const relativePath = path.relative(root || process.cwd(), detectedFile);
				console.log(`  File: \x1b[33m${relativePath}\x1b[0m`);
			} else {
				console.log('  File: \x1b[90m(Not detected in workspace)\x1b[0m');
			}
			console.log('\x1b[90m--------------------------------------------------\x1b[0m');

			const highlighted = cliHighlight.highlight(selectionText.trim(), {
				language: detectedLang,
				ignoreIllegals: true,
				theme: custom_theme
			});
			console.log(highlighted);
			console.log('\x1b[90m--------------------------------------------------\x1b[0m\n');

			selection_context = `\n\n[VS Code Selection Context]\n`;
			if (detectedFile) {
				const relativePath = path.relative(root || process.cwd(), detectedFile);
				selection_context += `File: ${relativePath}\n`;
			}
			selection_context += `\`\`\`${detectedLang}\n${selectionText.trim()}\n\`\`\``;
		}

		if (process.argv[2] === '--full' || process.argv[2] === '-f') {
			const tempPath = path.join(os.tmpdir(), `nono_prompt_${Date.now()}_temp.txt`);
			try {
				fs.writeFileSync(tempPath, '', 'utf8');
				await new Promise((resolve, reject) => {
					const editors = [];
					if (process.env.VISUAL) editors.push(process.env.VISUAL);
					if (process.env.EDITOR) editors.push(process.env.EDITOR);
					for (const fallback of ['vim', 'vi', 'nano']) {
						if (!editors.includes(fallback)) {
							editors.push(fallback);
						}
					}

					let editorIndex = 0;

					function trySpawn() {
						if (editorIndex >= editors.length) {
							reject(new Error(`None of the editors (${editors.join(', ')}) could be started.`));
							return;
						}

						const editor = editors[editorIndex];
						const parts = editor.trim().split(/\s+/);
						const cmd = parts[0];
						const args = [...parts.slice(1), tempPath];

						const child = spawn(cmd, args, { stdio: 'inherit' });
						let completed = false;

						child.on('error', err => {
							if (completed) return;
							completed = true;
							if (err.code === 'ENOENT') {
								editorIndex++;
								trySpawn();
							} else {
								reject(err);
							}
						});

						child.on('close', code => {
							if (completed) return;
							completed = true;
							if (code === 0) {
								resolve();
							} else if (code === 127) {
								editorIndex++;
								trySpawn();
							} else {
								reject(new Error(`Editor (${cmd}) exited with code ${code}`));
							}
						});
					}

					trySpawn();
				});
				if (fs.existsSync(tempPath)) {
					user_query = fs.readFileSync(tempPath, 'utf8');
					try {
						fs.unlinkSync(tempPath);
					} catch (e) {
						// Ignore cleanup errors
					}
				}
			} catch (err) {
				try {
					if (fs.existsSync(tempPath)) {
						fs.unlinkSync(tempPath);
					}
				} catch (e) {
					// Ignore cleanup errors
				}
				console.error(`\x1b[31mError opening/reading temp file in editor: ${err.message}\x1b[0m`);
				process.exit(1);
			}

			if (!user_query.trim()) {
				console.log('No prompt provided. Exiting.');
				process.exit(0);
			}
		} else {
			user_query = process.argv.slice(2).join(' ');

			// If no arguments, prompt interactively
			if (!user_query.trim()) {
				user_query = await askUser('\x1b[35m> \x1b[0m', false);
				if (!user_query.trim()) {
					console.log('No prompt provided. Exiting.');
					process.exit(0);
				}
			}
		}

		if (selection_context) {
			user_query += selection_context;
		}
	}

	// Reset the elapsed timer to exclude prompt typing time
	start_time = Date.now();

	// Create/Clear details file for this command run
	details_path = path.join(cache_dir, `details-${process.ppid}.log`);
	fs.writeFileSync(details_path, '', 'utf8');

	// Load or initialize session
	const session_path = is_pr_review ? path.join(cache_dir, `session-pr-${process.ppid}.json`) : path.join(cache_dir, `session-${process.ppid}.json`);
	let history = [];
	if (!is_initial_pr_review && fs.existsSync(session_path)) {
		try {
			history = JSON.parse(fs.readFileSync(session_path, 'utf8'));
		} catch (e) {
			// Clear corrupt file
		}
	}

	// Ingest environmental context
	let project_root = is_pr_review ? pr_review_temp_dir : findProjectRoot();

	let context_bonus = '';
	if (is_pr_review) {
		context_bonus += `\n\n[PR Review Mode active. Base Branch: ${pr_review_base_branch}, Root: ${project_root}]`;
	} else if (project_root) {
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

	if (is_initial_pr_review) {
		console.log('\x1b[90m✦ Starting analysis...\x1b[0m');
	}

	// Start the ReAct execution loop
	let pendingSummaryTriggers = [];
	while (true) {
		try {
			let response;
			let attempts = 0;
			const maxAttempts = 3;
			while (true) {
				try {
					response = await ai.models.generateContent({
						model: model_name,
						contents: history,
						config: {
							systemInstruction: is_initial_pr_review ? (isCommentMode ? pr_review_comment_system_prompt : pr_review_system_prompt) : system_prompt,
							tools: [
								{
									functionDeclarations: is_initial_pr_review
										? tools_declarations.filter(tool => ['list_directory_structure', 'view_file_contents', 'search_grep', 'execute_system_command'].includes(tool.name)).concat([view_file_git_diff_declaration])
										: tools_declarations
								},
								{ googleSearch: {} }
							],
							toolConfig: {
								functionCallingConfig: {
									mode: 'AUTO'
								},
								includeServerSideToolInvocations: true
							}
						}
					});
					break;
				} catch (apiErr) {
					attempts++;
					const errStr = String(apiErr.message || apiErr);
					const isTransient = errStr.includes('503') || errStr.includes('429') || errStr.includes('UNAVAILABLE') || errStr.includes('service is currently unavailable');
					if (isTransient && attempts < maxAttempts) {
						const delay = Math.pow(2, attempts) * 1000;
						updateProgress(`• Transient API error encountered (${apiErr.message || apiErr}). Retrying in ${delay / 1000}s (Attempt ${attempts}/${maxAttempts})...`);
						await new Promise(resolve => setTimeout(resolve, delay));
						continue;
					}
					throw apiErr;
				}
			}

			if (response.usageMetadata) {
				let currentPrompt = user_query;
				if (!currentPrompt) {
					for (let i = history.length - 1; i >= 0; i--) {
						if (history[i].role === 'user' && Array.isArray(history[i].parts)) {
							const textPart = history[i].parts.find(p => p.text);
							if (textPart && textPart.text) {
								currentPrompt = textPart.text;
								break;
							}
						}
					}
				}
				const cleanPromptText = (currentPrompt || '').split('\n\n[')[0].split('\n[')[0].trim();
				logTokenUsage(model_name, response.usageMetadata, cleanPromptText);
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

				const last_user_msg = history[history.length - 1];
				if (last_user_msg && last_user_msg.role === 'user' && Array.isArray(last_user_msg.parts)) {
					for (const trigger of pendingSummaryTriggers) {
						const summary = await runSummarizationSubAgent(trigger.originalResult, query);
						writeDetails(`[Summarizer Trigger] Summary generated for ${trigger.name}:\n${summary}`);

						const matching_part = last_user_msg.parts.find(p => p.functionResponse && p.functionResponse.name === trigger.name && (!trigger.callId || p.functionResponse.id === trigger.callId));
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
				if (isCommentMode) {
					clearProgress();
					const elapsed = Math.round((Date.now() - start_time) / 1000);
					console.log(`\x1b[90m• Worked for ${formatElapsedTime(elapsed)}\x1b[0m`);

					const text = text_part ? text_part.text : '';
					const cleanText = text.replace(/```json[\s\S]*?```/, '').trim();
					if (cleanText) {
						const formatted = await formatMarkdownForTerminal(cleanText);
						console.log(`\n\x1b[35m✦\x1b[0m ${formatted}\n`);
					}

					let issueJson = extractJsonBlock(text);
					if (issueJson && issueJson.no_more_issues) {
						console.log('\n\x1b[32m✦ All issues addressed.\x1b[0m\n');
						break;
					}

					if (issueJson) {
						lastIssueJson = issueJson;
					} else if (lastIssueJson) {
						issueJson = lastIssueJson;
					}

					if (issueJson && issueJson.file && issueJson.line && issueJson.message) {
						console.log(`\x1b[33mProposed Issue:\x1b[0m`);
						console.log(`  \x1b[1mFile:\x1b[0m ${issueJson.file}`);
						console.log(`  \x1b[1mLine:\x1b[0m ${issueJson.line}`);
						if (issueJson.severity) {
							console.log(`  \x1b[1mSeverity:\x1b[0m ${issueJson.severity.toUpperCase()}`);
						}
						console.log(`  \x1b[1mComment:\x1b[0m ${issueJson.message}\n`);

						if (isAutoMode) {
							lastIssueJson = null;
							const severityStr = issueJson.severity ? `**[${issueJson.severity.toUpperCase()}]** ` : '';
							prComments.push({
								path: issueJson.file,
								line: issueJson.line,
								body: `${severityStr}${issueJson.message}`
							});
							history.push({
								role: 'user',
								parts: [{ text: 'User chose to comment on this issue. Please present the next issue.' }]
							});
							console.log(`\x1b[32mAutomatically saved comment for ${issueJson.file}:${issueJson.line}.\x1b[0m\n`);
						} else {
							let validChoice = false;
							while (!validChoice) {
								const answer = await askUser('Choose an action [skip (s) / comment (c) / write (w)]: ');
								const choice = answer.trim().toLowerCase();
								if (choice === 's' || choice === 'skip') {
									validChoice = true;
									lastIssueJson = null;
									history.push({
										role: 'user',
										parts: [{ text: 'User chose to skip this issue. Please present the next issue.' }]
									});
									console.log('\x1b[90mSkipping issue...\x1b[0m\n');
								} else if (choice === 'c' || choice === 'comment') {
									validChoice = true;
									lastIssueJson = null;
									const severityStr = issueJson.severity ? `**[${issueJson.severity.toUpperCase()}]** ` : '';
									prComments.push({
										path: issueJson.file,
										line: issueJson.line,
										body: `${severityStr}${issueJson.message}`
									});
									history.push({
										role: 'user',
										parts: [{ text: 'User chose to comment on this issue. Please present the next issue.' }]
									});
									console.log(`\x1b[32mSaved comment for ${issueJson.file}:${issueJson.line}.\x1b[0m\n`);
								} else if (choice === 'w' || choice === 'write') {
									validChoice = true;
									const promptText = await askUser('Enter your prompt / question: ');
									history.push({
										role: 'user',
										parts: [{ text: promptText }]
									});
									console.log('\x1b[90mSending prompt to Nono...\x1b[0m\n');
								} else {
									console.log('\x1b[31mInvalid choice. Please type "skip", "comment", or "write".\x1b[0m');
								}
							}
						}
					} else {
						console.log('\x1b[33mWarning: Could not parse issue details from response.\x1b[0m');
						if (isAutoMode) {
							lastIssueJson = null;
							history.push({
								role: 'user',
								parts: [{ text: 'Please present the next issue (or state "No more issues" if there are none).' }]
							});
							console.log('\x1b[90mAutomatically proceeding to next issue...\x1b[0m\n');
						} else {
							const promptText = await askUser('Enter your prompt / question, or type "next" to continue: ');
							if (promptText.trim().toLowerCase() === 'next') {
								lastIssueJson = null;
								history.push({
									role: 'user',
									parts: [{ text: 'Please present the next issue (or state "No more issues" if there are none).' }]
								});
							} else {
								history.push({
									role: 'user',
									parts: [{ text: promptText }]
								});
							}
						}
					}

					pruneHistory(history);
					fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');

					start_time = Date.now();
					continue;
				} else {
					// No functions to call, we have reached the final state
					await finishProgress(text_part ? text_part.text : 'Task completed.');
					break;
				}
			}

			// Execute requested functions sequentially to prevent interleaved console logs & cursor corruption
			const response_parts = [];
			for (const call_part of function_calls) {
				const call = call_part.functionCall;
				const { name, args, id } = call;

				// Formulate a clean progress line for the tool call
				let printedProgress = false;
				if (name !== 'write_file' && name !== 'patch_file') {
					const tool_progress = formatToolCallProgress(name, args);
					const progressLine = formatProgressLine(`• ${tool_progress}`);
					process.stdout.write(progressLine);
					printedProgress = true;
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

				// Check if output exceeds the configured limit
				const result_str = JSON.stringify(result);
				const isSummarized = result_str.length > output_limit;
				if (isSummarized) {
					pendingSummaryTriggers.push({
						name,
						callId: id,
						originalResult: result
					});
					result = {
						status: 'error',
						error: `Tool output is too long (${result_str.length} characters, limit is ${output_limit} characters). What specific information or pattern are you looking for in this output? Please describe it in your next turn so a sub-agent can extract/summarize it.`
					};
				}

				if (printedProgress) {
					if (isSummarized) {
						process.stdout.write('\x1b[90m [sum]\x1b[0m\n');
					} else {
						process.stdout.write('\n');
					}
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

	// Post comments to GitHub Review if comment mode is active
	if (isCommentMode) {
		if (prComments.length > 0) {
			console.log(`\n\x1b[35m✦ Review complete. You have selected ${prComments.length} comment(s) to post. ✦\x1b[0m\n`);
			let shouldPost = false;
			if (isAutoMode) {
				shouldPost = true;
				console.log('Auto mode active: Posting comments automatically...');
			} else {
				const answer = await askUser('Do you want to post the comments and submit requested changes review on the Github PR? (N/y): ');
				if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
					shouldPost = true;
				}
			}

			if (shouldPost) {
				updateProgress('• Posting review comments to GitHub...');
				try {
					const reviewBody = {
						body: 'Nono Pull Request Review. Requested changes based on interactive code review.',
						event: 'REQUEST_CHANGES',
						comments: prComments.map(c => {
							const lineVal = parseInt(c.line, 10);
							const commentObj = {
								path: c.path,
								body: c.body
							};
							if (!isNaN(lineVal)) {
								commentObj.line = lineVal;
								commentObj.side = 'RIGHT';
							}
							return commentObj;
						})
					};

					await githubFetch(`https://api.github.com/repos/${prOwner}/${prRepo}/pulls/${prPullNumber}/reviews`, {
						method: 'POST',
						body: JSON.stringify(reviewBody)
					});

					console.log('\n\x1b[32m✦ Comments and requested changes review submitted successfully!\x1b[0m\n');
					playChime('complete');
				} catch (err) {
					console.log(`\n\x1b[33m• Direct review submission failed (${err.message || err}).\x1b[0m`);
					console.log(`\x1b[90mRetrying with individual comment validation fallback...\x1b[0m`);

					try {
						// 1. Get HEAD commit SHA
						let commit_id;
						try {
							commit_id = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
						} catch (e) {
							// Omit commit_id if git rev-parse fails
						}

						// 2. Create review in PENDING state
						const pendingReview = await githubFetch(`https://api.github.com/repos/${prOwner}/${prRepo}/pulls/${prPullNumber}/reviews`, {
							method: 'POST',
							body: JSON.stringify({
								body: 'Nono Pull Request Review. Requested changes based on interactive code review.'
							})
						});
						const reviewId = pendingReview.id;

						// 3. Post comments one by one to the pending review
						let successCount = 0;
						for (const c of prComments) {
							const lineVal = parseInt(c.line, 10);
							const commentObj = {
								path: c.path,
								body: c.body
							};
							if (!isNaN(lineVal)) {
								commentObj.line = lineVal;
								commentObj.side = 'RIGHT';
							}
							if (commit_id) {
								commentObj.commit_id = commit_id;
							}
							try {
								await githubFetch(`https://api.github.com/repos/${prOwner}/${prRepo}/pulls/${prPullNumber}/reviews/${reviewId}/comments`, {
									method: 'POST',
									body: JSON.stringify(commentObj)
								});
								console.log(`\x1b[90m  • Attached comment: ${c.path}:${c.line}\x1b[0m`);
								successCount++;
							} catch (commentErr) {
								console.log(`\x1b[31m  • Warning: Skipped comment on ${c.path}:${c.line} (Line not in PR diff or invalid)\x1b[0m`);
							}
						}

						// 4. Submit the pending review
						await githubFetch(`https://api.github.com/repos/${prOwner}/${prRepo}/pulls/${prPullNumber}/reviews/${reviewId}/events`, {
							method: 'POST',
							body: JSON.stringify({
								event: 'REQUEST_CHANGES',
								body: 'Nono Pull Request Review. Requested changes based on interactive code review.'
							})
						});

						console.log(`\n\x1b[32m✦ Review submitted successfully! Posted ${successCount} of ${prComments.length} comments.\x1b[0m\n`);
						playChime('complete');
					} catch (fallbackErr) {
						console.error(`\x1b[31mError submitting review during fallback: ${fallbackErr.message || fallbackErr}\x1b[0m`);
						playChime('error');
					}
				}
			} else {
				console.log('Submission cancelled.');
			}
		} else {
			console.log('\n\x1b[90m✦ No comments were selected for submission.\x1b[0m\n');
		}
		process.exit(0);
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
			const userTurns = history.filter(msg => msg && msg.role === 'user' && Array.isArray(msg.parts) && msg.parts[0] && typeof msg.parts[0].text === 'string' && !msg.parts[0].text.startsWith('[System Memory:\n')).length;

			const token_limit = process.env.NONO_SUMMARIZE_TOKEN_LIMIT ? parseInt(process.env.NONO_SUMMARIZE_TOKEN_LIMIT, 10) : 20000;

			if (totalTokens > token_limit && userTurns >= 3) {
				console.log(`\n\x1b[33m⚡ Session history is growing large (${totalTokens} tokens, ${userTurns} turns).\x1b[0m`);
				const answer = await askUser('Would you like to compress history in the background? [y/N]: ');
				const norm = answer.trim().toLowerCase();
				if (norm === 'y' || norm === 'yes') {
					console.log('Spawning background summarization process...');
					const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--summarize-background', session_path], {
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
