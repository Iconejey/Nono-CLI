#!/usr/bin/env node

import pty from 'node-pty';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { callModel } from './api.js';
import { loadConfig, getEffectiveModel } from './config.js';
import { HistoryManager, stripAnsi } from './history.js';

// States
const state_terminal = 'TERMINAL';
const state_ai_input = 'AI_INPUT';
const state_ai_running = 'AI_RUNNING';
const state_ai_command = 'AI_COMMAND';

let state = state_terminal;

// Config and Models
let config = loadConfig();
let current_model_index = 0;

// Terminal History and Prompt Tracking
const history_manager = new HistoryManager(100);
let last_pty_line = '';
let prompt_start_column = null;

// AI Input state
let ai_input = '';
let waiting_for_cursor_check = false;
let cursor_check_buffer = '';
const all_commands = [
	{ name: 'exit', description: 'Exit Nono terminal wrapper' },
	{ name: 'restart', description: 'Reload Nono configuration' }
];
let current_suggestion_index = 0;

// Command execution state
let command_output_buffer = '';
let on_command_finished = null;
let command_check_interval = null;
let last_pty_data_time = Date.now();

// Spawn shell PTY
const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const pty_process = pty.spawn(shell, [], {
	name: 'xterm-256color',
	cols: process.stdout.columns || 80,
	rows: process.stdout.rows || 24,
	cwd: process.cwd(),
	env: {
		...process.env,
		// Ensure terminal wrapper info or colors work nicely
		TERM: 'xterm-256color'
	}
});

// Setup stdin/stdout
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

// Handle window resizing
process.stdout.on('resize', () => {
	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;
	pty_process.resize(cols, rows);
});

// Get process groups to check if a command is running in the foreground
function getPgrpAndTpgid(pid) {
	try {
		const stat = fs.readFileSync(path.join('/proc', String(pid), 'stat'), 'utf8');
		const last_paren = stat.lastIndexOf(')');
		if (last_paren === -1) return null;
		const fields = stat
			.substring(last_paren + 2)
			.trim()
			.split(/\s+/);
		return {
			pgrp: parseInt(fields[2], 10),
			tpgid: parseInt(fields[5], 10)
		};
	} catch (e) {
		return null;
	}
}

function isShellInForeground() {
	const stats = getPgrpAndTpgid(pty_process.pid);
	if (!stats) return true; // Fallback to true if we can't check
	return stats.pgrp === stats.tpgid;
}

// Query current cursor position from the terminal emulator
function queryCursorPosition() {
	if (state === state_terminal) {
		process.stdout.write('\x1b[6n');
	}
}

// Initialize prompt column shortly after startup
setTimeout(() => {
	queryCursorPosition();
}, 300);

// PTY -> Term Output
pty_process.onData(data => {
	last_pty_data_time = Date.now();

	// Append raw data to history
	history_manager.append(data);

	// Track the last printed line (which contains the prompt)
	const parts = data.split(/\r?\n/);
	if (parts.length === 1) {
		last_pty_line += parts[0];
	} else {
		last_pty_line = parts[parts.length - 1];
	}

	// Pipe to stdout based on state
	if (state === state_terminal) {
		process.stdout.write(data);
	} else if (state === state_ai_command) {
		process.stdout.write(data);
		command_output_buffer += data;
	}
});

// Shell exit
pty_process.onExit(({ exitCode }) => {
	process.exit(exitCode);
});

// Stdin handler
process.stdin.on('data', data => {
	handleStdin(data);
});

