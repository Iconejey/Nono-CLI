# Project Nono: Ultra-Efficient CLI AI Agent & Coding Workspace Specialist

## 1. Core Architecture & Multi-Mode Orchestration

To handle both lightweight system administration (e.g., configuring Wi-Fi) and deep workspace software engineering, `nono` must operate using an **Agentic Loop (ReAct: Reason + Act)** powered by an explicit system prompt that enforces strict multi-step reasoning before taking actions.

### Orchestration Loop

1. **Ingest & Parse:** Collect `$PPID` (Session ID), active Kitty screen buffer, and user input.
2. **Reasoning Step (Chain-of-Thought):** The agent analyzes the environment and states its plan inside hidden thinking tokens or structured logging.
3. **Tool Execution:** The agent invokes one or multiple tools in parallel (e.g., reading files, searching the web).
4. **Evaluate & Iterate:** The agent evaluates the results. If the goal is not met, it reasons again and calls more tools.
5. **Finalize:** Return the final explanation or inject the validated bash command into the prompt.

### Dual-Context Modes

- **System Admin Mode:** Triggered by system/terminal prompts. Focuses on minimal, precise system calls (NetworkManager, systemd, system diagnostic tools).
- **Workspace Developer Mode:** Triggered when a project root (e.g., `.git`, `package.json`) is detected. Automatically indexes project structure, reads relevant configuration files, and applies targeted code modifications.

## 2. Advanced Context & Session Management

- **Session Isolation:** Maps conversation history to `~/.cache/nono/session-$PPID.json` to keep separate terminal tabs fully independent.
- **Adaptive Context Window & Buffer Ingestion:**
    - **Live Terminal Sight:** Every prompt automatically passes the last 50–100 lines of the current Kitty window (`kitty @ get-text --screen-text`). This enables instant debugging of compilation errors or raw command outputs without manual copy-pasting.
    - **Token Optimization:** If the project is massive, do _not_ feed entire source trees into the prompt. Instead, use a semantic structure tool (like `rg --files` or `tree`) to let the agent request specific file tokens on demand.

## 3. Gemini Native Tool Specifications (Function Calling)

This is the exact JSON schema collection to declare within the Gemini API Client.

### Category A: Workspace & File System Tools

```json
[
	{
		"name": "list_directory_structure",
		"description": "Lists the files and folders in a directory recursively up to a certain depth to understand the project workspace layout.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"directory_path": { "type": "STRING", "description": "The absolute or relative path to the directory." },
				"depth": { "type": "INTEGER", "description": "Maximum depth of recursion (default: 2)." }
			},
			"required": ["directory_path"]
		}
	},
	{
		"name": "view_file_contents",
		"description": "Reads the exact content of a file. Supports line-range targeting for processing large source files safely.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"file_path": { "type": "STRING", "description": "The path to the file." },
				"start_line": { "type": "INTEGER", "description": "Optional line number to start reading from." },
				"end_line": { "type": "INTEGER", "description": "Optional line number to stop reading at." }
			},
			"required": ["file_path"]
		}
	},
	{
		"name": "write_file",
		"description": "Creates a new file or overwrites an existing file with complete fresh content.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"file_path": { "type": "STRING", "description": "Path where the file should be created/written." },
				"content": { "type": "STRING", "description": "The exact textual content to write." }
			},
			"required": ["file_path", "content"]
		}
	},
	{
		"name": "patch_file",
		"description": "Applies a specific diff, line replacement, or block modification to a file to minimize rewriting huge files.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"file_path": { "type": "STRING", "description": "Path to the target file." },
				"search_block": { "type": "STRING", "description": "The original code block to find." },
				"replace_block": { "type": "STRING", "description": "The new code block to substitute." }
			},
			"required": ["file_path", "search_block", "replace_block"]
		}
	},
	{
		"name": "search_grep",
		"description": "Performs a fast regex-based substring search across the workspace (equivalent to ripgrep) to find references or declarations.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"pattern": { "type": "STRING", "description": "The regex pattern or substring to search for." },
				"directory_path": { "type": "STRING", "description": "The directory root to search inside." }
			},
			"required": ["pattern"]
		}
	}
]
```

### Category B: System & Shell Execution Tools

```json
[
	{
		"name": "execute_system_command",
		"description": "Executes a non-blocking or blocking bash command on the Arch Linux host. Returns stdout, stderr, and exit status code.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"command": { "type": "STRING", "description": "The exact terminal command to run (e.g. 'nmcli dev wifi list', 'cargo build')." },
				"timeout_ms": { "type": "INTEGER", "description": "Maximum execution time in milliseconds (default: 30000)." }
			},
			"required": ["command"]
		}
	},
	{
		"name": "propose_terminal_input",
		"description": "Injects text straight into the user's active Zsh prompt using Kitty's remote control feature, leaving the user to hit Enter.",
		"parameters": {
			"type": "OBJECT",
			"properties": {
				"command_to_inject": { "type": "STRING", "description": "The command string to stage on the user shell line." }
			},
			"required": ["command_to_inject"]
		}
	}
]
```

### Category C: Knowledge & Web Retrieval (Native Gemini Tool)

Instead of a custom scraping script, leverage Gemini's native **Google Search Grounding** feature. This allows the model to autonomously trigger Google searches, read up-to-date web data, and generate a synthesized report with citations.

**API Configuration Syntax (Node.js SDK):**

```javascript
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
	model: process.env.GEMINI_MODEL
	contents: user_prompt,
	// This single line replaces all custom search and scraping code:
	tools: [{ googleSearch: {} }]
});

// The response will include:
// - response.text (The full report/answer)
// - response.candidates[0].groundingMetadata (Web sources, URLs, and search queries used)
```

## 4. Engineering Best Practices for High-Efficiency Coding

1. **Strict Plan-Before-Code Protocol:** In the system prompt, force Gemini to outputs its technical strategy before triggering a write or patch tool.
2. **Linting & Verification Loop:** Whenever Nono modifies code, it must automatically execute a dry-run tool command (e.g., `npm run lint`, `tsc --noEmit`, or project tests) to fix its own errors before returning a success state.
3. **Deterministic Patching over Complete Rewrites:** Refuse massive code drops. Emphasize using the `patch_file` tool to optimize speed, token consumption, and avoid accidentally wiping out critical adjacent functions.
4. **Interactive Guardrails:** For high-impact system administrative actions (like modifications under `/etc/` or package installations via `pacman`), the local engine should prompt the user for validation (`[y/N]`) before letting the agent loop proceed.

## 5. CLI Interface & Shell Integration

To maximize efficiency, `nono` supports unquoted, natural CLI prompts (e.g., `nono connect me to wifi`) instead of requiring wrapped strings like `nono "prompt"`.

### Argument Parsing (Node.js)

The script captures all trailing arguments and reconstitutes them into a single string query, ensuring a seamless natural language feel.

```javascript
// Reassemble space-separated shell arguments into a single coherent prompt
const userPrompt = process.argv.slice(2).join(' ');
```

### Zsh Escaping Guardrail (`noglob`)

Special characters (like `?` or `*`) are natively interpreted by Zsh as globbing operators, which can crash or intercept the command before it reaches the Node.js process. To bypass this, the CLI tool must be aliased with `noglob` inside the user's `~/.zshrc`:

```bash
# Prevents Zsh from parsing wildcards or question marks before passing them to Nono
alias nono="noglob node /path/to/nono/index.js"
```
