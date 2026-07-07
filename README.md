# ✦ Nono CLI ✦

> **Bring Nono, your ultra-efficient AI coding agent & terminal workspace specialist, directly into your command line.**

Nono is an agentic terminal companion powered by Google's Gemini API. Designed to operate in either developer or administrator modes, Nono uses a ReAct (Reason + Act) loop to understand codebases, edit files, execute diagnostics, search the web, and run terminal commands—all while keeping token consumption optimized and notifying you with retro synthesized chimes.

## Key Features

- **Dual Mode Operation**:
    - **Workspace Developer Mode**: Performs recursive directory scans, files reading/writing, deterministic file patching, and regex searches (`ripgrep` style) to understand and edit codebases.
    - **System Admin Mode**: Handles precise diagnostics, network operations, system configurations, and utility execution.
- **Built-in Agentic Tools**:
    - **File Operations**: Recursive listing, targeted viewing (line ranges), fresh file creation, and smart file patching.
    - **Advanced Searching**: Regex-based workspace grep and real-time web searches using Gemini's Google Search integration.
    - **Command Execution**: Direct, non-blocking bash command execution with execution timeouts.
    - **Kitty Terminal Integration**: Reads screen buffers and injects proposed commands directly into active Zsh prompts (using Kitty Remote Control).
- **Token & Cost Optimization**:
    - **Pruned History**: Truncates large tool responses in historical turns to conserve context space.
    - **Background Summarization**: Condenses older chat turns into bullet-point "System Memory" chunks when token or turn thresholds are crossed.
    - **Consumption Auditing**: Track your precise token usage and session costs directly using `nono --usage`.
- **Chime Notifications**: Plays synthesized audio notification chimes to alert you when tasks are complete.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- A Gemini API Key (get one from [Google AI Studio](https://aistudio.google.com/))
- _(Optional)_ [Kitty Terminal](https://sw.kovidgoyal.net/kitty/) (for terminal buffer reading and command injection features)

### Setup Steps

1.  **Clone the Repository**:

    ```bash
    git clone https://github.com/your-username/Nono-CLI.git
    cd Nono-CLI
    ```

2.  **Install Dependencies**:

    ```bash
    npm install
    ```

3.  **Configure Environment Variables**:
    Copy the provided `default.env` file to `.env` in the root of the project (or in your home folder at `~/.config/nono/.env`) and add your API key:

    ```bash
    cp default.env .env
    ```

4.  **Link the CLI Globally**:
    To run Nono from anywhere in your terminal, link the package:
    ```bash
    npm link
    ```

## Usage

Once linked, you can invoke Nono using the `nono` command:

```bash
# Ask Nono to perform a task directly from your shell
nono Find all files importing dotenv and list them

# If you are strugling with special characters in your prompt, like quotes,
# you can simply run nono without arguments and type your prompt after
nono
> Find all files importing "dotenv" and list them

# Open the logs and detailed history of the current session in VS Code
nono --details

# Display token usage and cost metrics for the current session/month
nono --usage

# Clear the current terminal session history and reset the agent
nono --clear

# Fetch latest pricing for the active model online and update configuration
nono --get-pricing

# Open a temp file in your text editor to write a prompt and execute it on save and exit
nono --full
# Or using the shorthand flag
nono -f

# Show CLI options
nono --help
```

## Configuration

Nono can be customized using environment variables or configuration files.

### Environment Variables

Place these in your `.env` files (checked at `./.env`, the script directory's `.env`, or `~/.config/nono/.env`):

| Variable                     | Description                                                                   | Default            |
| :--------------------------- | :---------------------------------------------------------------------------- | :----------------- |
| `GEMINI_API_KEY`             | **Required**. Your Gemini API Key.                                            | None               |
| `GEMINI_MODEL`               | The Gemini model to use for the agent.                                        | `gemini-3.5-flash` |
| `NONO_VOLUME`                | Volume level for audio chime notifications (between `0` and `1`).             | `0.6`              |
| `NONO_THEME`                 | Custom terminal syntax highlighting theme (JSON string or path to JSON file). | Hardcoded default  |
| `NONO_SUMMARIZE_TOKEN_LIMIT` | Token threshold before initiating background conversation summarization.      | `20000`            |
| `NONO_CURRENCY`              | Currency symbol or code displayed in consumption auditing tables.             | `€`                |
| `NONO_COUNTRY`               | Country name context used for online model pricing lookup.                    | `France`           |
| `NONO_PRICE_INPUT_PER_M`     | Custom input token price per million (for cost calculations).                 | `1.38`             |
| `NONO_PRICE_OUTPUT_PER_M`    | Custom output token price per million (for cost calculations).                | `8.28`             |
| `NONO_PRICE_CACHE_PER_M`     | Custom cache read token price per million (for cost calculations).            | `0.138`            |

### Custom Styling & Themes

Nono uses custom syntax highlighting for code output in the terminal. To use a custom theme, create a JSON file at `~/.config/nono/theme.json` or assign a JSON file path to `NONO_THEME`.

Example theme configuration:

```json
{
	"keyword": "magenta",
	"built_in": "blue",
	"type": "yellow",
	"literal": "yellow",
	"number": "yellow",
	"regexp": "cyan",
	"string": "green",
	"comment": "gray",
	"class": "blue",
	"function": "blue",
	"tag": "red",
	"name": "blue",
	"attr": "cyan",
	"addition": "green",
	"deletion": "red",
	"default": "white"
}
```

## License

This project is licensed under the MIT License.