function handleStdin(data) {
	const str = data.toString('utf8');

	// 1. Intercept Cursor Position Response: \x1b[row;colR
	const cursor_match = str.match(/\x1b\[(\d+);(\d+)R/);
	if (cursor_match) {
		const col = parseInt(cursor_match[2], 10);
		const remaining = str.replace(/\x1b\[\d+;\d+R/, '');

		if (waiting_for_cursor_check) {
			waiting_for_cursor_check = false;
			if (prompt_start_column === null || col === prompt_start_column) {
				prompt_start_column = col; // Save or update
				enterAiMode();
				if (cursor_check_buffer.length > 0) {
					ai_input += cursor_check_buffer;
					process.stdout.write(cursor_check_buffer);
				}
			} else {
				// Not at prompt start, forward '<' and anything typed during check to PTY
				pty_process.write('<' + cursor_check_buffer);
			}
			cursor_check_buffer = '';
		} else {
			prompt_start_column = col;
		}

		if (remaining.length > 0) {
			handleStdin(Buffer.from(remaining, 'utf8'));
		}
		return;
	}

	// 2. If waiting for cursor check, buffer all keys
	if (waiting_for_cursor_check) {
		cursor_check_buffer += str;
		return;
	}

	// 3. Process based on current state
	if (state === state_terminal) {
		// Check if '<' is pressed and shell is idle
		if (str === '<' && isShellInForeground()) {
			waiting_for_cursor_check = true;
			cursor_check_buffer = '';
			queryCursorPosition();
		} else {
			pty_process.write(data);
		}
	} else if (state === state_ai_input) {
		handleAiInputKey(str);
	} else if (state === state_ai_command) {
		// Pipe input to PTY (interactive command support like sudo password or aborting)
		pty_process.write(data);
	}
}

function enterAiMode() {
	if (!config || config.length === 0) {
		process.stdout.write(`\n\x1b[31mError: No models configured. Please check your config.json file in the Nono directory.\x1b[0m\n`);
		process.stdout.write(last_pty_line);
		state = state_terminal;
		return;
	}

	const model_config = getEffectiveModel(config[current_model_index]);
	if (!model_config.apiKey) {
		process.stdout.write(`\n\x1b[31mError: API key for ${model_config.title} is not set.\x1b[0m\n`);
		process.stdout.write(`Please configure it in the config.json file in the Nono directory.\n`);
		process.stdout.write(last_pty_line);
		state = state_terminal;
		return;
	}

	state = state_ai_input;
	ai_input = '';
	renderAiPrompt();
}

function exitAiMode() {
	state = state_terminal;
	ai_input = '';
	// Clear prompt line and suggestions below
	process.stdout.write('\r\x1b[K\x1b[s\n\x1b[J\x1b[u');
	process.stdout.write(last_pty_line);
}

function loopModel() {
	if (!config || config.length === 0) return;
	current_model_index = (current_model_index + 1) % config.length;
	renderAiPrompt();
}

function renderAiPrompt() {
	if (!config || config.length === 0) return;
	const model = config[current_model_index];

	const is_suggesting = ai_input.startsWith('/');
	if (is_suggesting) {
		const query = ai_input.slice(1).toLowerCase();
		const suggestions = all_commands.filter(c => c.name.startsWith(query));

		// Cap suggestion index
		if (suggestions.length === 0) {
			current_suggestion_index = -1;
		} else if (current_suggestion_index >= suggestions.length) {
			current_suggestion_index = suggestions.length - 1;
		} else if (current_suggestion_index < 0 && suggestions.length > 0) {
			current_suggestion_index = 0;
		}

		// Print AI prompt line
		process.stdout.write(`\r\x1b[K\x1b[1m\x1b[35m${model.title}>\x1b[0m ${ai_input}`);

		// Save cursor position, move to next line, clear screen below
		process.stdout.write(`\x1b[s\n\x1b[J\x1b[u`);

		// Print suggestions below the cursor
		for (let i = 0; i < suggestions.length; i++) {
			const sug = suggestions[i];
			const is_selected = i === current_suggestion_index;
			const prefix = is_selected ? '\x1b[1;32m > \x1b[0m' : '   ';
			const desc = `\x1b[2m${sug.description}\x1b[0m`;
			process.stdout.write(`\n\r\x1b[K${prefix}/${sug.name} - ${desc}`);
		}

		// Restore cursor position
		process.stdout.write(`\x1b[u`);
	} else {
		// Normal prompt, clear anything below in case suggestions were visible
		process.stdout.write(`\r\x1b[K\x1b[1m\x1b[35m${model.title}>\x1b[0m ${ai_input}\x1b[s\n\x1b[J\x1b[u`);
	}
}

function reloadNono() {
	try {
		config = loadConfig();
		// Clear suggestions first
		process.stdout.write(`\x1b[s\n\x1b[J\x1b[u`);
		process.stdout.write(`\n\x1b[32m[Nono config reloaded]\x1b[0m\n`);
		if (config.length > 0 && current_model_index >= config.length) {
			current_model_index = 0;
		}
		renderAiPrompt();
	} catch (e) {
		process.stdout.write(`\x1b[s\n\x1b[J\x1b[u`);
		process.stdout.write(`\n\x1b[31m[Error reloading config: ${e.message}]\x1b[0m\n`);
		renderAiPrompt();
	}
}

function handleAiInputKey(str) {
	if (str === '\x03') {
		// Ctrl+C
		exitAiMode();
		return;
	}

	const is_suggesting = ai_input.startsWith('/');
	const query = is_suggesting ? ai_input.slice(1).toLowerCase() : '';
	const suggestions = is_suggesting ? all_commands.filter(c => c.name.startsWith(query)) : [];

	// Handle arrow navigation when suggestions are active
	if (str === '\x1b[A' || str === '\x1bOA') {
		// Up Arrow
		if (is_suggesting && suggestions.length > 0) {
			current_suggestion_index = (current_suggestion_index - 1 + suggestions.length) % suggestions.length;
			renderAiPrompt();
		}
		return;
	}
	if (str === '\x1b[B' || str === '\x1bOB') {
		// Down Arrow
		if (is_suggesting && suggestions.length > 0) {
			current_suggestion_index = (current_suggestion_index + 1) % suggestions.length;
			renderAiPrompt();
		}
		return;
	}

	if (str === '\x1b') {
		// Escape
		if (ai_input.length > 0) {
			ai_input = '';
			renderAiPrompt();
		} else {
			exitAiMode();
		}
		return;
	}

	if (str === '\r' || str === '\n') {
		if (is_suggesting && suggestions.length > 0 && current_suggestion_index >= 0) {
			const selected_sug = suggestions[current_suggestion_index];
			const selected_name = '/' + selected_sug.name;
			if (ai_input !== selected_name) {
				// Autocomplete the name
				ai_input = selected_name;
				current_suggestion_index = 0;
				renderAiPrompt();
				return;
			}
		}

		// Execute exact matching slash commands
		if (ai_input === '/exit') {
			// Clear suggestions menu display
			process.stdout.write('\x1b[s\n\x1b[J\x1b[u');
			pty_process.kill();
			process.exit(0);
		}
		if (ai_input === '/restart') {
			reloadNono();
			return;
		}

		// Normal AI prompt submit
		if (ai_input.trim().length > 0) {
			submitAiQuery();
		}
		return;
	}

	if (str === '\x7f' || str === '\x08') {
		// Backspace
		if (ai_input.length > 0) {
			ai_input = ai_input.slice(0, -1);
			renderAiPrompt(); // Redraw prompt and suggestions
		}
		return;
	}

	if (str === '<' && ai_input.length === 0) {
		loopModel();
		return;
	}

	if (str.startsWith('\x1b')) {
		// Ignore escape sequences (like arrows)
		return;
	}

	// Handle printable text / paste
	const printable = str.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
	if (printable.length > 0) {
		ai_input += printable;
		renderAiPrompt();
	}
}

async function submitAiQuery() {
	process.stdout.write('\n');
	state = state_ai_running;

	const model_config = getEffectiveModel(config[current_model_index]);
	const messages = [
		{
			role: 'system',
			content: `You are Nono, an AI-powered terminal assistant.
You are running inside a terminal wrapper on the user's computer.
You have the context of the terminal history.
You can execute terminal commands to help the user.
To execute a command, use the run_command tool.
When running commands, prefer non-interactive flags (e.g. -y) and do not use command-line pagers (like less or more).
After you run a command, you will see its output, and you can continue your task or respond to the user.`
		},
		{
			role: 'system',
			content: `Here is the recent terminal history for context:
---
${history_manager.getCleanHistory()}
---`
		},
		{
			role: 'user',
			content: ai_input
		}
	];

	const tools = [
		{
			type: 'function',
			function: {
				name: 'run_command',
				description: 'Execute a shell command in the terminal and return its stdout/stderr output.',
				parameters: {
					type: 'object',
					properties: {
						command: {
							type: 'string',
							description: 'The shell command to execute.'
						}
					},
					required: ['command']
				}
			}
		}
	];

	let has_executed_command = false;

	try {
		while (state === state_ai_running) {
			process.stdout.write('\x1b[2mNono is thinking...\x1b[0m\r');

			const response = await callModel(model_config, messages, tools);

			// Clear the "thinking..." indicator
			process.stdout.write('\r\x1b[K');

			// Append assistant's turn
			messages.push(response);

			if (response.tool_calls && response.tool_calls.length > 0) {
				// Execute tool call(s)
				const tool_call = response.tool_calls[0]; // Process first tool call
				if (tool_call.function.name === 'run_command') {
					const args = JSON.parse(tool_call.function.arguments);
					const cmd = args.command;

					// Print grey sparkle prefix (without a newline) so the PTY command echo appends to it
					process.stdout.write(`\x1b[2m✦\x1b[0m `);
					has_executed_command = true;

					// Execute command in PTY
					const output = await executeCommandInPty(cmd);

					// Append tool result
					messages.push({
						role: 'tool',
						tool_call_id: tool_call.id,
						name: 'run_command',
						content: output
					});
				} else {
					// Unsupported tool
					messages.push({
						role: 'tool',
						tool_call_id: tool_call.id,
						name: tool_call.function.name,
						content: `Error: Unsupported tool ${tool_call.function.name}`
					});
				}
			} else {
				// No tool calls, AI is finished
				if (response.content) {
					// Print response in a distinct style (bold purple ✦ followed by response)
					process.stdout.write(`\x1b[1;35m✦\x1b[0m ${response.content}\n`);
				}
				break;
			}
		}
	} catch (error) {
		process.stdout.write(`\r\x1b[K\x1b[31mError: ${error.message}\x1b[0m\n`);
	}

	// Restore terminal mode
	state = state_terminal;
	ai_input = '';

	// Reprint the saved shell prompt to return to original state
	process.stdout.write(last_pty_line);

	// Query its new column
	setTimeout(() => {
		queryCursorPosition();
	}, 100);
}

function executeCommandInPty(cmd) {
	return new Promise(resolve => {
		state = state_ai_command;
		command_output_buffer = '';

		// Write command to PTY
		pty_process.write(cmd + '\r');

		last_pty_data_time = Date.now();

		command_check_interval = setInterval(() => {
			if (isShellInForeground()) {
				const idle_time = Date.now() - last_pty_data_time;
				if (idle_time >= 75) {
					// Ensure shell has finished printing prompt
					clearInterval(command_check_interval);

					// Clear prompt line from terminal screen
					process.stdout.write('\r\x1b[K');

					// Clean command output buffer
					const clean_output = getCleanCommandOutput(command_output_buffer, cmd, last_pty_line);
					resolve(clean_output);
				}
			}
		}, 50);
	});
}

function getCleanCommandOutput(buffer, command, prompt) {
	// Strip ANSI escape codes
	const clean_buffer = stripAnsi(buffer);
	const clean_prompt = stripAnsi(prompt);

	const lines = clean_buffer.split(/\r?\n/);

	// Remove the echoed command at the start
	if (lines.length > 0) {
		lines.shift();
	}

	let output = lines.join('\n');

	// Remove trailing prompt
	if (clean_prompt && output.endsWith(clean_prompt)) {
		output = output.substring(0, output.length - clean_prompt.length);
	}

	return output.trim();
}
