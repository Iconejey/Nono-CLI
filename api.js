// Use native fetch (available globally in Node 18+)

export async function callModel({ provider, model, apiKey: api_key, baseURL: base_url }, messages, tools) {
	if (provider === 'gemini') return callGemini(model, api_key, messages, tools);
	else if (provider === 'openai') return callOpenAI(model, api_key, base_url, messages, tools);
	else if (provider === 'anthropic') return callAnthropic(model, api_key, messages, tools);
	else throw new Error(`Unsupported provider: ${provider}`);
}

async function callGemini(model, api_key, messages, tools) {
	// Convert standard messages to Gemini contents format
	const contents = messages
		.map(msg => {
			if (msg.role === 'system') {
				// Gemini handles system instruction separately
				return null;
			}

			// Map roles: 'user' -> 'user', 'assistant' -> 'model', 'tool' -> 'user'
			let role = msg.role;
			if (role === 'assistant') role = 'model';
			if (role === 'tool') role = 'user';

			const parts = [];
			if (msg.content) {
				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === 'text') {
							parts.push({ text: part.text });
						}
					}
				} else {
					parts.push({ text: msg.content });
				}
			}

			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					parts.push({
						functionCall: {
							name: tc.function.name,
							args: JSON.parse(tc.function.arguments)
						}
					});
				}
			}

			if (msg.role === 'tool') {
				parts.push({
					functionResponse: {
						name: msg.name || 'run_command',
						response: { output: msg.content }
					}
				});
			}

			return { role, parts };
		})
		.filter(Boolean);

	const system_message = messages.find(msg => msg.role === 'system');
	const system_instruction = system_message
		? {
				parts: [{ text: typeof system_message.content === 'string' ? system_message.content : system_message.content[0].text }]
			}
		: undefined;

	const gemini_tools = tools
		? [
				{
					functionDeclarations: tools.map(t => ({
						name: t.function.name,
						description: t.function.description,
						parameters: {
							type: t.function.parameters.type.toUpperCase(),
							properties: Object.keys(t.function.parameters.properties).reduce((acc, key) => {
								const prop = t.function.parameters.properties[key];
								acc[key] = {
									type: prop.type.toUpperCase(),
									description: prop.description
								};
								return acc;
							}, {}),
							required: t.function.parameters.required
						}
					}))
				}
			]
		: undefined;

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			contents,
			systemInstruction: system_instruction,
			tools: gemini_tools
		})
	});

	if (!response.ok) {
		const error_text = await response.text();
		throw new Error(`Gemini API error (${response.status}): ${error_text}`);
	}

	const data = await response.json();
	const candidate = data.candidates?.[0];
	if (!candidate) {
		throw new Error('No candidate returned from Gemini');
	}

	const parts = candidate.content?.parts || [];
	const text_part = parts.find(p => p.text);
	const func_call_part = parts.find(p => p.functionCall);

	const result = {
		role: 'assistant',
		content: text_part ? text_part.text : ''
	};

	if (func_call_part) {
		result.tool_calls = [
			{
				id: 'call_' + Math.random().toString(36).substring(2, 11),
				type: 'function',
				function: {
					name: func_call_part.functionCall.name,
					arguments: JSON.stringify(func_call_part.functionCall.args)
				}
			}
		];
	}

	return result;
}

async function callOpenAI(model, api_key, base_url, messages, tools) {
	const url = `${base_url || 'https://api.openai.com/v1'}/chat/completions`;

	// Format messages for OpenAI API
	const formatted_messages = messages.map(msg => {
		const formatted = { role: msg.role };
		if (msg.role === 'tool') {
			formatted.tool_call_id = msg.tool_call_id;
			formatted.content = msg.content;
		} else {
			if (Array.isArray(msg.content)) {
				formatted.content = msg.content.map(p => p.text).join('\n');
			} else {
				formatted.content = msg.content;
			}
			if (msg.tool_calls) {
				formatted.tool_calls = msg.tool_calls;
			}
		}
		return formatted;
	});

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${api_key}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model,
			messages: formatted_messages,
			tools: tools
		})
	});

	if (!response.ok) {
		const error_text = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${error_text}`);
	}

	const data = await response.json();
	const message = data.choices?.[0]?.message;
	if (!message) {
		throw new Error('No message returned from OpenAI');
	}

	return {
		role: 'assistant',
		content: message.content || '',
		tool_calls: message.tool_calls
	};
}

async function callAnthropic(model, api_key, messages, tools) {
	const url = 'https://api.anthropic.com/v1/messages';

	const system_message = messages.find(msg => msg.role === 'system');
	const system_text = system_message ? (typeof system_message.content === 'string' ? system_message.content : system_message.content[0].text) : '';

	// Anthropic prompt caching: mark system message with ephemeral cache control
	const system = system_text
		? [
				{
					type: 'text',
					text: system_text,
					cache_control: { type: 'ephemeral' }
				}
			]
		: undefined;

	// Map messages (excluding system)
	// Combine tool output messages and handle tool calls
	const anthropic_messages = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === 'system') continue;

		if (msg.role === 'user') {
			// Check if we can cache the last user message before the current one (if it's large)
			const is_last_user = i >= messages.length - 2; // user message before assistant
			const content = [];
			if (typeof msg.content === 'string') {
				content.push({
					type: 'text',
					text: msg.content,
					...(is_last_user ? { cache_control: { type: 'ephemeral' } } : {})
				});
			} else if (Array.isArray(msg.content)) {
				content.push(
					...msg.content.map(p => ({
						type: 'text',
						text: p.text,
						...(is_last_user ? { cache_control: { type: 'ephemeral' } } : {})
					}))
				);
			}
			anthropic_messages.push({ role: 'user', content });
		} else if (msg.role === 'assistant') {
			const content = [];
			if (msg.content) {
				content.push({ type: 'text', text: msg.content });
			}
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					content.push({
						type: 'tool_use',
						id: tc.id,
						name: tc.function.name,
						input: JSON.parse(tc.function.arguments)
					});
				}
			}
			anthropic_messages.push({ role: 'assistant', content });
		} else if (msg.role === 'tool') {
			// Anthropic tool results are user messages with a tool_result block
			anthropic_messages.push({
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: msg.tool_call_id,
						content: msg.content
					}
				]
			});
		}
	}

	// Format tools for Anthropic
	const anthropic_tools = tools
		? tools.map(t => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: {
					type: t.function.parameters.type,
					properties: t.function.parameters.properties,
					required: t.function.parameters.required
				}
			}))
		: undefined;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'x-api-key': api_key,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			model,
			max_tokens: 4096,
			system,
			messages: anthropic_messages,
			tools: anthropic_tools
		})
	});

	if (!response.ok) {
		const error_text = await response.text();
		throw new Error(`Anthropic API error (${response.status}): ${error_text}`);
	}

	const data = await response.json();

	let content_text = '';
	const tool_calls = [];

	if (Array.isArray(data.content)) {
		for (const item of data.content) {
			if (item.type === 'text') {
				content_text += item.text;
			} else if (item.type === 'tool_use') {
				tool_calls.push({
					id: item.id,
					type: 'function',
					function: {
						name: item.name,
						arguments: JSON.stringify(item.input)
					}
				});
			}
		}
	}

	return {
		role: 'assistant',
		content: content_text,
		...(tool_calls.length > 0 ? { tool_calls: tool_calls } : {})
	};
}
