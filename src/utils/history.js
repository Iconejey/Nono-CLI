export function findCorrespondingCall(history, toolCallId) {
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
			const found = msg.tool_calls.find(tc => tc.id === toolCallId);
			if (found) return found;
		}
	}
	return null;
}

export function matchesTarget(toolCall, target) {
	if (!toolCall || !toolCall.function || !toolCall.function.arguments) {
		return false;
	}
	let args;
	try {
		args = JSON.parse(toolCall.function.arguments);
	} catch (e) {
		return false;
	}
	if (typeof args !== 'object' || args === null) {
		return false;
	}
	for (const key of Object.keys(args)) {
		if (typeof args[key] === 'string' && args[key] === target) {
			return true;
		}
	}
	return false;
}

export function discardSpecificOutput({ target }, history) {
	if (!Array.isArray(history)) {
		return { status: 'error', error: 'History is not available.' };
	}
	if (typeof target !== 'string' || !target) {
		return { status: 'error', error: 'Invalid target provided.' };
	}
	let count = 0;
	for (let i = 0; i < history.length; i++) {
		const msg = history[i];
		if (msg && msg.role === 'tool' && msg.tool_call_id) {
			const call = findCorrespondingCall(history, msg.tool_call_id);
			if (call && matchesTarget(call, target)) {
				msg.content = JSON.stringify({
					status: 'success',
					erased: true,
					message: 'This output has been erased to optimize context window space.'
				});
				count++;
			}
		}
	}
	return {
		status: 'success',
		message: `Successfully erased ${count} tool output(s) matching "${target}".`
	};
}

export function discardLastSteps({ steps_count }, history) {
	if (!Array.isArray(history)) {
		return { status: 'error', error: 'History is not available.' };
	}
	const count = parseInt(steps_count, 10);
	if (isNaN(count) || count <= 0) {
		return { status: 'error', error: 'Invalid steps_count provided.' };
	}
	let erased_count = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (msg && msg.role === 'tool') {
			msg.content = JSON.stringify({
				status: 'success',
				erased: true,
				message: 'This output has been erased to optimize context window space.'
			});
			erased_count++;
			if (erased_count >= count) {
				break;
			}
		}
	}
	return {
		status: 'success',
		message: `Successfully erased the last ${erased_count} tool output(s).`
	};
}
