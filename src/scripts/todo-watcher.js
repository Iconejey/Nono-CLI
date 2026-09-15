import fs from 'fs';
import path from 'path';
import { formatMarkdownForTerminal, formatTodoListToMarkdown } from '../utils/markdown.js';

const todo_path = process.argv[2];

if (!todo_path) {
	console.error('Error: Please provide the path to the todo JSON file.');
	process.exit(1);
}

let last_content = '';
try {
	if (fs.existsSync(todo_path)) {
		last_content = fs.readFileSync(todo_path, 'utf8');
	}
} catch (e) {}

async function render() {
	// Clear screen and reset scrollback
	process.stdout.write('\x1bc');

	if (!fs.existsSync(todo_path)) {
		console.log('\x1b[35m✦ Nono Active TODO List ✦\x1b[0m\n');
		console.log('No active TODO list found yet for this session. Waiting for tasks...');
		return;
	}

	try {
		const raw = fs.readFileSync(todo_path, 'utf8');
		const todos = JSON.parse(raw);

		if (todos.length === 0) {
			console.log('\x1b[35m✦ Nono Active TODO List ✦\x1b[0m\n');
			console.log('All tasks completed or TODO list is empty!');
			return;
		}

		let md = `# ✦ Nono Active TODO List ✦\n\n`;
		md += `Keep track of your overall progress. This view updates in real-time as Nono updates the tasks.\n\n`;

		md += formatTodoListToMarkdown(todos, false) + '\n';

		const formatted = await formatMarkdownForTerminal(md);
		console.log(formatted);
	} catch (e) {
		console.log('\x1b[35m✦ Nono Active TODO List ✦\x1b[0m\n');
		console.log('Error reading or parsing TODO list:', e.message);
	}
}

// Initial render
render();

// Watch the file for changes
let debounceTimer;
try {
	fs.watch(todo_path, eventType => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			try {
				if (fs.existsSync(todo_path)) {
					const current_content = fs.readFileSync(todo_path, 'utf8');
					if (current_content !== last_content) {
						last_content = current_content;
						render();
					}
				}
			} catch (e) {}
		}, 100);
	});
} catch (err) {
	// fs.watch might fail if the file doesn't exist yet, we'll rely on poll fallback
}

// Poll fallback for stability (handles recreated files / non-existent startup files)
setInterval(() => {
	try {
		if (fs.existsSync(todo_path)) {
			const current_content = fs.readFileSync(todo_path, 'utf8');
			if (current_content !== last_content) {
				last_content = current_content;
				render();
			}
		} else if (last_content !== '') {
			last_content = '';
			render();
		}
	} catch (e) {}
}, 500);
