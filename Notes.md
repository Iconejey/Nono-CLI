## 1. Consumption Tracking (Tokens and Costs) [IMPLEMENTED]

- **Metadata extraction:** Use the `response.usageMetadata` object provided by the SDK after each call to the Gemini API. (Done)
- **Precise calculation:** Isolate the "new" tokens by subtracting `cachedContentTokenCount` from the total `promptTokenCount` to get exactly what is billed. (Done)
- **Logging:** Save these three counters (Raw Input, Output, Cache) in a local file to allow for financial estimation via a dedicated command. (Done - added `--usage` command)

## 2. Context Optimization (Maximizing Cache)

- **End of passive injection:** Stop systematically concatenating the project tree and the Kitty buffer to every new prompt.
- **Terminal reading tool:** Replace automatic injection with a `read_terminal_buffer` tool that the agent can actively choose to call only when relevant.
- **History pruning:** Purge or truncate old, massive tool responses (like the returns from `search_grep` or `view_file_contents`) when saving the session history.
- **ANSI filtering:** Clean up command outputs by stripping out visual escape codes (colors, etc.) before passing them to the model to save tokens.
- **Tool output summarization trigger:** When a tool output exceeds 1000 characters, tell the main agent that the output is too long and ask what it is looking for, so its answer can be given to a sub-agent that will summarize the output and return a concise answer to the main agent.
