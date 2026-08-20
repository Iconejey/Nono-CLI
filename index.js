#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec, execSync, spawn, spawnSync } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import { generateChimeWav, playChime } from './src/utils/sound.js';
import { convertToOpenAIMessages, cleanModelText, parseTextToolCalls, convertToGeminiResponse, convertGeminiToolsToOpenAI, pruneHistory, sanitizeHistory } from './src/utils/llm.js';
import { writeDetails, getDetailsPath, setDetailsPath, logTokenUsage } from './src/utils/logger.js';
import { loadCustomTheme, getCustomTheme } from './src/utils/theme.js';
import { formatK, stripAnsi, getPRNameFromPPID, formatElapsedTime, formatProgressLine, formatToolCallProgress, processInlineStyles, formatTable } from './src/utils/terminal.js';
import { extractJsonBlock, formatCodeWithPrettier, formatMarkdownForTerminal, highlightRawMarkdown } from './src/utils/markdown.js';
import { findProjectRoot, getKittyScreenText, readTerminalBuffer, runProjectDryRun, isHighImpactCommand, getOSDescription, findNonoFiles } from './src/utils/system.js';
import { findCorrespondingCall, matchesTarget, discardSpecificOutput, discardLastSteps } from './src/utils/history.js';

import { listDirectoryStructure, viewFileContents, writeFile, patchFile, searchGrep } from './src/tools/fs.js';
import { getPrettierFlagsFromVSCode, hasProjectPrettierConfig, formatWithPrettier, getLineDiff, getFileDiffText, isIgnoredFile, viewFileGitDiff } from './src/tools/format_diff.js';
import { executeSystemCommand, runNodeScript, runNodeSyntaxCheck } from './src/tools/execution.js';

// Load environment variables from the directory of this script or fallback locations
const dir_name = path.dirname(fileURLToPath(import.meta.url));
process.env.DOTENV_LOG_LEVEL = 'none';
process.env.DOTENVX_LOG_LEVEL = 'none';
dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });
dotenv.config({
	path: path.join(os.homedir(), '.config', 'nono', '.env'),
	quiet: true
});
dotenv.config({ path: path.join(dir_name, '.env'), quiet: true });

// Detect forceGemini early so we can configure clients accordingly
const gemini_idx_early = process.argv.indexOf('--gemini');
const force_gemini = gemini_idx_early !== -1;
if (force_gemini) process.argv.splice(gemini_idx_early, 1);

// Detect verbose arg early
const verbose_idx = process.argv.indexOf('--verbose');
export const verbose = verbose_idx !== -1;
if (verbose) process.argv.splice(verbose_idx, 1);

const vllm_api_key = process.env.VLLM_API_KEY;
const vllm_base_url = process.env.VLLM_BASE_URL;
const vllm_stat_url = process.env.VLLM_STAT_URL;
const has_vllm_env = !!vllm_base_url;
const use_vllm = has_vllm_env && !force_gemini;

const api_key = process.env.GEMINI_API_KEY;
const model_name = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const default_volume = process.env.NONO_VOLUME ? parseFloat(process.env.NONO_VOLUME) : 0.6;
const volume_scale = isNaN(default_volume) ? 0.6 : Math.max(0, Math.min(1, default_volume));
const default_output_limit = process.env.NONO_SUMMARIZE_OUTPUT_LIMIT ? parseInt(process.env.NONO_SUMMARIZE_OUTPUT_LIMIT, 10) : 10000;
const output_limit = isNaN(default_output_limit) ? 10000 : default_output_limit;
const default_thought_limit = process.env.NONO_THOUGHT_LIMIT ? parseInt(process.env.NONO_THOUGHT_LIMIT, 10) : 120;
export const thought_limit = isNaN(default_thought_limit) ? 120 : default_thought_limit;

if (!use_vllm && !api_key && !['--details', '--usage', '--help', '-h', '--summarize-background', '--raw', '--resume', '--list-instructions', '--add-instructions'].includes(process.argv[2])) {
	console.error('\x1b[31mError: GEMINI_API_KEY is not set.\x1b[0m');
	console.error('Please configure your GEMINI_API_KEY in a .env file.');
	process.exit(1);
}

let ai = null;
async function ensureAiInitialized() {
	if (ai) return;
	const { GoogleGenAI } = await import('@google/genai');
	ai = api_key ? new GoogleGenAI({ apiKey: api_key }) : null;
}

let openai = null;
async function ensureOpenaiInitialized() {
	if (openai) return;
	const OpenAI = (await import('openai')).default;
	openai = use_vllm
		? new OpenAI({
				apiKey: vllm_api_key,
				baseURL: vllm_base_url
			})
		: null;
}

let cli_highlight = null;
async function ensureCliHighlight() {
	if (cli_highlight) return cli_highlight;
	cli_highlight = (await import('cli-highlight')).default;
	return cli_highlight;
}

let vllm_model_name = process.env.VLLM_MODEL || '';
let vllm_max_context = 8192; // default fallback

const gemini_web_search_declaration = {
	name: 'gemini_web_search',
	description: "Queries Google Search using Gemini's web search API to retrieve up-to-date information, news, and details from the web.",
	parameters: {
		type: 'OBJECT',
		properties: {
			query: {
				type: 'STRING',
				description: 'The search query to perform.'
			}
		},
		required: ['query']
	}
};

async function geminiWebSearch({ query }) {
	await ensureAiInitialized();
	if (!ai) return { error: 'Gemini API client not initialized.' };
	try {
		const response = await ai.models.generateContent({
			model: model_name,
			contents: [{ role: 'user', parts: [{ text: query }] }],
			config: {
				tools: [{ googleSearch: {} }]
			}
		});
		const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
		return { results: text };
	} catch (err) {
		return { error: err.message || String(err) };
	}
}

// Global Progress & Logging State
let start_time = Date.now();
global.allow_all_high_impact = false;

let latest_context_size = 0;
let api_static_overhead = null;
let latest_tok_speed = 0;
let total_candidates_token_count = 0;
let total_api_duration_ms = 0;
let is_bottom_line_active = false;
let latest_vllm_stats = null;

const original_stdout_write = process.stdout.write.bind(process.stdout);
const original_stderr_write = process.stderr.write.bind(process.stderr);

async function fetchVllmStatsLoop() {
	if (!use_vllm || !vllm_stat_url) return;
	while (true) {
		try {
			const controller = new AbortController();
			const timeout_id = setTimeout(() => controller.abort(), 2000);
			const res = await fetch(vllm_stat_url, { signal: controller.signal });
			clearTimeout(timeout_id);
			if (res.ok) {
				latest_vllm_stats = await res.json();
				if (is_talking_active && latest_vllm_stats?.vllm && latest_vllm_stats.vllm.generation_tokens_total !== undefined) {
					if (vllm_baseline_generation === null) {
						vllm_baseline_generation = latest_vllm_stats.vllm.generation_tokens_total;
					}
					talking_token_count = Math.max(0, latest_vllm_stats.vllm.generation_tokens_total - vllm_baseline_generation);
					if (talking_token_count > 0 && vllm_ttft === null && vllm_request_start_time !== null) {
						vllm_ttft = (Date.now() - vllm_request_start_time) / 1000;
					}

					const current_tokens = latest_vllm_stats.vllm.generation_tokens_total;
					const current_time = Date.now();
					if (last_vllm_tokens !== null && last_vllm_time !== null) {
						const delta_tokens = current_tokens - last_vllm_tokens;
						const delta_time_s = (current_time - last_vllm_time) / 1000;
						if (delta_tokens > 0 && delta_time_s > 0) {
							const speed = delta_tokens / delta_time_s;
							latest_vllm_tick_speed = speed;
							vllm_tick_speeds.push(speed);
						}
					}
					last_vllm_tokens = current_tokens;
					last_vllm_time = current_time;
				}
				if (is_bottom_line_active) drawBottomLine();
			}
		} catch (err) {
			// Silent error to prevent loop crash
		}
		await new Promise(resolve => {
			const timer = setTimeout(resolve, 1000);
			timer.unref();
		});
	}
}

let is_talking_active = false;
let talking_token_count = 0;
let current_tool_being_called = null;
let vllm_baseline_generation = null;
let vllm_start_time = null;
let latest_vllm_generation_duration_ms = null;

// New tracking variables for tick speed and TTFT
let vllm_request_start_time = null;
let vllm_ttft = null;
let last_vllm_tokens = null;
let last_vllm_time = null;
let latest_vllm_tick_speed = 0;
let vllm_tick_speeds = [];

