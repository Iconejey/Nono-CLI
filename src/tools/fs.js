import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { formatWithPrettier, getLineDiff, getFileDiffText } from './format_diff.js';
import { runNodeSyntaxCheck } from './execution.js';
import { runProjectDryRun } from '../utils/system.js';
import { formatProgressLine } from '../utils/terminal.js';

function updateProgress(raw_text, color) {
	const line = formatProgressLine(raw_text, color);
	console.log(line);
}

export function listDirectoryStructure({ directory_path, depth = 2 }) {
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

export function viewFileContents({ file_path, start_line, end_line }) {
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

export function writeFile({ file_path, content }) {
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
	const node_check = runNodeSyntaxCheck(abs_path);
	return {
		file_path,
		status: 'success',
		diff: diff_text,
		...(node_check ? { node_check } : {}),
		...lint_result
	};
}

export function patchFile({ file_path, search_block, replace_block }) {
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
	const node_check = runNodeSyntaxCheck(abs_path);
	return {
		file_path,
		status: 'success',
		diff: diff_text,
		...(node_check ? { node_check } : {}),
		...lint_result
	};
}

export function searchGrep({ pattern, directory_path }) {
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
