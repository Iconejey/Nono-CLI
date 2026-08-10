export function findCorrespondingCall(history, userMsgIndex, responsePart, partIndex) {
	const modelMsg = history[userMsgIndex - 1];
	if (!modelMsg || modelMsg.role !== 'model' || !Array.isArray(modelMsg.parts)) {
		return null;
	}

	// 1. Try matching by ID if present
	if (responsePart.functionResponse.id) {
		const found = modelMsg.parts.find(p => p.functionCall && p.functionCall.id === responsePart.functionResponse.id);
		if (found) return found.functionCall;
	}

	// 2. Try matching by same index
	const modelPart = modelMsg.parts[partIndex];
	if (modelPart && modelPart.functionCall && modelPart.functionCall.name === responsePart.functionResponse.name) {
		return modelPart.functionCall;
	}

	// 3. Fallback: match by name
	const foundByName = modelMsg.parts.find(p => p.functionCall && p.functionCall.name === responsePart.functionResponse.name);
	if (foundByName) return foundByName.functionCall;

	return null;
}

export function matchesTarget(functionCall, target) {
	if (!functionCall || !functionCall.args) return false;
	const args = functionCall.args;
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
		if (msg.role === 'user' && Array.isArray(msg.parts)) {
			for (let p = 0; p < msg.parts.length; p++) {
				const part = msg.parts[p];
				if (part && part.functionResponse) {
					const call = findCorrespondingCall(history, i, part, p);
					if (call && matchesTarget(call, target)) {
						part.functionResponse.response = {
							status: 'success',
							erased: true,
							message: 'This output has been erased to optimize context window space.'
						};
						count++;
					}
				}
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
		if (msg.role === 'user' && Array.isArray(msg.parts)) {
			for (let p = msg.parts.length - 1; p >= 0; p--) {
				const part = msg.parts[p];
				if (part && part.functionResponse) {
					part.functionResponse.response = {
						status: 'success',
						erased: true,
						message: 'This output has been erased to optimize context window space.'
					};
					erased_count++;
					if (erased_count >= count) {
						break;
					}
				}
			}
		}
		if (erased_count >= count) {
			break;
		}
	}
	return {
		status: 'success',
		message: `Successfully erased the last ${erased_count} tool output(s).`
	};
}