function drawBottomLine() {
	if (!ai && !openai) return;
	let current_tokens = latest_context_size || 0;
	let token_limit = use_vllm ? vllm_max_context : parseInt(process.env.NONO_SUMMARIZE_TOKEN_LIMIT, 10) || 40000;

	if (use_vllm && latest_vllm_stats?.vllm) {
		current_tokens = latest_vllm_stats.vllm.current_context_tokens_total || latest_context_size || 0;
		token_limit = latest_vllm_stats.vllm.max_model_len || token_limit;
		if (is_talking_active && latest_vllm_stats.vllm.generation_tokens_total !== undefined) {
			if (vllm_baseline_generation === null) {
				vllm_baseline_generation = latest_vllm_stats.vllm.generation_tokens_total;
			}
			talking_token_count = Math.max(0, latest_vllm_stats.vllm.generation_tokens_total - vllm_baseline_generation);
			if (talking_token_count > 0 && vllm_ttft === null && vllm_request_start_time !== null) {
				vllm_ttft = (Date.now() - vllm_request_start_time) / 1000;
			}
		}
	}

	const pct = token_limit > 0 ? Math.round((current_tokens / token_limit) * 100) : 0;
	const formatted_current = formatK(current_tokens);
	const formatted_limit = formatK(token_limit);

	const parts = [`${formatted_current} / ${formatted_limit} (${pct}%)`];

	const hot_devices = [];
	if (use_vllm && latest_vllm_stats) {
		if (latest_vllm_stats.cpu && latest_vllm_stats.cpu.temperature_celsius >= 80) {
			hot_devices.push(`CPU ${Math.round(latest_vllm_stats.cpu.temperature_celsius)}°C`);
		}
		if (latest_vllm_stats.gpus && Array.isArray(latest_vllm_stats.gpus)) {
			latest_vllm_stats.gpus.forEach(gpu => {
				if (gpu.temperature_celsius >= 80) {
					hot_devices.push(`GPU${gpu.index} ${Math.round(gpu.temperature_celsius)}°C`);
				}
			});
		}
	}
	if (hot_devices.length > 0) {
		parts.push(hot_devices.join(' | '));
	}

	let suffix = '';
	if (current_tool_being_called) {
		suffix = ` | Calling ${current_tool_being_called}`;
	} else if (is_talking_active) {
		if (use_vllm) {
			if (talking_token_count > 0) {
				const ttft_str = vllm_ttft !== null ? `${vllm_ttft.toFixed(1)}s TTFT` : '--s TTFT';
				const speed_val = Math.round(latest_vllm_tick_speed);
				const speed_str = speed_val > 0 ? `${speed_val} tok/s` : '-- tok/s';
				suffix = ` | Generating (${talking_token_count} tok, ${speed_str}, ${ttft_str})`;
			} else {
				suffix = ` | Processing...`;
			}
		} else {
			if (talking_token_count > 0) {
				suffix = ` | Generating (${talking_token_count} tokens)`;
			} else {
				suffix = ` | Generating...`;
			}
		}
	}

	const line = `\x1b[90m${parts.join(' | ')}${suffix}\x1b[0m`;
	original_stdout_write('\r\x1b[K' + line);
	is_bottom_line_active = true;
}

function clearBottomLine() {
	if (is_bottom_line_active) {
		original_stdout_write('\r\x1b[K');
		is_bottom_line_active = false;
	}
}

process.stdout.write = function (chunk, encoding, callback) {
	const was_active = is_bottom_line_active;
	if (was_active) clearBottomLine();

	const result = original_stdout_write(chunk, encoding, callback);
	if (was_active) drawBottomLine();

	return result;
};

process.stderr.write = function (chunk, encoding, callback) {
	const was_active = is_bottom_line_active;
	if (was_active) clearBottomLine();

	const result = original_stderr_write(chunk, encoding, callback);
	if (was_active) drawBottomLine();

	return result;
};

// Helper to run a sub-agent for summarizing massive tool output
async function runSummarizationSubAgent(originalResult, query) {
	if (use_vllm) await ensureOpenaiInitialized();
	else await ensureAiInitialized();
	if (!ai && !openai) {
		return 'Error: AI client not initialized.';
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

		let text = '';
		if (use_vllm) {
			const oai_response = await openai.chat.completions.create({
				model: vllm_model_name,
				messages: [{ role: 'user', content: prompt }]
			});
			text = oai_response.choices?.[0]?.message?.content || '';
			text = cleanModelText(text);
		} else {
			const response = await ai.models.generateContent({
				model: model_name,
				contents: [{ role: 'user', parts: [{ text: prompt }] }]
			});
			text = response.candidates?.[0]?.content?.parts?.[0]?.text;
		}
		return text || 'Could not summarize the tool output.';
	} catch (err) {
		return `Error running summarization sub-agent: ${err.message || err}`;
	}
}

// Helper for background summarization process
async function handleBackgroundSummarization(session_path) {
	if (use_vllm) await ensureVllmInitialized();
	else await ensureAiInitialized();
	if (!fs.existsSync(session_path)) return;
	let history = [];
	let l_before = 0;
	try {
		history = sanitizeHistory(JSON.parse(fs.readFileSync(session_path, 'utf8')));
		l_before = history.length;
	} catch (e) {
		return;
	}

	if (!Array.isArray(history) || history.length === 0) return;

	// Find the user prompt message indices (where role: 'user' and first part is not system memory summary)
	const prompt_indices = [];
	for (let i = 0; i < history.length; i++) {
		const msg = history[i];
		if (msg && msg.role === 'user') {
			const first_part = msg.parts?.[0];
			if (first_part && typeof first_part.text === 'string' && first_part.text.startsWith('[System Memory:\n')) continue;
			prompt_indices.push(i);
		}
	}

	// We keep the last 2 turns in full (Turn N-1 and Turn N)
	// So we need at least 3 prompt messages to summarize (prompt_indices.length >= 3)
	if (prompt_indices.length < 3) return;

	const slice_index = prompt_indices[prompt_indices.length - 2];
	const history_to_summarize = history.slice(0, slice_index);
	const history_to_keep = history.slice(slice_index);

	const summary_prompt = `Extract the key facts from this conversation history. Make sure this summarized context will only contain information that is relevant to the task direction. Anything that is not worth remembering should go. Retain exact file paths, critical variables, active error messages, and the current overall goal. Format as bullet points.`;
	const contents = [
		...history_to_summarize,
		{
			role: 'user',
			parts: [{ text: summary_prompt }]
		}
	];

	try {
		let summary = '';
		if (use_vllm) {
			const oai_response = await openai.chat.completions.create({
				model: vllm_model_name,
				messages: convertToOpenAIMessages(history_to_summarize, summary_prompt)
			});
			summary = oai_response.choices?.[0]?.message?.content || '';
			summary = cleanModelText(summary);
		} else {
			const response = await ai.models.generateContent({
				model: model_name,
				contents: contents
			});
			summary = response.candidates?.[0]?.content?.parts?.[0]?.text;
		}

		if (summary && fs.existsSync(session_path)) {
			let current_history = [];
			try {
				current_history = sanitizeHistory(JSON.parse(fs.readFileSync(session_path, 'utf8')));
			} catch (e) {
				current_history = history;
			}

			if (Array.isArray(current_history)) {
				// Any messages beyond l_before are new messages added since we started
				const new_messages = current_history.slice(l_before);

				const system_memory_msg = {
					role: 'user',
					parts: [{ text: `[System Memory:\n${summary.trim()}]` }]
				};
				const new_history = [system_memory_msg, ...history_to_keep, ...new_messages];
				fs.writeFileSync(session_path, JSON.stringify(new_history, null, 2), 'utf8');
			}
		}
	} catch (err) {
		// Ignore / fail silently
	}
}

