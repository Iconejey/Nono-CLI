import fs from 'fs';
import path from 'path';
import os from 'os';
import cliHighlight from 'cli-highlight';
import { writeDetails } from './logger.js';

export function loadCustomTheme() {
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

export const custom_theme = loadCustomTheme();
