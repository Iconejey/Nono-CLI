# Tracking Token Generation Counts in Non-Streaming VLLM Mode

When running Nono-CLI with vLLM in non-streaming mode (which ensures stable tool-calling and prevents premature terminations), real-time token counts can be tracked by querying the vLLM Prometheus metrics endpoint and exposing them via your custom stats Express server.

---

## 1. How It Works

1. **Baseline Capture:** When Nono-CLI initiates a new vLLM API request, it captures the current cumulative generated tokens count from `latest_vllm_stats.vllm.generation_tokens_total` and saves it as `vllm_baseline_generation`.
2. **Background Polling:** The background polling loop queries your `VLLM_STAT_URL` every second, updating the cumulative count inside `latest_vllm_stats`.
3. **Dynamic Delta Calculation:** During the generation, `drawBottomLine` calculates the delta:
   $$\text{talking\_token\_count} = \text{generation\_tokens\_total} - \text{baseline}$$
   The command line updates the status line dynamically to show `Generating (12 tokens)...`, `Generating (45 tokens)...`, etc.

---

## 2. Implementing the Token Count on Your Stats Express Server

vLLM automatically exposes Prometheus-compatible metrics on `/metrics` on the same port as the model inference server (e.g., `http://localhost:24600/metrics`).

You can extract the cumulative counters in your Express server using either of the following approaches:

### Option A: If your Express Server spawns Shell Commands

If your server executes bash scripts or spawns child processes to parse statistics, use `awk` to extract the metric value. This is highly robust as it automatically ignores Prometheus parameters/labels (e.g. `{model_name="..."}`) and prints the last field:

```bash
# Get the cumulative generated tokens count
curl -s http://localhost:24600/metrics | awk '/^vllm:generation_tokens_total/{print $NF}'

# Get the cumulative prompt (prefill) tokens count (optional)
curl -s http://localhost:24600/metrics | awk '/^vllm:prompt_tokens_total/{print $NF}'
```

### Option B: If your Express Server is Node.js-based (JavaScript-native parsing)

If your stats server is written in Node.js, you can parse the `/metrics` endpoint directly using regex matching:

```javascript
async function getVllmMetrics() {
	try {
		const response = await fetch('http://localhost:24600/metrics');
		const text = await response.text();

		// RegEx handles potential metrics formats like vllm:generation_tokens_total{model_name="..."} 12345
		const genMatch = text.match(/^vllm:generation_tokens_total(?:{[^}]+})?\s+(\d+)/m);
		const promptMatch = text.match(/^vllm:prompt_tokens_total(?:{[^}]+})?\s+(\d+)/m);

		return {
			generation_tokens_total: genMatch ? parseInt(genMatch[1], 10) : 0,
			prompt_tokens_total: promptMatch ? parseInt(promptMatch[1], 10) : 0
		};
	} catch (err) {
		return { generation_tokens_total: 0, prompt_tokens_total: 0 };
	}
}
```

---

## 3. Required JSON Response Structure

Your `VLLM_STAT_URL` endpoint should merge these fields under a `.vllm` object key in its JSON response payload:

```json
{
	"cpu": {
		"usage_percentage": 14,
		"temperature_celsius": 42
	},
	"gpus": [
		{
			"index": 0,
			"usage_percentage": 95,
			"temperature_celsius": 68
		}
	],
	"vllm": {
		"current_context_tokens_total": 2100,
		"max_model_len": 32768,
		"generation_tokens_total": 154320,
		"prompt_tokens_total": 98765
	}
}
```
