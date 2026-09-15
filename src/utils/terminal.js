import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync, spawn } from 'child_process';
import { verbose, thought_limit } from '../../index.js';

export function formatK(val) {
	const k_val = val / 1000;
	if (k_val % 1 === 0) return k_val.toFixed(0) + 'K';
	return k_val.toFixed(1) + 'K';
}

export function stripAnsi(str) {
	if (typeof str !== 'string') return str;
	return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export function getPRNameFromPPID(ppid) {
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

export function formatElapsedTime(seconds) {
	if (seconds >= 60) {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		return `${m}m ${s}s`;
	}
	return `${seconds}s`;
}

export function formatProgressLine(text, color) {
	let ansi_prefix = '\x1b[90m'; // Default gray
	if (color === 'red') {
		ansi_prefix = '\x1b[31m'; // Red
	} else if (verbose && (text.trim().startsWith('•') || text.trim().startsWith('✦'))) {
		ansi_prefix = '\x1b[36m'; // Cyan
	}
	const ansi_suffix = '\x1b[0m';

	let raw = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	return `${ansi_prefix}${raw}${ansi_suffix}`;
}

function getTodoTitle(id) {
	try {
		const todo_dir = path.join(os.homedir(), '.cache', 'nono', 'todo');
		const files = [`todo-pr-${process.ppid}.json`, `todo-${process.ppid}.json`];
		for (const file of files) {
			const filepath = path.join(todo_dir, file);
			if (fs.existsSync(filepath)) {
				const todos = JSON.parse(fs.readFileSync(filepath, 'utf8'));
				const item = todos.find(t => String(t.id) === String(id));
				if (item) return item.task;
			}
		}
	} catch (e) {
		// Ignore
	}
	return `task ID ${id}`;
}

export function formatToolCallProgress(name, args) {
	const basename = args.file_path ? path.basename(args.file_path) : '';

	switch (name) {
		case 'add_todo_item': {
			return `Added "${args.task}" to todo list`;
		}
		case 'update_todo_item': {
			const title = getTodoTitle(args.id);
			return `Marked "${title}" as ${args.status}`;
		}
		case 'remove_todo_item': {
			const title = getTodoTitle(args.id);
			return `Removed "${title}" from todo list`;
		}
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
		case 'run_node_script': {
			const first_line = (args.code || '').split('\n')[0].trim();
			const snippet = first_line.length > 50 ? first_line.slice(0, 47) + '...' : first_line;
			return `Running Node script: "${snippet}"`;
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
		case 'gemini_web_search': {
			return `Searching the web for "${args.query}"`;
		}
		case 'discard_specific_output': {
			return `Discarding output for "${args.target}"`;
		}
		case 'discard_last_steps': {
			return `Discarding the last ${args.steps_count} steps`;
		}
		default: {
			const arg_vals = Object.values(args)
				.map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
				.join(' ');
			return arg_vals ? `${name} ${arg_vals}` : name;
		}
	}
}

export function processInlineStyles(line, resetStyle = '\x1b[0m') {
	const is_gray = resetStyle.includes('90m');
	const backtick_style = is_gray ? '\x1b[90m' : '\x1b[36m';
	const bold_style = is_gray ? '\x1b[1;90m' : '\x1b[1m';
	const italic_style = is_gray ? '\x1b[4;90m' : '\x1b[4m';

	line = line.replace(/`([^`]+)`/g, `${backtick_style}$1${resetStyle}`);
	line = line.replace(/\*\*([^*]+)\*\*/g, `${bold_style}$1${resetStyle}`);
	line = line.replace(/\*([^*]+)\*/g, `${italic_style}$1${resetStyle}`);
	return line.replace(/(?:^|(?<=\W))_([^_]+)_(?=\W|$)/g, `${italic_style}$1${resetStyle}`);
}

export function formatTable(table_lines, resetStyle = '\x1b[0m') {
	if (table_lines.length < 2) return table_lines;

	const first_line = table_lines[0];
	const indent_match = first_line.match(/^\s*/);
	const indent = indent_match ? indent_match[0] : '';

	const parseRowCells = line => {
		const trimmed = line.trim();
		const parts = trimmed.split(/(?<!\\)\|/);
		return parts.slice(1, parts.length - 1).map(c => c.trim().replace(/\\\|/g, '|'));
	};

	const rows = [];
	for (let i = 0; i < table_lines.length; i++) {
		if (i === 1) continue;
		const cells = parseRowCells(table_lines[i]);
		const processed_cells = cells.map(c => processInlineStyles(c, resetStyle));
		rows.push({
			index: i,
			processed: processed_cells
		});
	}

	if (rows.length === 0) return table_lines;
	const num_cols = rows[0].processed.length;
	if (num_cols === 0) return table_lines;

	const stripAnsiLocal = str => str.replace(/\x1b\[[0-9;]*m/g, '');

	const col_widths = [];
	for (let col_idx = 0; col_idx < num_cols; col_idx++) {
		let max_w = 0;
		for (const row of rows) {
			const cell = row.processed[col_idx] || '';
			const visual_len = stripAnsiLocal(cell).length;
			if (visual_len > max_w) {
				max_w = visual_len;
			}
		}
		col_widths.push(max_w);
	}

	const top_border = indent + '┌' + col_widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
	const separator_row = indent + '├' + col_widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
	const bottom_border = indent + '└' + col_widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

	const formatRow = processed_cells => {
		let result = '│';
		for (let j = 0; j < num_cols; j++) {
			const cell = processed_cells[j] || '';
			const visual_len = stripAnsiLocal(cell).length;
			const padding_len = col_widths[j] - visual_len;
			result += ' ' + cell + ' '.repeat(padding_len) + ' │';
		}
		return indent + result;
	};

	const formatted = [];
	formatted.push(top_border);
	formatted.push(formatRow(rows[0].processed));
	formatted.push(separator_row);

	for (let i = 1; i < rows.length; i++) {
		formatted.push(formatRow(rows[i].processed));
	}

	formatted.push(bottom_border);
	return formatted;
}

export function spawnInNewTerminalTab(title, executable, args = []) {
	const is_kitty = process.env.TERM === 'xterm-kitty' || !!process.env.KITTY_PID || !!process.env.KITTY_WINDOW_ID;
	const is_ptyxis = !!process.env.PTYXIS_VERSION || !!process.env.PTYXIS_PROFILE;

	const term_cmds = [
		// 1. Ptyxis (GNOME's default terminal - new tab)
		{
			check: () => is_ptyxis,
			cmd: 'ptyxis',
			args: ['--tab', '-T', title, '--', executable, ...args],
			nonBlocking: true
		},
		// 2. Kitty (Remote Control - new tab)
		{
			check: () => is_kitty,
			cmd: 'kitty',
			args: ['@', 'launch', '--type=tab', '--tab-title', title, executable, ...args],
			nonBlocking: true
		},
		// 3. Kitty (Direct - new window)
		{
			cmd: 'kitty',
			args: ['--title', title, executable, ...args],
			nonBlocking: false
		},
		// 4. Ptyxis fallback
		{
			cmd: 'ptyxis',
			args: ['--tab', '-T', title, '--', executable, ...args],
			nonBlocking: true
		},
		// 5. GNOME Terminal
		{
			cmd: 'gnome-terminal',
			args: ['--tab', `--title=${title}`, '--', executable, ...args],
			nonBlocking: true
		},
		// 6. GNOME Console (kgx)
		{
			cmd: 'kgx',
			args: ['--tab', '--', executable, ...args],
			nonBlocking: true
		},
		// 7. Konsole
		{
			cmd: 'konsole',
			args: ['--new-tab', '-e', executable, ...args],
			nonBlocking: true
		},
		// 8. XFCE Terminal
		{
			cmd: 'xfce4-terminal',
			args: ['--tab', '-x', executable, ...args],
			nonBlocking: true
		}
	];

	function tryTerminals(index) {
		if (index >= term_cmds.length) {
			console.log(`No supported terminal emulator succeeded. Spawning program in the current terminal window...`);
			const child = spawn(executable, args, { stdio: 'inherit' });
			child.on('error', err => {
				console.error(`Error starting program:`, err.message);
				process.exit(1);
			});
			child.on('exit', () => process.exit(0));
			return;
		}

		const term = term_cmds[index];
		if (term.check && !term.check()) {
			tryTerminals(index + 1);
			return;
		}

		try {
			execSync(`which ${term.cmd}`, { stdio: 'ignore' });
			const formattedArgs = term.args.map(arg => JSON.stringify(arg)).join(' ');
			const full_cmd = `${term.cmd} ${formattedArgs}`;

			if (term.nonBlocking) {
				execSync(full_cmd, { stdio: 'ignore' });
				process.exit(0);
			} else {
				exec(full_cmd, err => {
					if (err) {
						tryTerminals(index + 1);
					}
				});
				setTimeout(() => process.exit(0), 200);
			}
		} catch (e) {
			tryTerminals(index + 1);
		}
	}

	tryTerminals(0);
}
