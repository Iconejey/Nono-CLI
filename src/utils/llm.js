export function convertToOpenAIMessages(history, system_instruction) {
	const messages = [];
	if (system_instruction) {
		messages.push({
			role: 'system',
			content: system_instruction
		});
	}

	for (const msg of history) {
		if (!msg) continue;
		const role = msg.role === 'model' ? 'assistant' : 'user';
		const parts = msg.parts || [];
		let text = '';
		const tool_calls = [];
		const tool_messages = [];

		for (const part of parts) {
			if (part.text) text += part.text;
			if (part.functionCall) {
				tool_calls.push({
					id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`,
					type: 'function',
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args)
					}
				});
			}
			if (part.functionResponse) {
				tool_messages.push({
					role: 'tool',
					tool_call_id: part.functionResponse.id || `call_${part.functionResponse.name}`,
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
	const msg = choice.message;
	const parts = [];
	let text = msg.content || '';

	const text_tool_calls = parseTextToolCalls(text);
	text = cleanModelText(text);
	text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();

	if (text) parts.push({ text: text });

	for (const tc of text_tool_calls) {
		parts.push({
			functionCall: {
				name: tc.name,
				args: tc.args,
				id: tc.id
			}
		});
	}

	if (msg.tool_calls && msg.tool_calls.length > 0) {
		for (const tc of msg.tool_calls) {
			let args = {};
			try {
				args = JSON.parse(tc.function.arguments);
			} catch (e) {
				// silent
			}
			parts.push({
				functionCall: {
					name: tc.function.name,
					args: args,
					id: tc.id
				}
			});
		}
	}
	return {
		role: 'model',
		parts: parts
	};
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
	// We prune all messages except the very last one in history
	for (let i = 0; i < history.length - 1; i++) {
		const message = history[i];
		if (message && message.role === 'user' && Array.isArray(message.parts)) {
			for (const part of message.parts) {
				if (part && part.functionResponse && part.functionResponse.response) {
					const response = part.functionResponse.response;

					// Truncate view_file_contents
					if (part.functionResponse.name === 'view_file_contents' && typeof response.content === 'string') {
						if (response.content.length > 1000) {
							response.content = response.content.slice(0, 1000) + '\n[... Content truncated in history pruning ...]';
							response.is_truncated = true;
						}
					}
					// Truncate search_grep
					if (part.functionResponse.name === 'search_grep' && typeof response.matches === 'string') {
						if (response.matches.length > 1000) {
							response.matches = response.matches.slice(0, 1000) + '\n[... Matches truncated in history pruning ...]';
							response.is_truncated = true;
						}
					}
					// Truncate execute_system_command
					if (part.functionResponse.name === 'execute_system_command') {
						if (typeof response.stdout === 'string' && response.stdout.length > 1000) {
							response.stdout = response.stdout.slice(0, 1000) + '\n[... stdout truncated in history pruning ...]';
							response.stdout_truncated = true;
						}
						if (typeof response.stderr === 'string' && response.stderr.length > 1000) {
							response.stderr = response.stderr.slice(0, 1000) + '\n[... stderr truncated in history pruning ...]';
							response.stderr_truncated = true;
						}
					}
					// Truncate run_node_script
					if (part.functionResponse.name === 'run_node_script') {
						if (typeof response.stdout === 'string' && response.stdout.length > 1000) {
							response.stdout = response.stdout.slice(0, 1000) + '\n[... stdout truncated in history pruning ...]';
							response.stdout_truncated = true;
						}
						if (typeof response.stderr === 'string' && response.stderr.length > 1000) {
							response.stderr = response.stderr.slice(0, 1000) + '\n[... stderr truncated in history pruning ...]';
							response.stderr_truncated = true;
						}
					}
					// Truncate view_file_git_diff
					if (part.functionResponse.name === 'view_file_git_diff' && typeof response.diff === 'string') {
						if (response.diff.length > 1000) {
							response.diff = response.diff.slice(0, 1000) + '\n[... Diff truncated in history pruning ...]';
							response.is_truncated = true;
						}
					}
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
			const hasFunctionResponse = Array.isArray(msg.parts) && msg.parts.some(p => p && p.functionResponse);
			msg.role = hasFunctionResponse ? 'user' : 'model';
		}
		if (!Array.isArray(msg.parts)) {
			msg.parts = [];
		}
		return msg;
	});
}
