import { getCustomTheme } from './theme.js';
import { processInlineStyles, formatTable } from './terminal.js';

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

export function extractJsonBlock(text) {
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

	return null;
}

export async function formatCodeWithPrettier(code, lang) {
	if (!lang) return code;
	const parser = languageToParser[lang.toLowerCase()];
	if (!parser) {
		return code;
	}
	try {
		const config = (await prettier.resolveConfig(process.cwd())) || {};
		const formatted = await prettier.format(code, {
			...config,
			tabWidth: 4,
			useTabs: false,
			parser
		});
		return formatted.trimEnd();
	} catch (e) {
		return code;
	}
}

export async function formatMarkdownForTerminal(md, options = {}) {
	if (!md) return '';
	const cliHighlight = (await import('cli-highlight')).default;
	const custom_theme = await getCustomTheme();
	const is_gray = options?.color === 'gray' || options?.gray;
	const resetStyle = is_gray ? '\x1b[0m\x1b[90m' : '\x1b[0m';
	const base_color = is_gray ? '\x1b[90m' : '';
	const header_color = is_gray ? '\x1b[1;90m' : (options?.header_color ?? '\x1b[1;35m');

	try {
		md = await formatCodeWithPrettier(md, 'markdown');
	} catch (e) {
		// fallback
	}
	const lines = md.split('\n');
	const formatted_lines = [];
	let in_code_block = false;
	let code_block_lines = [];
	let code_block_lang = '';
	let table_lines = [];

	const flushTable = () => {
		if (table_lines.length > 0) {
			const formatted_table = formatTable(table_lines, resetStyle);
			for (const t_line of formatted_table) {
				if (is_gray) {
					formatted_lines.push(`\x1b[90m${t_line}\x1b[0m`);
				} else {
					formatted_lines.push(t_line);
				}
			}
			table_lines = [];
		}
	};

	for (let line of lines) {
		const is_table_line = line.trim().startsWith('|') && line.trim().endsWith('|');

		if (is_table_line && !in_code_block) {
			table_lines.push(line);
			continue;
		}

		flushTable();

		// Handle Code Block delimiters
		if (line.trim().startsWith('```')) {
			if (!in_code_block) {
				in_code_block = true;
				code_block_lang = line.trim().slice(3).trim();
				code_block_lines = [];
			} else {
				in_code_block = false;
				const code_text = code_block_lines.join('\n');
				const is_highlighted = !is_gray && code_block_lang && cliHighlight.supportsLanguage(code_block_lang);
				let highlighted_text = code_text;
				if (is_highlighted) {
					try {
						const formatted_code = await formatCodeWithPrettier(code_text, code_block_lang);
						highlighted_text = cliHighlight.highlight(formatted_code, {
							language: code_block_lang,
							ignoreIllegals: true,
							theme: custom_theme
						});
					} catch (e) {
						// fallback
					}
				}
				const highlighted_lines = highlighted_text.split('\n');
				for (const h_line of highlighted_lines) {
					if (is_highlighted) {
						formatted_lines.push(`  \x1b[90m│\x1b[0m  ${h_line}`);
					} else {
						const code_line_color = is_gray ? '\x1b[90m' : '\x1b[37m';
						formatted_lines.push(`  \x1b[90m│\x1b[0m  ${code_line_color}${h_line}\x1b[0m`);
					}
				}
			}
			continue;
		}

		if (in_code_block) {
			code_block_lines.push(line);
			continue;
		}

		// Handle Headers
		if (line.startsWith('#')) {
			const hash_match = line.match(/^(#+)\s*(.*)/);
			if (hash_match) {
				const depth = hash_match[1].length;
				const title = hash_match[2];
				const styled_title = processInlineStyles(title, resetStyle);
				formatted_lines.push(`\n${header_color}${styled_title}\x1b[0m`);
				continue;
			}
		}

		// Handle standard lists & text lines
		let processed = processInlineStyles(line, resetStyle);
		if (is_gray) {
			formatted_lines.push(`${base_color}${processed}\x1b[0m`);
		} else {
			formatted_lines.push(processed);
		}
	}

	flushTable();

	return formatted_lines.join('\n');
}

export async function highlightRawMarkdown(md) {
	if (!md) return '';
	const cliHighlight = (await import('cli-highlight')).default;
	const custom_theme = await getCustomTheme();
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
				output_lines.push(
					cliHighlight
						.highlight(line, {
							language: 'markdown',
							ignoreIllegals: true,
							theme: custom_theme
						})
						.trimEnd()
				);
			} else {
				in_code_block = false;
				const code_text = code_block_lines.join('\n');
				const is_highlighted = code_block_lang && cliHighlight.supportsLanguage(code_block_lang);
				let highlighted_text = code_text;
				if (is_highlighted) {
					try {
						const formatted_code = await formatCodeWithPrettier(code_text, code_block_lang);
						highlighted_text = cliHighlight.highlight(formatted_code, {
							language: code_block_lang,
							ignoreIllegals: true,
							theme: custom_theme
						});
					} catch (e) {
						// fallback
					}
				}
				output_lines.push(highlighted_text.trimEnd());
				// Highlight the code block closing tag as markdown
				output_lines.push(
					cliHighlight
						.highlight(line, {
							language: 'markdown',
							ignoreIllegals: true,
							theme: custom_theme
						})
						.trimEnd()
				);
			}
			continue;
		}

		if (in_code_block) {
			code_block_lines.push(line);
		} else {
			// Highlight standard markdown line
			output_lines.push(
				cliHighlight
					.highlight(line, {
						language: 'markdown',
						ignoreIllegals: true,
						theme: custom_theme
					})
					.trimEnd()
			);
		}
	}
	return output_lines.join('\n');
}
