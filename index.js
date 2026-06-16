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
let running_user_command = false;
let user_command_start_time = 0;

// Config and Models
let config = loadConfig();
let current_model_index = 0;

// Terminal History and Prompt Tracking
const history_manager = new HistoryManager(200);
let last_pty_line = '';
let prompt_start_column = null;

// AI Input state
let ai_input = '';
let cursor_index = 0;
let prev_rows = 1;
let current_abort_controller = null;
let waiting_for_cursor_check = false;
let cursor_check_buffer = '';
const all_commands = [
	{ name: 'clear', description: 'Clear terminal command outputs from history context' },
	{ name: 'context', description: 'Log the full terminal history context (in purple)' },
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

	// Process history append
	if (state === state_terminal) {
		if (running_user_command) {
			const elapsed = Date.now() - user_command_start_time;
			if (isShellInForeground() && elapsed > 150) {
				// The command has finished and the shell printed the prompt.
				// We split the data to separate command output from the new prompt.
				const parts = data.split(/\r?\n/);
				if (parts.length > 1) {
					// All parts except the last one are command outputs
					const output_data = parts.slice(0, -1).join('\n') + '\n';
					history_manager.append(output_data, 'output');

					// The last part is the prompt
					running_user_command = false;
					history_manager.append(parts[parts.length - 1], 'command');
				} else {
					// Only one part, so it must be the prompt (or command finished without output)
					running_user_command = false;
					history_manager.append(data, 'command');
				}
			} else {
				// Command is still running, all data is output
				history_manager.append(data, 'output');
			}
		} else {
			// Not running a command (user is typing at prompt), all data is command/prompt
			history_manager.append(data, 'command');
		}
	} else {
		// In AI states
		let type = 'output';
		if (state === state_ai_command) {
			type = 'output';
		}
		history_manager.append(data, type);
	}

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
			if (str === '\r' || str === '\n') {
				running_user_command = true;
				user_command_start_time = Date.now();
			}
			pty_process.write(data);
		}
	} else if (state === state_ai_input) {
		handleAiInputKey(str);
	} else if (state === state_ai_running) {
		if (str === '\x1b') {
			if (current_abort_controller) {
				current_abort_controller.abort();
			}
		}
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
	cursor_index = 0;
	prev_rows = 1;
	renderAiPrompt();
}

function exitAiMode() {
	state = state_terminal;
	// Clear prompt and suggestions by moving up to top line first
	if (prev_rows > 1) {
		process.stdout.write(`\x1b[${prev_rows - 1}A`);
	}
	process.stdout.write('\r\x1b[J');
	ai_input = '';
	cursor_index = 0;
	prev_rows = 1;
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

	// Title prompt length (ANSI codes stripped for length calculation)
	const title_prompt = `${model.title}> `;
	const P = title_prompt.length;

	// Total text
	const text = title_prompt + ai_input;
	const W = process.stdout.columns || 80;
	const L = text.length;
	const new_rows = Math.floor(L / W) + 1;

	// 1. Move cursor up to the first line of the previous prompt
	if (prev_rows > 1) {
		process.stdout.write(`\x1b[${prev_rows - 1}A`);
	}
	process.stdout.write('\r');

	// 2. Clear screen from cursor down to erase previous prompt and suggestions
	process.stdout.write('\x1b[J');

	// 3. Print the prompt prefix and ai_input
	process.stdout.write(`\x1b[1m\x1b[35m${model.title}>\x1b[0m ${ai_input}`);

	// Save current rows
	prev_rows = new_rows;

	// 4. Handle suggestions if active
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

		// Save cursor position at the end of the prompt text
		process.stdout.write(`\x1b[s`);

		// Print suggestions below
		for (let i = 0; i < suggestions.length; i++) {
			const sug = suggestions[i];
			const is_selected = i === current_suggestion_index;
			const prefix = is_selected ? '\x1b[1;32m > \x1b[0m' : '   ';
			const desc = `\x1b[2m${sug.description}\x1b[0m`;
			process.stdout.write(`\n\r${prefix}/${sug.name} - ${desc}`);
		}

		// Restore cursor position to the end of the prompt text
		process.stdout.write(`\x1b[u`);
	}

	// 5. Position terminal cursor at the active cursor_index
	const target_pos = P + cursor_index;
	const target_row = Math.floor(target_pos / W);
	const target_col = target_pos % W;

	const current_row = new_rows - 1;

	// Move up from bottom row to top row of the prompt
	if (current_row > 0) {
		process.stdout.write(`\x1b[${current_row}A`);
	}
	process.stdout.write('\r');

	// Move down and right to the target cursor position
	if (target_row > 0) {
		process.stdout.write(`\x1b[${target_row}B`);
	}
	if (target_col > 0) {
		process.stdout.write(`\x1b[${target_col}C`);
	}
}