async function ensureContextLimit(history, session_path) {
	if (use_vllm) await ensureOpenaiInitialized();
	else await ensureAiInitialized();
	if (!history || history.length === 0 || !(ai || openai)) return;
	try {
		let total_tokens = latest_context_size || 0;
		if (total_tokens === 0) {
			if (use_vllm) {
				total_tokens = Math.round(JSON.stringify(history).length / 3.7);
			} else if (ai) {
				try {
					const token_count_res = await ai.models.countTokens({
						model: model_name,
						contents: history
					});
					total_tokens = token_count_res.totalTokens || 0;
				} catch (e) {
					total_tokens = Math.round(JSON.stringify(history).length / 3.7);
				}
			} else {
				total_tokens = Math.round(JSON.stringify(history).length / 3.7);
			}
		}

		const user_turns = history.filter(msg => {
			if (!msg || msg.role !== 'user') return false;
			const first_part = msg.parts?.[0];
			if (first_part && typeof first_part.text === 'string' && first_part.text.startsWith('[System Memory:\n')) return false;
			return true;
		}).length;

		const token_limit = use_vllm ? vllm_max_context : parseInt(process.env.NONO_SUMMARIZE_TOKEN_LIMIT, 10) || 40000;
		const threshold = use_vllm ? Math.round(token_limit * 0.9) : token_limit;

		if (total_tokens > threshold && user_turns >= 3) {
			console.log(`${verbose ? '\x1b[36m' : '\x1b[90m'}• Session history is growing large (${total_tokens} tokens). Compressing...\x1b[0m`);
			await handleBackgroundSummarization(session_path);
			const new_history = sanitizeHistory(JSON.parse(fs.readFileSync(session_path, 'utf8')));
			history.length = 0;
			history.push(...new_history);

			let new_total_tokens = 0;
			if (use_vllm) {
				new_total_tokens = Math.round(JSON.stringify(history).length / 3.7);
			} else if (ai) {
				try {
					const token_count_res = await ai.models.countTokens({
						model: model_name,
						contents: history
					});
					new_total_tokens = token_count_res.totalTokens || 0;
				} catch (e) {
					new_total_tokens = Math.round(JSON.stringify(history).length / 3.7);
				}
			} else {
				new_total_tokens = Math.round(JSON.stringify(history).length / 3.7);
			}
			latest_context_size = new_total_tokens;
			console.log(`${verbose ? '\x1b[36m' : '\x1b[90m'}• Reduced to ${formatK(new_total_tokens)} tokens\x1b[0m`);
		}
	} catch (e) {
		// Fail silently
	}
}

async function pushToHistoryAndCheckLimit(history, item, session_path) {
	await ensureContextLimit(history, session_path);
	history.push(item);
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
			const history = sanitizeHistory(JSON.parse(fs.readFileSync(sessionFile.path, 'utf8')));
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

function updateProgress(raw_text, color) {
	const line = formatProgressLine(raw_text, color);
	console.log(line);
}

function clearProgress() {
	clearBottomLine();
}

async function finishProgress(final_text, grounding_sources) {
	clearProgress();
	const formatted = await formatMarkdownForTerminal(cleanModelText(final_text).trim());
	console.log();
	console.log(`\x1b[35m✦\x1b[0m ${formatted}`);
	console.log();

	if (Array.isArray(grounding_sources) && grounding_sources.length > 0) {
		console.log(`\x1b[90mSources:\x1b[0m`);
		for (const src of grounding_sources) {
			console.log(`${verbose ? '\x1b[36m' : '\x1b[90m'}• ${src.title || src.uri}: ${src.uri}\x1b[0m`);
		}
		console.log();
	}

	const token_limit = use_vllm ? vllm_max_context : parseInt(process.env.NONO_SUMMARIZE_TOKEN_LIMIT, 10) || 40000;
	const current_tokens = latest_context_size || 0;
	const pct = token_limit > 0 ? Math.round((current_tokens / token_limit) * 100) : 0;
	const formatted_current = (current_tokens / 1000).toFixed(1) + 'K';
	const formatted_limit = (token_limit / 1000).toFixed(1) + 'K';

	let avg_tok_speed = 0;
	if (use_vllm && vllm_tick_speeds.length > 0) {
		const sum = vllm_tick_speeds.reduce((a, b) => a + b, 0);
		avg_tok_speed = Math.round(sum / vllm_tick_speeds.length);
	} else {
		avg_tok_speed = total_api_duration_ms > 0 ? Math.round(total_candidates_token_count / (total_api_duration_ms / 1000)) : 0;
	}

	const elapsed = Math.round((Date.now() - start_time) / 1000);
	const elapsed_str = formatElapsedTime(elapsed);

	let line;
	if (use_vllm) {
		const ttft_str = vllm_ttft !== null ? `${vllm_ttft.toFixed(1)}s TTFT` : '--s TTFT';
		const speed_str = avg_tok_speed > 0 ? `${avg_tok_speed} tok/s` : '-- tok/s';
		line = `\x1b[90m${formatted_current} / ${formatted_limit} (${pct}%) | ${speed_str} | ${ttft_str} | ${elapsed_str}\x1b[0m`;
	} else {
		const speed_str = avg_tok_speed > 0 ? `${avg_tok_speed} tok/s` : '-- tok/s';
		line = `\x1b[90m${formatted_current} / ${formatted_limit} (${pct}%) | ${speed_str} | ${elapsed_str}\x1b[0m`;
	}
	console.log(line);
	console.log();

	playChime('complete');
	writeDetails(`\n[Final Message]\n✦ ${final_text.trim()}`);
}

function finishProgressError(err_msg) {
	clearProgress();
	console.log(`\x1b[31m✦ Error: ${err_msg}\x1b[0m`);
	playChime('error');
	writeDetails(`\n[Fatal Error]\n${err_msg}`);
}

// Helper to ask the user a question / confirmation
function askUser(question, play_sound = true) {
	const was_active = is_bottom_line_active;
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
			if (was_active) drawBottomLine();
			resolve(answer);
		});
	});
}

// Reusable helper for key-selected choices with chevron selector
async function chooseOption(options, headerText = null) {
	const was_active = is_bottom_line_active;
	clearProgress();

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
					if (was_active) drawBottomLine();
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
	const was_active = is_bottom_line_active;
	clearProgress();
	playChime('question');
	const formattedQuestion = formatProgressLine(question);
	process.stdout.write(formattedQuestion);

	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true
		});
		rl.on('line', line => {
			rl.close();
			if (was_active) drawBottomLine();
			resolve(line);
		});
	});
}

