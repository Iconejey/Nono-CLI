export function convertToOpenAIMessages(history, system_instruction) {
	const messages = [];
	if (system_instruction) {
		messages.push({
			role: 'system',
			content: system_instruction
		});
	}

	const toolCallIdsByModelAndName = {};

	if (Array.isArray(history)) {
		for (const msg of history) {
			if (!msg) continue;
			if (msg.parts && Array.isArray(msg.parts)) {
				const role = msg.role === 'model' ? 'assistant' : msg.role || 'user';
				let text = '';
				const tool_calls = [];
				const tool_messages = [];

				for (const part of msg.parts) {
					if (part.text) text += part.text;
					if (part.functionCall) {
						const name = part.functionCall.name;
						const id = part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`;
						toolCallIdsByModelAndName[name] = id;
						tool_calls.push({
							id: id,
							type: 'function',
							function: {
								name: name,
								arguments: JSON.stringify(part.functionCall.args)
							}
						});
					}
					if (part.functionResponse) {
						const name = part.functionResponse.name;
						const id = part.functionResponse.id || toolCallIdsByModelAndName[name] || `call_${name}`;
						tool_messages.push({
							role: 'tool',
							tool_call_id: id,
							name: name,
							content: JSON.stringify(part.functionResponse.response)
						});
					}
				}

				if (tool_messages.length > 0) {
					for (const tool_msg of tool_messages) messages.push(tool_msg);
				} else {
					const oai_msg = { role };
					if (text) oai_msg.content = text;
					if (tool_calls.length > 0) oai_msg.tool_calls = tool_calls;
					messages.push(oai_msg);
				}
			} else {
				// Already standard OpenAI format
				messages.push(msg);
			}
		}
	}
	return messages;
}

export function cleanModelText(text) {
	if (!text) return '';
	let cleaned = text;

	if (cleaned.includes('</think>')) {
		const index = cleaned.indexOf('</think>');
		cleaned = cleaned.substring(index + 8);
	}
	cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
	cleaned = cleaned.replace(/<think>[\s\S]*/gi, '');

	// Strip dangling tool-calling tags
	cleaned = cleaned.replace(/<\/?(tool_call|function|parameter)(=[a-zA-Z0-9_-]+)?>/gi, '');

	return cleaned.trim();
}

export function parseTextToolCalls(text) {
	const tool_calls = [];
	if (!text) return tool_calls;

	const tool_call_regex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
	let match;
	while ((match = tool_call_regex.exec(text)) !== null) {
		const content = match[1].trim();

		if (content.startsWith('{')) {
			try {
				const parsed = JSON.parse(content);
				if (parsed.name) {
					tool_calls.push({
						name: parsed.name,
						args: parsed.arguments || parsed.args || {},
						id: `call_${Math.random().toString(36).substring(2, 11)}`
					});
					continue;
				}
			} catch (e) {
				// silent
			}
		}

		const function_regex = /<function=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/function>/i;
		const func_match = content.match(function_regex);
		if (func_match) {
			const name = func_match[1];
			const inner = func_match[2];
			const args = {};

			const param_regex = /<parameter=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/parameter>/gi;
			let param_match;
			while ((param_match = param_regex.exec(inner)) !== null) {
				const param_name = param_match[1];
				const param_val = param_match[2].trim();
				if (param_val === 'true') args[param_name] = true;
				else if (param_val === 'false') args[param_name] = false;
				else if (!isNaN(param_val) && param_val !== '') args[param_name] = Number(param_val);
				else if ((param_val.startsWith('"') && param_val.endsWith('"')) || (param_val.startsWith("'") && param_val.endsWith("'"))) args[param_name] = param_val.slice(1, -1);
				else args[param_name] = param_val;
			}

			tool_calls.push({
				name: name,
				args: args,
				id: `call_${Math.random().toString(36).substring(2, 11)}`
			});
		}
	}

	return tool_calls;
}

export function convertToGeminiResponse(choice) {
	return choice.message;
}

export function convertGeminiToolsToOpenAI(tools) {
	function lowercaseTypes(obj) {
		if (Array.isArray(obj)) return obj.map(lowercaseTypes);
		if (obj !== null && typeof obj === 'object') {
			const res = {};
			for (const key of Object.keys(obj)) {
				if (key === 'type' && typeof obj[key] === 'string') {
					res[key] = obj[key].toLowerCase();
				} else {
					res[key] = lowercaseTypes(obj[key]);
				}
			}
			return res;
		}
		return obj;
	}

	return tools.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters ? lowercaseTypes(t.parameters) : undefined
		}
	}));
}

export function pruneHistory(history) {
	if (!Array.isArray(history)) return history;

	for (let i = 0; i < history.length; i++) {
		const msg = history[i];
		if (msg && msg.role === 'tool' && typeof msg.content === 'string') {
			let response;
			try {
				response = JSON.parse(msg.content);
			} catch (e) {
				continue;
			}

			if (response && typeof response === 'object') {
				let modified = false;
				const tool_name = msg.name;

				// Truncate view_file_contents
				if (tool_name === 'view_file_contents' && typeof response.content === 'string') {
					if (response.content.length > 1000) {
						response.content = response.content.slice(0, 1000) + '\n[... Content truncated in history pruning ...]';
						response.is_truncated = true;
						modified = true;
					}
				}
				// Truncate search_grep
				if (tool_name === 'search_grep' && typeof response.matches === 'string') {
					if (response.matches.length > 1000) {
						response.matches = response.matches.slice(0, 1000) + '\n[... Matches truncated in history pruning ...]';
						response.is_truncated = true;
						modified = true;
					}
				}
				// Truncate execute_system_command
				if (tool_name === 'execute_system_command') {
					if (typeof response.stdout === 'string' && response.stdout.length > 1000) {
						response.stdout = response.stdout.slice(0, 1000) + '\n[... stdout truncated in history pruning ...]';
						response.stdout_truncated = true;
						modified = true;
					}
					if (typeof response.stderr === 'string' && response.stderr.length > 1000) {
						response.stderr = response.stderr.slice(0, 1000) + '\n[... stderr truncated in history pruning ...]';
						response.stderr_truncated = true;
						modified = true;
					}
				}
				// Truncate run_node_script
				if (tool_name === 'run_node_script') {
					if (typeof response.stdout === 'string' && response.stdout.length > 1000) {
						response.stdout = response.stdout.slice(0, 1000) + '\n[... stdout truncated in history pruning ...]';
						response.stdout_truncated = true;
						modified = true;
					}
					if (typeof response.stderr === 'string' && response.stderr.length > 1000) {
						response.stderr = response.stderr.slice(0, 1000) + '\n[... stderr truncated in history pruning ...]';
						response.stderr_truncated = true;
						modified = true;
					}
				}
				// Truncate view_file_git_diff
				if (tool_name === 'view_file_git_diff' && typeof response.diff === 'string') {
					if (response.diff.length > 1000) {
						response.diff = response.diff.slice(0, 1000) + '\n[... Diff truncated in history pruning ...]';
						response.is_truncated = true;
						modified = true;
					}
				}

				if (modified) {
					msg.content = JSON.stringify(response);
				}
			}
		}
	}
	return history;
}

export function sanitizeHistory(history) {
	if (!Array.isArray(history)) return [];
	return history.filter(Boolean).map(msg => {
		if (typeof msg !== 'object') return msg;
		if (!msg.role) {
			msg.role = msg.tool_call_id ? 'tool' : 'user';
		}
		if (msg.role === 'model') {
			msg.role = 'assistant';
		}
		return msg;
	});
}
