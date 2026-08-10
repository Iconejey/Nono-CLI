import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import * as Diff from 'diff';

export const IGNORED_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'];

export function isIgnoredFile(filepath) {
	return IGNORED_FILES.some(ignored => filepath.endsWith(ignored));
}

export function getPrettierFlagsFromVSCode() {
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
			'prettier.jsxSingleQuote': val => (val ? '--jsx-single-quote' : '--no-jsx-single-quote'),
			'prettier.bracketSpacing': val => (val ? '--bracket-spacing' : '--no-bracket-spacing'),
			'prettier.bracketSameLine': val => (val ? '--bracket-same-line' : '--no-bracket-same-line'),
			'prettier.proseWrap': val => `--prose-wrap ${val}`
		};

		for (const [key, format_func] of Object.entries(config_mapping)) {
			if (settings[key] !== undefined) {
				flags.push(format_func(settings[key]));
			}
		}
		return flags.join(' ');
	} catch (e) {
		return '';
	}
}

export function hasProjectPrettierConfig(file_path) {
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

export function formatWithPrettier(file_path) {
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

export function getLineDiff(oldStr, newStr) {
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

			if (stdout && stdout.trim()) {
				const parts = stdout.trim().split(/\s+/);
				if (parts.length >= 2) {
					return {
						deleted: parseInt(parts[0], 10) || 0,
						added: parseInt(parts[1], 10) || 0
					};
				}
			}
		} catch (err) {
			try {
				fs.unlinkSync(oldTempPath);
			} catch (e) {}
			try {
				fs.unlinkSync(newTempPath);
			} catch (e) {}
		}
	} catch (e) {}

	// Fallback pure JS line diff if git diff fails or is unavailable
	const oldLines = oldStr.split(/\r?\n/);
	const newLines = newStr.split(/\r?\n/);
	const oldSet = new Set(oldLines);
	const newSet = new Set(newLines);

	let deleted = 0;
	let added = 0;

	for (const line of oldLines) {
		if (!newSet.has(line)) deleted++;
	}
	for (const line of newLines) {
		if (!oldSet.has(line)) added++;
	}

	return { deleted, added };
}

export function getFileDiffText(oldStr, newStr, file_path) {
	return Diff.createPatch(file_path, oldStr || '', newStr || '', '', '', {
		context: 3
	});
}

export function viewFileGitDiff({ base_branch, file_path }) {
	if (file_path && isIgnoredFile(file_path)) {
		return Promise.resolve({
			status: 'success',
			diff: '(Diff ignored for lockfile)'
		});
	}
	return new Promise(resolve => {
		const cmd = file_path ? `git diff origin/${base_branch}...HEAD -- ${JSON.stringify(file_path)}` : `git diff origin/${base_branch}...HEAD -- . ':!*package-lock.json' ':!*yarn.lock' ':!*pnpm-lock.yaml' ':!*Cargo.lock' ':!*go.sum'`;
		exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
			if (error && error.code !== 1) {
				resolve({ status: 'error', error: stderr || error.message });
			} else {
				resolve({
					status: 'success',
					diff: (stdout || '').trim() || 'No differences.'
				});
			}
		});
	});
}
