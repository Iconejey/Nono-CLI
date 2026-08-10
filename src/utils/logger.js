import fs from 'fs';
import path from 'path';
import os from 'os';

let details_path = '';

export function getDetailsPath() {
	return details_path;
}

export function setDetailsPath(val) {
	details_path = val;
}

export function writeDetails(text) {
	if (details_path) {
		fs.appendFileSync(details_path, text + '\n', 'utf8');
	}
}

export function logTokenUsage(model, usageMetadata, prompt) {
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