// Helper to run sudo true interactively and capture stdout/stderr in the roll
function runInteractiveSudo() {
	const was_active = is_bottom_line_active;
	clearProgress();

	return new Promise((resolve, reject) => {
		const child = spawn('sudo', ['true'], {
			stdio: ['inherit', 'pipe', 'pipe']
		});

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
			if (was_active) drawBottomLine();
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Sudo authentication failed.`));
			}
		});
	});
}
global.askUserInRoll = askUserInRoll;
global.runInteractiveSudo = runInteractiveSudo;

// ----------------------------------------------------
// Tool Implementations
// ----------------------------------------------------

function proposeTerminalInput({ command_to_inject }) {
	if (!is_kitty) {
		return Promise.resolve({
			status: 'error',
			error: 'Could not propose terminal input (Kitty terminal is not detected)'
		});
	}
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

async function commentTool({ text }) {
	clearProgress();
	const formatted = await formatMarkdownForTerminal(text, { color: 'gray' });
	const lines = formatted.split('\n');
	let firstNonEmptyIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim()) {
			firstNonEmptyIndex = i;
			break;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === firstNonEmptyIndex) {
			console.log(`\x1b[90m•\x1b[0m ${line}`);
		} else if (i > firstNonEmptyIndex) {
			if (line.trim() === '') {
				console.log('');
			} else {
				console.log(`  ${line}`);
			}
		} else {
			console.log(line);
		}
	}
	return {
		status: 'success',
		message: 'Comment printed successfully.'
	};
}

async function finalAnswerTool({ response }) {
	return {
		status: 'success',
		message: 'Final answer received. Concluding task.'
	};
}

// Map tool name to implementation function
const tools_mapping = {
	list_directory_structure: listDirectoryStructure,
	view_file_contents: viewFileContents,
	write_file: writeFile,
	patch_file: patchFile,
	search_grep: searchGrep,
	execute_system_command: executeSystemCommand,
	run_node_script: runNodeScript,
	propose_terminal_input: proposeTerminalInput,
	read_terminal_buffer: readTerminalBuffer,
	view_file_git_diff: viewFileGitDiff,
	discard_specific_output: discardSpecificOutput,
	discard_last_steps: discardLastSteps,
	gemini_web_search: geminiWebSearch,
	comment: commentTool,
	final_answer: finalAnswerTool
};

const os_name = getOSDescription();

const is_kitty = process.env.TERM === 'xterm-kitty' || !!process.env.KITTY_PID || !!process.env.KITTY_WINDOW_ID;

// ----------------------------------------------------
// Gemini Tool Declarations
// ----------------------------------------------------

const tools_declarations = [
	{
		name: 'comment',
		description: 'Outputs a thought, comment, explanation, or progress update to the user. Use this to explain your strategy, status, or plans.',
		parameters: {
			type: 'OBJECT',
			properties: {
				text: {
					type: 'STRING',
					description: 'The comment or thought text (can be markdown, multi-line).'
				}
			},
			required: ['text']
		}
	},
	{
		name: 'final_answer',
		description: 'Concludes the task and provides the final answer or solution to the user. Use this only when you are completely finished with the task.',
		parameters: {
			type: 'OBJECT',
			properties: {
				response: {
					type: 'STRING',
					description: 'The final response/solution text to present to the user (can be markdown).'
				}
			},
			required: ['response']
		}
	},
	{
		name: 'discard_specific_output',
		description:
			"Replaces the output of a specific previous tool call (such as a read file or an executed command) with an 'erased' placeholder to optimize context window space. Use this when you realize a specific file or command output is useless.",
		parameters: {
			type: 'OBJECT',
			properties: {
				target: {
					type: 'STRING',
					description: 'The exact file path or command string whose output should be cleared from memory.'
				}
			},
			required: ['target']
		}
	},
	{
		name: 'discard_last_steps',
		description: "Replaces the outputs of the last N tool calls with an 'erased' placeholder. Use this to quickly clean up memory after realizing your most recent steps or explorations were a dead end.",
		parameters: {
			type: 'OBJECT',
			properties: {
				steps_count: {
					type: 'INTEGER',
					description: 'The number of recent tool outputs to erase from memory (counting backwards from the most recent call).'
				}
			},
			required: ['steps_count']
		}
	},
	{
		name: 'list_directory_structure',
		description: 'Lists the files and folders in a directory recursively up to a certain depth to understand the project workspace layout.',
		parameters: {
			type: 'OBJECT',
			properties: {
				directory_path: {
					type: 'STRING',
					description: 'The absolute or relative path to the directory.'
				},
				depth: {
					type: 'INTEGER',
					description: 'Maximum depth of recursion (default: 2).'
				}
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
				start_line: {
					type: 'INTEGER',
					description: 'Optional line number to start reading from.'
				},
				end_line: {
					type: 'INTEGER',
					description: 'Optional line number to stop reading at.'
				}
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
				file_path: {
					type: 'STRING',
					description: 'Path where the file should be created/written.'
				},
				content: {
					type: 'STRING',
					description: 'The exact textual content to write.'
				}
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
				search_block: {
					type: 'STRING',
					description: 'The original code block to find.'
				},
				replace_block: {
					type: 'STRING',
					description: 'The new code block to substitute.'
				}
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
				pattern: {
					type: 'STRING',
					description: 'The regex pattern or substring to search for.'
				},
				directory_path: {
					type: 'STRING',
					description: 'The directory root to search inside.'
				}
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
				command: {
					type: 'STRING',
					description: "The exact terminal command to run (e.g. 'nmcli dev wifi list', 'cargo build')."
				},
				timeout_ms: {
					type: 'INTEGER',
					description: 'Maximum execution time in milliseconds (default: 30000).'
				}
			},
			required: ['command']
		}
	},
	{
		name: 'run_node_script',
		description: `Runs a custom JavaScript (Node.js) script by writing the code directly to Node's standard input. Returns stdout, stderr, and exit status code. Note: stdout and stderr exceeding 30,000 characters each will be truncated.`,
		parameters: {
			type: 'OBJECT',
			properties: {
				code: {
					type: 'STRING',
					description: 'The precise JavaScript code to execute.'
				},
				timeout_ms: {
					type: 'INTEGER',
					description: 'Maximum execution time in milliseconds (default: 30000).'
				}
			},
			required: ['code']
		}
	},
	...(is_kitty
		? [
				{
					name: 'propose_terminal_input',
					description: "Injects text straight into the user's active Zsh prompt using Kitty's remote control feature, leaving the user to hit Enter.",
					parameters: {
						type: 'OBJECT',
						properties: {
							command_to_inject: {
								type: 'STRING',
								description: 'The command string to stage on the user shell line.'
							}
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
			]
		: [])
];

const view_file_git_diff_declaration = {
	name: 'view_file_git_diff',
	description: 'Shows the line-by-line git diff of a specific file in the PR branch compared to the base branch, or the entire PR git diff if file_path is omitted.',
	parameters: {
		type: 'OBJECT',
		properties: {
			base_branch: {
				type: 'STRING',
				description: 'The base branch of the PR.'
			},
			file_path: {
				type: 'STRING',
				description: 'The relative path of the file to inspect. If omitted, returns the diff for all changed files.'
			}
		},
		required: ['base_branch']
	}
};

let system_prompt = `You are Nono, an ultra-efficient CLI AI Agent & Coding Workspace Specialist.
You run on a ${os_name} host and operate in one of two modes:
1. System Admin Mode: Focused on minimal, precise system calls (NetworkManager, systemctl, diagnostics).
2. Workspace Developer Mode: Focused on codebase understanding, editing, and software engineering.

CRITICAL INSTRUCTIONS:
- You operate using an Agentic Loop (ReAct: Reason + Act). Before invoking any tool, you MUST output your plan and reasoning.
- Workspace Modification Requirement: In Workspace Developer Mode, if the user's request asks to implement a feature, perform a fix, update files, or change configuration, you MUST actually make the edits in the workspace using appropriate tools (e.g., "patch_file", "write_file", or system commands). Describing the fix, explaining the plan, or providing code blocks in your markdown response is NOT sufficient and constitutes an incomplete task. You MUST run the editing tools to write/modify the code, and then verify the changes. Only conclude the ReAct loop once the physical workspace files are fully updated and confirmed correct. Do NOT finish prematurely after only searching or reading files.
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

let pr_review_system_prompt = `You are Nono, performing an expert, codebase-aware Pull Request Review.
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

let pr_review_comment_system_prompt = `You are Nono, performing an expert, codebase-aware Pull Request Review.
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

// Gather content of all nono.md files found and append to system prompts
const nonoFiles = findNonoFiles(process.cwd());
if (nonoFiles.length > 0) {
	let customInstructions = '\n\n=========================================\nADDITIONAL USER INSTRUCTIONS & DETAILS:\n';
	for (const file of nonoFiles) {
		try {
			const content = fs.readFileSync(file, 'utf8');
			customInstructions += `\n--- From: ${file} ---\n${content}\n`;
		} catch (e) {
			// ignore read errors
		}
	}
	customInstructions += '=========================================\n';
	system_prompt += customInstructions;
	pr_review_system_prompt += customInstructions;
	pr_review_comment_system_prompt += customInstructions;
}

// ----------------------------------------------------
// Main Agentic Loop Orchestrator
// ----------------------------------------------------

let vllm_initialized = false;
async function ensureVllmInitialized() {
	if (!use_vllm || vllm_initialized) return;
	vllm_initialized = true;

	if (vllm_stat_url) fetchVllmStatsLoop();

	await ensureOpenaiInitialized();
	if (openai) {
		try {
			const models = await openai.models.list();
			if (models.data && models.data.length > 0) {
				if (!vllm_model_name) vllm_model_name = models.data[0].id;
				const matchedModel = models.data.find(m => m.id === vllm_model_name) || models.data[0];
				if (matchedModel && matchedModel.max_model_len) vllm_max_context = matchedModel.max_model_len;
			}
		} catch (e) {
			// silent fallback
		}
		if (!vllm_model_name) vllm_model_name = 'default-model';
	}
}

async function main() {
	if (!use_vllm) {
		if (process.argv[2] !== '--summarize-background' && !['--details', '--usage', '--help', '-h', '--clear', '--resume', '--list-instructions', '--add-instructions', '--get-pricing'].includes(process.argv[2])) {
			console.warn('\x1b[33mWarning: The Gemini API will be used for the current task.\x1b[0m');
		}
	}

	const skip_vllm_init_args = ['--help', '-h', '--clear', '--list-instructions', '--add-instructions', '--get-pricing', '--usage', '--details', '--write', '-w', '--resume', '--summarize-background'];
	const is_skip_init = skip_vllm_init_args.includes(process.argv[2]);

	if (!is_skip_init) {
		if (use_vllm) await ensureVllmInitialized();
		else await ensureAiInitialized();
	}

	const cache_dir = path.join(os.homedir(), '.cache', 'nono');
	if (!fs.existsSync(cache_dir)) {
		fs.mkdirSync(cache_dir, { recursive: true });
	}

	let auto_continue = false;
	const envAutoContinue = process.env.NONO_AUTO_CONTINUE;
	if (envAutoContinue) {
		const lowered = envAutoContinue.trim().toLowerCase();
		if (lowered === 'true' || lowered === 'yes' || lowered === '1') {
			auto_continue = true;
		}
	}

	const autoContinueIdx = process.argv.findIndex((arg, i) => i >= 2 && (arg === '-ac' || arg === '--auto-continue'));
	if (autoContinueIdx !== -1) {
		auto_continue = true;
		process.argv.splice(autoContinueIdx, 1);
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
\x1b[35m✦ Nono - Ultra-efficient CLI AI Agent & Coding\x1b[0m

\x1b[1mUsage:\x1b[0m
  nono                       Start Nono in interactive mode
  nono [prompt]              Run a prompt directly from the command line
  nono --write, -w           Open a temp file in your text editor to write a prompt
  nono --vscode, -vs         Retrieve VSCode selection and use it as context with its file path
  nono --file, -f <spec>     Include whole/parts of a text file (spec: path[:line] or path[:start_line-end_line])
  nono --clipboard, -c       Include the copied text in clipboard
  nono --usage               Display token consumption and estimated costs (use --list <n> or -l <n> to list last prompts)
  nono --clear               Clear terminal screen, scrollback, and current session history
  nono --resume              List and interactively select previous session context to resume
  nono --list-instructions   List the path of each nono.md file that will be used in the current folder
  nono --add-instructions    Create an empty nono.md file and open it in VS Code
  nono --commit              Generate commit message suggestions for staged edits and commit
  nono --gemini              Force using the Gemini API even if VLLM is configured
  nono --verbose             Show the whole raw vLLM responses
  nono --details             Open the logs and details of the current session in VS Code
  nono --get-pricing         Retrieve model pricing from web search and update configuration
  nono --pr-review [url] [--comment] [--auto] Run a GitHub PR review on the specified PR URL, optionally with interactive comment selection or automatic submission
  nono --raw                 Print the last final message in raw markdown with syntax highlighting
  nono --auto-continue, -ac  Auto-send "continue" on "Task completed" up to 3 times (or set NONO_AUTO_CONTINUE=true)
  nono --help, -h            Show this help information
`);
		process.exit(0);
		return;
	}

	// Handle --list-instructions command
	if (process.argv[2] === '--list-instructions') {
		const files = findNonoFiles(process.cwd());
		if (files.length === 0) {
			console.log('No nono.md files found in the current folder or any of its parent folders.');
		} else {
			files.forEach((file, index) => {
				console.log(`  [${index + 1}] ${file}`);
			});
		}
		process.exit(0);
		return;
	}

	// Handle --add-instructions command
	if (process.argv[2] === '--add-instructions') {
		const filePath = path.join(process.cwd(), 'nono.md');
		if (!fs.existsSync(filePath)) {
			try {
				fs.writeFileSync(filePath, '', 'utf8');
				console.log(`Created empty nono.md file at: ${filePath}`);
			} catch (e) {
				console.error(`Error creating nono.md file: ${e.message}`);
				process.exit(1);
			}
		} else {
			console.log(`nono.md file already exists at: ${filePath}`);
		}

		console.log(`Opening nono.md in VS Code...`);
		exec(`code ${JSON.stringify(filePath)}`, error => {
			if (error) {
				console.error(`Failed to open VS Code: ${error.message}`);
				process.exit(1);
			}
			process.exit(0);
		});
		return;
	}

	// Handle nono --get-pricing command
	if (process.argv[2] === '--get-pricing') {
		console.log('\x1b[35m✦ Fetching current pricing and country information...\x1b[0m\n');

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

		console.log('\x1b[35m✦ Generating git commit message suggestions...\x1b[0m\n');

		// 3. Call Gemini to generate suggestions
		try {
			let previousCommits = '';
			try {
				previousCommits = execSync('git log -n 10 --format=%s', {
					encoding: 'utf8'
				}).trim();
			} catch (e) {
				// Ignore if no commits yet
			}

			let previousCommitsPrompt = '';
			if (previousCommits) {
				previousCommitsPrompt = `\nHere are some of the previous commit messages in this repository for context on the project's commit style:\n<previous_commits>\n${previousCommits}\n</previous_commits>\n\nPlease closely follow the same format, style, and phrasing as the previous commits above (e.g. matching casing, prefixes, style patterns, imperative mood, etc.).`;
			}

			const prompt = `You are an expert assistant generating professional git commit messages based on staged changes (the git diff).
Here is the staged git diff:
<git_diff>
${diff}
</git_diff>
${previousCommitsPrompt}

Based on these changes, generate exactly 3 distinct, professional, and descriptive git commit message suggestions.
Follow the Conventional Commits style (e.g., feat(scope): message, fix: message, chore: message, docs: message, style: message, refactor: message) where appropriate (unless the previous commits suggest a different style, in which case prioritize matching the previous commit style).
Keep each suggestion concise (ideally under 72 characters) and on a single line.

Return ONLY the 3 suggestions, each on its own line, with absolutely no numbering, bullet points, headers, explanations, markdown formatting (no code blocks), or other text.
Example response:
feat: implement payment gateway integration
refactor: streamline user authentication middleware
fix: resolve null pointer exception in checkout flow`;

			let text = '';
			if (use_vllm) {
				const oai_response = await openai.chat.completions.create({
					model: vllm_model_name,
					messages: [{ role: 'user', content: prompt }]
				});
				text = oai_response.choices?.[0]?.message?.content || '';
				text = cleanModelText(text);
			} else {
				const response = await ai.models.generateContent({
					model: model_name,
					contents: [{ role: 'user', parts: [{ text: prompt }] }]
				});
				text = response.text || '';
			}
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

		console.log(`\x1b[35m✦ Initiating Github PR Review for ${owner}/${repo}#${pullNumber}...\x1b[0m\n`);

		githubFetch = async function (url, options = {}) {
			const headers = {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
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
				const gitOutput = execSync('git ls-files', {
					cwd: rootDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'ignore']
				});
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

	function isLikelyCode(text) {
		if (!text) return false;
		const trimmed = text.trim();
		if (trimmed.length < 5) return false;

		// If contains markdown code blocks, it's definitely code
		if (trimmed.includes('```')) return true;

		// Count indicators
		let score = 0;

		const lines = trimmed.split('\n');
		let endsWithSemicolon = 0;
		let emptyOrComment = 0;
		for (const line of lines) {
			const l = line.trim();
			if (!l) {
				emptyOrComment++;
				continue;
			}
			if (l.startsWith('//') || l.startsWith('#') || l.startsWith('/*')) {
				emptyOrComment++;
				continue;
			}
			if (l.endsWith(';')) {
				endsWithSemicolon++;
			}
		}
		const activeLines = lines.length - emptyOrComment;
		if (activeLines > 0 && endsWithSemicolon / activeLines > 0.3) {
			score += 3;
		}

		if (/[\w_]\s*=\s*/.test(trimmed)) score += 1;
		if (/\b(const|let|var|function|return|import|export|class|await|async)\b/.test(trimmed)) score += 2;
		if (/\b(def\s+\w+|elif|import\s+\w+|print\s*\(|if\s+__name__)\b/.test(trimmed)) score += 2;
		if (/\b(public\s+class|private\s+|protected\s+|#include|std::|using\s+namespace)\b/.test(trimmed)) score += 2;
		if (/\b(fn\s+\w+|let\s+mut|pub\s+fn|use\s+std::)\b/.test(trimmed)) score += 2;
		if (/\b(select\s+.*\s+from|insert\s+into|update\s+.*set)\b/i.test(trimmed)) score += 2;
		if (/<[a-z/][^>]*>/i.test(trimmed)) score += 2;
		if (/[\w_]\([^)]*\)\s*\{/.test(trimmed)) score += 2;
		if (/(===|!==|&&|\|\||=>)/.test(trimmed)) score += 2;
		if (/[{}]{2,}/.test(trimmed)) score += 1;

		const openBraces = (trimmed.match(/\{/g) || []).length;
		const closeBraces = (trimmed.match(/\}/g) || []).length;
		if (openBraces > 0 && openBraces === closeBraces) {
			score += 2;
		}

		const openParens = (trimmed.match(/\(/g) || []).length;
		const closeParens = (trimmed.match(/\)/g) || []).length;
		if (openParens > 0 && openParens === closeParens) {
			score += 1;
		}

		if (/^(hi|hello|please|hey|dear|could you|i want to|can you|explain|what is)\b/i.test(trimmed)) {
			score -= 3;
		}
		const wordCount = trimmed.split(/\s+/).length;
		if (wordCount > 15 && !trimmed.includes('{') && !trimmed.includes(';') && !trimmed.includes('def ')) {
			score -= 2;
		}

		return score >= 3;
	}

	function guessLanguage(text) {
		if (!text) return null;
		const trimmed = text.trim();

		// JSON check
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				JSON.parse(trimmed);
				return 'json';
			} catch (e) {}
		}

		// HTML check
		if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
			if (trimmed.includes('</div>') || trimmed.includes('</span>') || trimmed.includes('</p>') || trimmed.includes('</a>') || trimmed.includes('</html>')) {
				return 'html';
			}
		}

		// CSS check
		if (trimmed.includes('{') && trimmed.includes('}') && (trimmed.includes('margin:') || trimmed.includes('padding:') || trimmed.includes('color:') || trimmed.includes('display:'))) {
			return 'css';
		}

		// Python check
		if (/\b(def|class|elif|import)\b/.test(trimmed) && (trimmed.includes(':\n') || trimmed.includes('print('))) {
			if (!trimmed.includes('{') && !trimmed.includes(';')) {
				return 'python';
			}
		}

		// YAML check
		if (trimmed.includes('\n- ') || (trimmed.includes(': ') && !trimmed.includes('{') && !trimmed.includes('}'))) {
			return 'yaml';
		}

		// Markdown check
		if (trimmed.startsWith('#') || trimmed.includes('```')) {
			return 'markdown';
		}

		// TypeScript check
		if (/\b(interface|type|as\s+\w+|any|namespace|public|private|readonly)\b/.test(trimmed)) {
			return 'typescript';
		}

		// Default JS/TS check
		if (/\b(const|let|var|function|return|import|export|class|await|async)\b/.test(trimmed) || trimmed.includes('=>') || trimmed.includes('console.log')) {
			return 'javascript';
		}

		// Fallback if isLikelyCode
		if (isLikelyCode(trimmed)) {
			return 'javascript';
		}

		return null;
	}

	function getVscodeSelection() {
		const commands = ['wl-paste -p', 'wl-paste', 'xclip -o -selection primary', 'xclip -o -selection clipboard', 'xsel -p -o', 'xsel -b -o'];

		for (const cmd of commands) {
			try {
				const output = execSync(cmd, {
					stdio: ['ignore', 'pipe', 'ignore'],
					encoding: 'utf8'
				});
				if (output && output.trim()) {
					return output;
				}
			} catch (e) {
				// ignore and try next
			}
		}
		return null;
	}

	function getClipboardText() {
		const commands = ['wl-paste', 'xclip -o -selection clipboard', 'xsel -b -o'];

		for (const cmd of commands) {
			try {
				const output = execSync(cmd, {
					stdio: ['ignore', 'pipe', 'ignore'],
					encoding: 'utf8'
				});
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
		let vscode_context = '';
		let file_context = '';
		let clipboard_context = '';

		// 1. Parse --vscode / -vs
		let hasVscodeFlag = false;
		const vscodeIdx = process.argv.findIndex((arg, i) => i >= 2 && (arg === '-vs' || arg === '--vscode'));
		if (vscodeIdx !== -1) {
			hasVscodeFlag = true;
			process.argv.splice(vscodeIdx, 1);
		}

		if (hasVscodeFlag) {
			let selectionText = getVscodeSelection();
			if (!selectionText || !selectionText.trim()) {
				console.error('\x1b[31mError: No selected text found in VS Code / system clipboard.\x1b[0m');
				console.error('Please highlight some text in VS Code first.');
				process.exit(1);
			}

			const root = is_pr_review ? pr_review_temp_dir : findProjectRoot();
			const detectedFile = findFileContainingSelection(selectionText, root);
			const detectedLang = getLanguageFromExtension(detectedFile);

			if (detectedLang) {
				try {
					selectionText = await formatCodeWithPrettier(selectionText, detectedLang);
				} catch (e) {
					// silent
				}
			}

			console.log('\n\x1b[36m✦ VSCode Selected Text Detected:\x1b[0m');
			if (detectedFile) {
				const relativePath = path.relative(root || process.cwd(), detectedFile);
				console.log(`  File: \x1b[33m${relativePath}\x1b[0m`);
			} else {
				console.log('  File: \x1b[90m(Not detected in workspace)\x1b[0m');
			}
			console.log('\x1b[90m--------------------------------------------------\x1b[0m');

			let highlighted;
			if (detectedLang && cliHighlight.supportsLanguage(detectedLang)) {
				try {
					highlighted = cliHighlight.highlight(selectionText.trim(), {
						language: detectedLang,
						ignoreIllegals: true,
						theme: custom_theme
					});
				} catch (e) {
					highlighted = selectionText.trim();
				}
			} else {
				highlighted = selectionText.trim();
			}
			console.log(highlighted);
			console.log('\x1b[90m--------------------------------------------------\x1b[0m\n');

			vscode_context = `\n\n[VS Code Selection Context]\n`;
			if (detectedFile) {
				const relativePath = path.relative(root || process.cwd(), detectedFile);
				vscode_context += `File: ${relativePath}\n`;
			}
			vscode_context += `\`\`\`${detectedLang}\n${selectionText.trim()}\n\`\`\``;
		}

		// 2. Parse --file / -f [path][:line][:start_line-end_line]
		let hasFileFlag = false;
		const fileIdx = process.argv.findIndex((arg, i) => i >= 2 && (arg === '-f' || arg === '--file'));
		if (fileIdx !== -1) {
			hasFileFlag = true;
			const fileArg = process.argv[fileIdx + 1];
			if (!fileArg || fileArg.startsWith('-')) {
				console.error('\x1b[31mError: Missing file path for --file (-f) command.\x1b[0m');
				console.error('Usage: nono --file <path>[:line] or --file <path>[:start_line-end_line]');
				process.exit(1);
			}
			process.argv.splice(fileIdx, 2);

			let filePath = fileArg;
			let startLine = null;
			let endLine = null;

			const rangeMatch = fileArg.match(/:(\d+)[-:](\d+)$/);
			const singleMatch = fileArg.match(/:(\d+)$/);

			if (rangeMatch) {
				startLine = parseInt(rangeMatch[1], 10);
				endLine = parseInt(rangeMatch[2], 10);
				filePath = fileArg.substring(0, rangeMatch.index);
			} else if (singleMatch) {
				startLine = parseInt(singleMatch[1], 10);
				endLine = startLine;
				filePath = fileArg.substring(0, singleMatch.index);
			}

			let resolvedPath = path.resolve(process.cwd(), filePath);
			if (!fs.existsSync(resolvedPath)) {
				const root = is_pr_review ? pr_review_temp_dir : findProjectRoot();
				if (root) {
					resolvedPath = path.resolve(root, filePath);
				}
			}

			if (!fs.existsSync(resolvedPath)) {
				console.error(`\x1b[31mError: File not found: ${filePath}\x1b[0m`);
				process.exit(1);
			}

			let fileContent = '';
			try {
				fileContent = fs.readFileSync(resolvedPath, 'utf8');
			} catch (err) {
				console.error(`\x1b[31mError reading file ${filePath}: ${err.message}\x1b[0m`);
				process.exit(1);
			}

			const lines = fileContent.split(/\r?\n/);
			let selectedLines = [];
			if (startLine !== null && endLine !== null) {
				const totalLines = lines.length;
				const sLine = Math.max(1, Math.min(startLine, totalLines));
				const eLine = Math.max(1, Math.min(endLine, totalLines));
				selectedLines = lines.slice(sLine - 1, eLine);
			} else {
				selectedLines = lines;
			}
			let extractedText = selectedLines.join('\n');
			const detectedLang = getLanguageFromExtension(filePath);

			if (detectedLang) {
				try {
					extractedText = await formatCodeWithPrettier(extractedText, detectedLang);
				} catch (e) {
					// silent
				}
			}

			console.log(`\n\x1b[36m✦ File Context Detected:\x1b[0m`);
			let lineRangeInfo = '';
			if (startLine !== null && endLine !== null) {
				if (startLine === endLine) {
					lineRangeInfo = ` (Line ${startLine})`;
				} else {
					lineRangeInfo = ` (Lines ${startLine}-${endLine})`;
				}
			}
			console.log(`  File: \x1b[33m${filePath}\x1b[0m${lineRangeInfo}`);
			console.log('\x1b[90m--------------------------------------------------\x1b[0m');

			let highlighted;
			let isLangSupported = detectedLang && detectedLang !== 'plain' && cliHighlight.supportsLanguage(detectedLang);
			if (isLangSupported) {
				try {
					highlighted = cliHighlight.highlight(extractedText, {
						language: detectedLang,
						ignoreIllegals: true,
						theme: custom_theme
					});
				} catch (e) {
					highlighted = extractedText;
				}
			} else if (isLikelyCode(extractedText)) {
				try {
					highlighted = cliHighlight.highlight(extractedText, {
						ignoreIllegals: true,
						theme: custom_theme
					});
				} catch (e) {
					highlighted = extractedText;
				}
			} else {
				highlighted = extractedText;
			}
			console.log(highlighted);
			console.log('\x1b[90m--------------------------------------------------\x1b[0m\n');

			file_context = `\n\n[File Context]\nFile: ${filePath}${lineRangeInfo}\n\`\`\`${detectedLang}\n${extractedText}\n\`\`\``;
		}

		// 3. Parse --clipboard / -c
		let hasClipboardFlag = false;
		const clipboardIdx = process.argv.findIndex((arg, i) => i >= 2 && (arg === '-c' || arg === '--clipboard'));
		if (clipboardIdx !== -1) {
			hasClipboardFlag = true;
			process.argv.splice(clipboardIdx, 1);
		}

		if (hasClipboardFlag) {
			let clipboardText = getClipboardText();
			if (!clipboardText || !clipboardText.trim()) {
				console.error('\x1b[31mError: No text found in clipboard.\x1b[0m');
				process.exit(1);
			}

			const guessedLang = guessLanguage(clipboardText);
			if (guessedLang) {
				try {
					clipboardText = await formatCodeWithPrettier(clipboardText, guessedLang);
				} catch (e) {
					// silent
				}
			}

			console.log('\n\x1b[36m✦ Clipboard Text Detected:\x1b[0m');
			console.log('\x1b[90m--------------------------------------------------\x1b[0m');
			let highlighted = clipboardText.trim();
			if (isLikelyCode(highlighted)) {
				try {
					highlighted = cliHighlight.highlight(highlighted, {
						ignoreIllegals: true,
						theme: custom_theme
					});
				} catch (e) {
					highlighted = clipboardText.trim();
				}
			}
			console.log(highlighted);
			console.log('\x1b[90m--------------------------------------------------\x1b[0m\n');

			const codeBlockLang = guessedLang || '';
			clipboard_context = `\n\n[Clipboard Context]\n\`\`\`${codeBlockLang}\n${clipboardText.trim()}\n\`\`\``;
		}

		if (process.argv[2] === '--write' || process.argv[2] === '-w') {
			const tempPath = path.join(os.tmpdir(), `nono_prompt_${Date.now()}_temp.txt`);
			try {
				fs.writeFileSync(tempPath, '', 'utf8');
				await new Promise((resolve, reject) => {
					const editors = [];
					if (process.env.NONO_EDITOR) {
						editors.push(process.env.NONO_EDITOR);
					} else {
						if (process.env.VISUAL) editors.push(process.env.VISUAL);
						if (process.env.EDITOR) editors.push(process.env.EDITOR);
						for (const fallback of ['vim', 'vi', 'nano']) {
							if (!editors.includes(fallback)) {
								editors.push(fallback);
							}
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
			if (use_vllm) await ensureVllmInitialized();
			else await ensureAiInitialized();
			let printedPrompt = user_query.trim();
			try {
				printedPrompt = await formatMarkdownForTerminal(printedPrompt);
			} catch (e) {}
			console.log(`\x1b[35m>\x1b[0m ${printedPrompt}\n`);
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

		let combined_context = '';
		if (vscode_context) combined_context += vscode_context;
		if (file_context) combined_context += file_context;
		if (clipboard_context) combined_context += clipboard_context;

		if (combined_context) {
			user_query += combined_context;
		}
	}

	// Reset the elapsed timer to exclude prompt typing time
	start_time = Date.now();

	// Create/Clear details file for this command run
	setDetailsPath(path.join(cache_dir, `details-${process.ppid}.log`));
	fs.writeFileSync(getDetailsPath(), '', 'utf8');

	// Load or initialize session
	const session_path = is_pr_review ? path.join(cache_dir, `session-pr-${process.ppid}.json`) : path.join(cache_dir, `session-${process.ppid}.json`);
	let history = [];
	if (!is_initial_pr_review && fs.existsSync(session_path)) {
		try {
			history = sanitizeHistory(JSON.parse(fs.readFileSync(session_path, 'utf8')));
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

	api_static_overhead = null;
	total_candidates_token_count = 0;
	total_api_duration_ms = 0;
	vllm_ttft = null;
	vllm_tick_speeds = [];

	// Add the new user query to the history
	const full_user_prompt = `${user_query}${context_bonus}`;
	await pushToHistoryAndCheckLimit(
		history,
		{
			role: 'user',
			parts: [{ text: full_user_prompt }]
		},
		session_path
	);

	writeDetails(`[User Query] ${user_query}\n[PPID] ${process.ppid}\n`);

	if (is_initial_pr_review) {
		console.log('\x1b[90m✦ Starting analysis...\x1b[0m');
	}

	// Count tokens of initial history
	if (use_vllm) {
		latest_context_size = Math.round(JSON.stringify(history).length / 3.7);
	} else if (ai) {
		try {
			const token_count_res = await ai.models.countTokens({
				model: model_name,
				contents: history
			});
			latest_context_size = token_count_res.totalTokens || 0;
		} catch (e) {}
	}
	drawBottomLine();

	// Start the ReAct execution loop
	let pendingSummaryTriggers = [];
	const grounding_sources = [];
	const web_search_queries = [];
	let autoContinueCount = 0;
	reactLoop: while (true) {
		try {
			let response;
			let attempts = 0;
			const maxAttempts = 3;
			while (true) {
				try {
					const start_api_time = Date.now();
					if (use_vllm) {
						const systemInstruction = is_initial_pr_review ? (isCommentMode ? pr_review_comment_system_prompt : pr_review_system_prompt) : system_prompt;
						const openAIMessages = convertToOpenAIMessages(history, systemInstruction);
						const base_tools = is_initial_pr_review
							? tools_declarations.filter(tool => ['list_directory_structure', 'view_file_contents', 'search_grep', 'execute_system_command'].includes(tool.name)).concat([view_file_git_diff_declaration])
							: tools_declarations;
						const vllm_tools = base_tools.concat([gemini_web_search_declaration]);
						const openAITools = convertGeminiToolsToOpenAI(vllm_tools);

						is_talking_active = true;
						talking_token_count = 0;
						latest_tok_speed = 0;
						vllm_start_time = null;
						vllm_baseline_generation = latest_vllm_stats?.vllm?.generation_tokens_total !== undefined ? latest_vllm_stats.vllm.generation_tokens_total : null;
						current_tool_being_called = null;

						vllm_request_start_time = Date.now();
						last_vllm_tokens = null;
						last_vllm_time = null;
						latest_vllm_tick_speed = 0;

						drawBottomLine();

						const oai_response = await openai.chat.completions.create({
							model: vllm_model_name,
							messages: openAIMessages,
							tools: openAITools,
							tool_choice: 'auto',
							stream: false
						});

						is_talking_active = false;
						if (vllm_start_time) {
							latest_vllm_generation_duration_ms = Date.now() - vllm_start_time;
						} else {
							latest_vllm_generation_duration_ms = null;
						}
						vllm_baseline_generation = null;
						vllm_start_time = null;
						drawBottomLine();

						const choice = oai_response.choices?.[0];
						const usage = oai_response.usage;

						let content_text = (choice?.message?.content || '').trim();

						// Strip dangling/leftover characters at the start of content
						if (content_text.startsWith('</think>')) {
							content_text = content_text.substring(8).trim();
						}
						if (content_text.startsWith(')') || content_text.startsWith('}')) {
							content_text = content_text.substring(1).trim();
						}
						if (content_text.startsWith('</think>')) {
							content_text = content_text.substring(8).trim();
						}

						// Clean up dangling parenthesis/braces/malformed tags before <tool_call>
						content_text = content_text.replace(/[\r\n]\s*[)}]\s*(?=[\r\n]\s*<tool_call>)/gi, '\n');
						content_text = content_text.replace(/<tool_call>\s*[)}]\s*(?=[\r\n]\s*<tool_call>)/gi, '');

						let reasoning = (choice?.message?.reasoning_content || '').trim();
						let full_text = content_text;

						if (reasoning) {
							full_text = `<think>${reasoning}</think>\n${full_text}`;
						} else {
							// If no reasoning_content, check if content_text has a dangling closing tag
							if (full_text.includes('</think>') && !full_text.includes('<think>')) {
								full_text = `<think>${full_text}`;
							}
						}

						if (verbose && full_text) {
							console.log(`\x1b[90m${full_text}\x1b[0m\n`);
						}

						const choice_with_reasoning = {
							message: {
								role: 'assistant',
								content: full_text || null,
								tool_calls: choice?.message?.tool_calls
							}
						};

						response = {
							candidates: [
								{
									content: convertToGeminiResponse(choice_with_reasoning)
								}
							],
							usageMetadata: usage
								? {
										candidatesTokenCount: usage.completion_tokens,
										promptTokenCount: usage.prompt_tokens,
										totalTokenCount: usage.total_tokens
									}
								: null
						};
					} else {
						response = await ai.models.generateContent({
							model: model_name,
							contents: history,
							config: {
								systemInstruction: is_initial_pr_review ? (isCommentMode ? pr_review_comment_system_prompt : pr_review_system_prompt) : system_prompt,
								tools: [
									{
										functionDeclarations: (is_initial_pr_review
											? tools_declarations.filter(tool => ['list_directory_structure', 'view_file_contents', 'search_grep', 'execute_system_command'].includes(tool.name)).concat([view_file_git_diff_declaration])
											: tools_declarations
										).concat([gemini_web_search_declaration])
									}
								],
								toolConfig: {
									functionCallingConfig: {
										mode: 'AUTO'
									}
								}
							}
						});
					}
					const duration_ms = Date.now() - start_api_time;
					if (response && response.usageMetadata) {
						const cand_tokens = response.usageMetadata.candidatesTokenCount || 0;
						let speed_duration_ms = duration_ms;
						if (use_vllm && latest_vllm_generation_duration_ms !== null) {
							speed_duration_ms = latest_vllm_generation_duration_ms;
						}
						latest_tok_speed = speed_duration_ms > 0 ? Math.round(cand_tokens / (speed_duration_ms / 1000)) : 0;
						total_candidates_token_count += cand_tokens;
						total_api_duration_ms += speed_duration_ms;

						if (!use_vllm) {
							const prompt_tokens = response.usageMetadata.promptTokenCount || 0;
							const total_tokens = response.usageMetadata.totalTokenCount || prompt_tokens + cand_tokens;
							if (api_static_overhead === null) {
								const history_before = latest_context_size || 0;
								api_static_overhead = Math.max(0, prompt_tokens - history_before);
							}
							latest_context_size = Math.max(0, total_tokens - api_static_overhead);
						} else {
							latest_context_size = response.usageMetadata.totalTokenCount || response.usageMetadata.promptTokenCount + response.usageMetadata.candidatesTokenCount || 0;
						}

						drawBottomLine();
					}
					break;
				} catch (apiErr) {
					attempts++;
					const err_str = String(apiErr.message || apiErr);
					if (err_str.includes('--enable-auto-tool-choice') || err_str.includes('tool-call-parser') || err_str.includes('tool choice')) {
						console.error(`\n\x1b[31mError: vLLM server is not configured for tool calling!\x1b[0m`);
						console.error(`\x1b[33mTo fix this, please restart your vLLM server with these flags:\x1b[0m`);
						console.error(`\x1b[36m  --enable-auto-tool-choice --tool-call-parser <hermes|llama|mistral>\x1b[0m\n`);
					}
					const is_transient = err_str.includes('503') || err_str.includes('429') || err_str.includes('UNAVAILABLE') || err_str.includes('service is currently unavailable');
					if (is_transient && attempts < maxAttempts) {
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

			if (model_message && !model_message.role) {
				model_message.role = 'model';
			}

			// Capture and display Google Search Grounding metadata
			const groundingMetadata = candidate?.groundingMetadata;
			if (groundingMetadata) {
				if (Array.isArray(groundingMetadata.webSearchQueries)) {
					const queries = groundingMetadata.webSearchQueries.filter(q => typeof q === 'string' && q.trim().length > 0);
					for (const query of queries) {
						if (!web_search_queries.includes(query)) {
							web_search_queries.push(query);
							updateProgress(`• Web Search: "${query}"`);
						}
					}
				}
				if (Array.isArray(groundingMetadata.groundingChunks)) {
					for (const chunk of groundingMetadata.groundingChunks) {
						if (chunk.web && typeof chunk.web.uri === 'string') {
							const title = chunk.web.title || chunk.web.uri;
							if (!grounding_sources.some(src => src.uri === chunk.web.uri)) {
								grounding_sources.push({ uri: chunk.web.uri, title });
							}
						}
					}
				}
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
			await pushToHistoryAndCheckLimit(history, model_message, session_path);

			// Print any thoughts/explanations the model outputs in this turn
			const text_part = model_message.parts?.find(p => p.text);
			const function_calls = model_message.parts?.filter(p => p.functionCall && tools_mapping[p.functionCall.name]);
			const has_function_calls = function_calls && function_calls.length > 0;

			if (text_part && text_part.text) {
				writeDetails(`\n[Model Thought]\n${text_part.text.trim()}`);
			}

			if (!has_function_calls) {
				if (isCommentMode) {
					clearProgress();

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
							const commentBody = cleanText ? `${severityStr}${cleanText}` : `${severityStr}${issueJson.message}`;
							prComments.push({
								path: issueJson.file,
								line: issueJson.line,
								body: commentBody
							});
							history.push({
								role: 'user',
								parts: [
									{
										text: 'User chose to comment on this issue. Please present the next issue.'
									}
								]
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
										parts: [
											{
												text: 'User chose to skip this issue. Please present the next issue.'
											}
										]
									});
									console.log('\x1b[90mSkipping issue...\x1b[0m\n');
								} else if (choice === 'c' || choice === 'comment') {
									validChoice = true;
									lastIssueJson = null;
									const severityStr = issueJson.severity ? `**[${issueJson.severity.toUpperCase()}]** ` : '';
									const commentBody = cleanText ? `${severityStr}${cleanText}` : `${severityStr}${issueJson.message}`;
									prComments.push({
										path: issueJson.file,
										line: issueJson.line,
										body: commentBody
									});
									history.push({
										role: 'user',
										parts: [
											{
												text: 'User chose to comment on this issue. Please present the next issue.'
											}
										]
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
								parts: [
									{
										text: 'Please present the next issue (or state "No more issues" if there are none).'
									}
								]
							});
							console.log('\x1b[90mAutomatically proceeding to next issue...\x1b[0m\n');
						} else {
							const promptText = await askUser('Enter your prompt / question, or type "next" to continue: ');
							if (promptText.trim().toLowerCase() === 'next') {
								lastIssueJson = null;
								history.push({
									role: 'user',
									parts: [
										{
											text: 'Please present the next issue (or state "No more issues" if there are none).'
										}
									]
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
					// No functions to call but hasn't called final_answer!
					// Push a user/assistant nudge to force the loop to continue.
					writeDetails(`[Loop Nudge] Model did not call any tools. Nudging to continue.`);
					history.push({
						role: 'user',
						parts: [{ text: 'Please continue the task using the appropriate tools. If you are completely done, you MUST call the "final_answer" tool with your final response.' }]
					});
					pruneHistory(history);
					fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');

					start_time = Date.now();
					continue;
				}
			}

			// Execute requested functions sequentially to prevent interleaved console logs & cursor corruption
			const response_parts = [];
			for (const call_part of function_calls) {
				const call = call_part.functionCall;
				const { name, args, id } = call;

				current_tool_being_called = name;
				drawBottomLine();

				writeDetails(`\n[Tool Call] Running: ${name} with args:\n${JSON.stringify(args, null, 2)}`);

				const tool_fn = tools_mapping[name];
				let result;
				if (!tool_fn) {
					result = { error: `Tool "${name}" is not implemented.` };
				} else {
					try {
						result = await tool_fn(args, history);
					} catch (err) {
						result = { error: err.message || String(err) };
					}
				}

				current_tool_being_called = null;
				drawBottomLine();

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

				if (name !== 'write_file' && name !== 'patch_file' && name !== 'comment' && name !== 'final_answer') {
					const tool_progress = formatToolCallProgress(name, args);
					const suffix = isSummarized ? ' \x1b[90m[sum]\x1b[0m' : '';
					const progressLine = formatProgressLine(`• ${tool_progress}${suffix}`);
					console.log(progressLine);
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

				if (name === 'final_answer') {
					await finishProgress(args.response || 'Task completed.', grounding_sources);
					await pushToHistoryAndCheckLimit(
						history,
						{
							role: 'user',
							parts: response_parts
						},
						session_path
					);
					break reactLoop;
				}
			}

			// Push user/tool execution results back into the conversation history
			await pushToHistoryAndCheckLimit(
				history,
				{
					role: 'user',
					parts: response_parts
				},
				session_path
			);

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
			console.log(`\n\x1b[35m✦ Review complete. You have selected ${prComments.length} comment(s) to post.\x1b[0m\n`);
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
				while (true) {
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
						break;
					} catch (err) {
						console.log(`\n\x1b[33m• Direct review submission failed (${err.message || err}).\x1b[0m`);
						console.log(`\x1b[90mRetrying with individual comment validation fallback...\x1b[0m`);

						try {
							// 1. Get HEAD commit SHA
							let commit_id;
							try {
								commit_id = execSync('git rev-parse HEAD', {
									encoding: 'utf8'
								}).trim();
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
							break;
						} catch (fallbackErr) {
							console.error(`\x1b[31mError submitting review during fallback: ${fallbackErr.message || fallbackErr}\x1b[0m`);
							playChime('error');

							console.log(`\n\x1b[31m• PR review submission failed. Please verify your connection, credentials, or GITHUB_ACCESS_TOKEN in your .env file.\x1b[0m`);
							await askUser('\x1b[33mPress Enter to retry sending the PR review...\x1b[0m', false);

							dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true, override: true });
							dotenv.config({
								path: path.join(os.homedir(), '.config', 'nono', '.env'),
								quiet: true,
								override: true
							});
							dotenv.config({ path: path.join(dir_name, '.env'), quiet: true, override: true });
						}
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch(err => {
		console.error('\x1b[31mFatal error:\x1b[0m', err);
		playChime('error');
		process.exit(1);
	});
}

export { formatMarkdownForTerminal };
