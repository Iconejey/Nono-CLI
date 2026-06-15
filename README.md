I want you to create an AI-powered terminal wrapper using NodeJS, called Nono. The goal is to type "nono" in the terminal and nothing seems to happen, but in reality we are running the terminal wrapped in nodejs. If I type a command, like ls, it works exactly like a normal terminal. But when I press "<" as first character, the terminal shows a line starting with "{model}> " and what I type will be handled by the AI agent.

The AI will have the context of the terminal history, and will be able to run commands in the reminal.

A json config will list the models availabel (Title, api key, official model name...) and pressing "<" multiple times will loop between models.

Pressing esc will clear the user's prompt and pressing esc with an empty prompt will switch back to terminal mode.

Note that when the AI task is done, it goes back to terminal mode. It does not stay in AI mode.

Make sure the best practices to optimise token costs, like faforizing cache hit.

Make sure the terminal stays fully functional, keeping commands output colors and native features like sudo password input.

## Installation & Setup

To install `nono` globally on your system:

```bash
npm link
```

## Configuration

`nono` supports multiple providers (Gemini, OpenAI, Anthropic). It reads configuration from:
`config.json` (located in the `nono` package installation directory).

This file is gitignored. If it doesn't exist, it will be automatically created on first run by copying the `default-config.json` template. You must configure your API keys directly inside the `config.json` file.



## How to Use

1. Run `nono` to start the wrapped terminal.
2. Press `<` at the beginning of the prompt to switch to **AI Mode**.
3. In **AI Mode**:
    - Type your query.
    - Press `<` multiple times to cycle between models.
    - Type `/` to open the command menu:
      - `/clear`: Clear terminal command outputs from history context (keeps only AI chat and command inputs).
      - `/context`: Log the full clean terminal history context (in purple).
      - `/exit`: Exit the Nono terminal wrapper session entirely.
      - `/restart`: Reload the `config.json` configuration file from disk.
      - Use **Up/Down Arrow keys** to navigate matching commands.
      - Press **Enter** to autocomplete the highlighted command, and **Enter** again to run it.
    - Press `Esc` to clear the query. Press `Esc` with an empty query to return to **Terminal Mode**.
    - Press `Enter` to submit the query to the AI.
4. When the AI finishes its task, the wrapper returns to **Terminal Mode** automatically.