function reloadNono() {
	try {
		config = loadConfig();
		history_manager.clear();
		// Move up to the start of the prompt and clear down to erase suggestions/prompt
		if (prev_rows > 1) {
			process.stdout.write(`\x1b[${prev_rows - 1}A`);
		}
		process.stdout.write('\r\x1b[J');

		// Print reload message
		process.stdout.write(`\n\x1b[32m[Nono config reloaded]\x1b[0m\n`);

		// Reset index if out of bounds
		if (config.length > 0 && current_model_index >= config.length) {
			current_model_index = 0;
		}
		// Reset height tracker since we just cleared the screen
		prev_rows = 1;
		renderAiPrompt();
	} catch (e) {
		history_manager.clear();
		if (prev_rows > 1) {
			process.stdout.write(`\x1b[${prev_rows - 1}A`);
		}
		process.stdout.write('\r\x1b[J');
		process.stdout.write(`\n\x1b[31m[Error reloading config: ${e.message}]\x1b[0m\n`);
		prev_rows = 1;
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

	// Handle left/right cursor arrow keys
	if (str === '\x1b[D' || str === '\x1bOD') {
		// Left Arrow
		if (cursor_index > 0) {
			cursor_index--;
			renderAiPrompt();
		}
		return;
	}
	if (str === '\x1b[C' || str === '\x1bOC') {
		// Right Arrow
		if (cursor_index < ai_input.length) {
			cursor_index++;
			renderAiPrompt();
		}
		return;
	}

	if (str === '\x1b') {
		// Escape
		if (ai_input.length > 0) {
			ai_input = '';
			cursor_index = 0;
			renderAiPrompt();
		} else {
			exitAiMode();
		}
		return;
	}

	const newline_idx = str.search(/[\r\n]/);
	if (newline_idx !== -1) {
		const prefix = str.slice(0, newline_idx);
		const printable_prefix = prefix.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
		if (printable_prefix.length > 0) {
			ai_input = ai_input.slice(0, cursor_index) + printable_prefix + ai_input.slice(cursor_index);
			cursor_index += printable_prefix.length;
		}

		if (is_suggesting && suggestions.length > 0 && current_suggestion_index >= 0) {
			const selected_sug = suggestions[current_suggestion_index];
			const selected_name = '/' + selected_sug.name;
			if (ai_input !== selected_name) {
				// Autocomplete the name
				ai_input = selected_name;
				cursor_index = ai_input.length;
				current_suggestion_index = 0;
				renderAiPrompt();
				return;
			}
		}

		// Execute exact matching slash commands
		if (ai_input === '/clear') {
			// Clear screen and move cursor to home (top-left)
			process.stdout.write('\x1b[2J\x1b[H');

			history_manager.clearCommandOutputs();
			const history = history_manager.getColoredHistory();
			if (history) {
				process.stdout.write(history + '\n');
			}

			ai_input = '';
			cursor_index = 0;
			prev_rows = 1;
			renderAiPrompt();
			return;
		}
		if (ai_input === '/context') {
			// Clear suggestions menu display
			process.stdout.write('\x1b[s\n\x1b[J\x1b[u');

			const history = history_manager.getCleanHistory();

			process.stdout.write(`\n\x1b[35m--- [Nono Terminal & Chat Context] ---\n${history}\n--------------------------------------\x1b[0m\n`);

			ai_input = '';
			cursor_index = 0;
			prev_rows = 1;
			renderAiPrompt();
			return;
		}
		if (ai_input === '/exit') {
			// Clear suggestions menu display
			process.stdout.write('\x1b[s\n\x1b[J\x1b[u');
			pty_process.kill();
			process.exit(0);
		}
		if (ai_input === '/restart') {
			ai_input = '';
			cursor_index = 0;
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
		// Backspace at cursor position
		if (cursor_index > 0) {
			ai_input = ai_input.slice(0, cursor_index - 1) + ai_input.slice(cursor_index);
			cursor_index--;
			renderAiPrompt();
		}
		return;
	}

	if (str === '<' && ai_input.length === 0) {
		loopModel();
		return;
	}

	if (str.startsWith('\x1b')) {
		// Ignore other escape sequences
		return;
	}

	// Handle printable text / paste
	const printable = str.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
	if (printable.length > 0) {
		ai_input = ai_input.slice(0, cursor_index) + printable + ai_input.slice(cursor_index);
		cursor_index += printable.length;
		renderAiPrompt();
	}
}

function prepareForAiSubmission() {
	if (!config || config.length === 0) return;
	const model = config[current_model_index];
	const P = `${model.title}> `.length;
	const L = P + ai_input.length;
	const W = process.stdout.columns || 80;
	const new_rows = Math.floor(L / W) + 1;

	// Render prompt leaves the cursor at target_row.
	// Move the cursor back to top row of the prompt, then move to bottom row of prompt
	const target_pos = P + cursor_index;
	const target_row = Math.floor(target_pos / W);

	if (target_row > 0) {
		process.stdout.write(`\x1b[${target_row}A`);
	}
	process.stdout.write('\r');

	const last_row = new_rows - 1;
	if (last_row > 0) {
		process.stdout.write(`\x1b[${last_row}B`);
	}

	// Clear any suggestions below it
	process.stdout.write(`\x1b[s\n\x1b[J\x1b[u`);
}

async function submitAiQuery() {
	prepareForAiSubmission();
	process.stdout.write('\n');
	state = state_ai_running;

	const model_config = getEffectiveModel(config[current_model_index]);

	// Append the user's query line to terminal history (replicates visual prompt on CLI)
	history_manager.append(`\n\x1b[1;35m${model_config.title}>\x1b[0m ${ai_input}\n`, 'chat');

	const current_messages = [
		{
			role: 'system',
			content: `
You are Nono, a fully autonomous AI coding agent running directly inside the user's terminal wrapper.
Your goal is to help the user with any task they request, including coding, debugging, refactoring, and general system administration.
You have full access to execute commands in the active terminal session using the run_command tool.

Guidelines for autonomous execution:
1. Act step-by-step. Break the user's request down into a logical plan.
2. You can inspect files and directories (using ls, cat, grep, find, etc.).
3. You can create, edit, or append to files using standard shell tools (e.g. cat << 'EOF' > filename, sed, echo, etc.).
4. Run tests, compilers, or linter commands (e.g. npm test, cargo check, python test.py) to verify your changes.
5. If a command fails or produces errors, analyze the output, correct the code/commands, and run them again. Iterate autonomously until the task is successfully accomplished.
6. Do not explain every little step to the user in intermediate text responses; prefer to execute commands to get the job done.
7. Once the task is fully completed and verified, summarize what was done and provide a concise final report.`
		},
		{
			role: 'user',
			content: `Here is the current terminal session history, showing both terminal commands and our AI conversation in chronological order:
---
${history_manager.getCleanHistory()}
---
Please continue the task or respond to the user.`
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

			current_abort_controller = new AbortController();

			// Debug log outgoing payload
			fs.appendFileSync('nono-debug.log', `\n=== CALL ===\n${JSON.stringify(current_messages, null, 2)}\n`);

			const response = await callModel(model_config, current_messages, tools, { signal: current_abort_controller.signal });

			// Clear current_abort_controller
			current_abort_controller = null;

			// Debug log response
			fs.appendFileSync('nono-debug.log', `=== RESPONSE ===\n${JSON.stringify(response, null, 2)}\n`);

			// Clear the "thinking..." indicator
			process.stdout.write('\r\x1b[K');

			if (response.thinking) {
				const W = process.stdout.columns || 80;
				const lines = response.thinking.split('\n');
				let total_rows = 0;
				for (const line of lines) {
					total_rows += Math.floor(line.length / W) + 1;
					process.stdout.write(`\x1b[90m${line}\x1b[0m\n`);
					await new Promise(r => setTimeout(r, 45)); // organic typing delay
				}
				await new Promise(r => setTimeout(r, 1200)); // allow reading
				if (total_rows > 0) {
					process.stdout.write(`\x1b[${total_rows}A\r\x1b[J`);
				}
			}

			// Append assistant's turn
			current_messages.push(response);

			if (response.tool_calls && response.tool_calls.length > 0) {
				// Execute tool call(s)
				const tool_call = response.tool_calls[0]; // Process first tool call
				if (tool_call.function.name === 'run_command') {
					const args = JSON.parse(tool_call.function.arguments);
					const cmd = args.command;

					// Print grey sparkle prefix (without a newline) so the PTY command echo appends to it
					process.stdout.write(`\x1b[90m✦\x1b[0m `);
					has_executed_command = true;

					// Execute command in PTY
					const output = await executeCommandInPty(cmd);
					state = state_ai_running;

					// Append tool result
					const tool_result = {
						role: 'tool',
						tool_call_id: tool_call.id,
						name: 'run_command',
						content: output
					};
					current_messages.push(tool_result);
				} else {
					// Unsupported tool
					const error_result = {
						role: 'tool',
						tool_call_id: tool_call.id,
						name: tool_call.function.name,
						content: `Error: Unsupported tool ${tool_call.function.name}`
					};
					current_messages.push(error_result);
				}
			} else {
				// No tool calls, AI is finished
				if (response.content) {
					// Append Nono's response to terminal history
					history_manager.append(`\x1b[35m✦\x1b[0m ${response.content}\n`, 'chat');
					// Print response in a distinct style (purple ✦ followed by response)
					process.stdout.write(`\x1b[35m✦\x1b[0m ${response.content}\n`);
				}
				break;
			}
		}
	} catch (error) {
		current_abort_controller = null;
		if (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('cancel')) {
			process.stdout.write(`\r\x1b[K\x1b[90m[Request cancelled]\x1b[0m\n`);
		} else {
			process.stdout.write(`\r\x1b[K\x1b[31mError: ${error.message}\x1b[0m\n`);
		}
	}

	// Stay in AI mode
	state = state_ai_input;
	ai_input = '';
	cursor_index = 0;
	prev_rows = 1;
	renderAiPrompt();
}

function executeCommandInPty(cmd) {
	return new Promise(resolve => {
		state = state_ai_command;
		command_output_buffer = '';

		// Prepend the sparkle prefix to the history manager so it's recorded chronologically before the command echo
		history_manager.append('\x1b[90m✦\x1b[0m ', 'command');

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
