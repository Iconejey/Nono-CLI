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

## 3. Context Window Summarization

### The Danger: "Lossy" Compression

The biggest risk of summarizing history for a coding agent is that LLMs tend to write narrative summaries (e.g., _"We investigated the routing bug and updated the configuration."_).

If the agent forgets _which_ exact file it updated (`src/routes/api.js`) or the specific error code it was fixing, it might hallucinate or repeat mistakes in subsequent steps.

**The Fix:** Instead of asking the LLM for a narrative summary, prompt the summarization task to output a strict **State Object** or **Fact Sheet**.
When the trigger fires, prompt the model with:

> _"Extract the key facts from this conversation history. You must retain exact file paths, critical variables, active error messages, and the current overall goal. Format as bullet points."_

### The Node.js Advantage: Background Summarization

The main downside of this approach is latency. If the user sends a prompt, and Nono realizes it first needs to summarize 50 turns before it can even start thinking about the user's actual request, the user will be left staring at a hanging terminal.

Since Nono is built in Node.js, you can handle this elegantly with asynchronous background processing:

1. Nono answers the user's current prompt using the full history.
2. The user sees the final answer
3. Nono checks the token count. If it exceeds the threshold (e.g., > 20,000 tokens and older than 5 steps, values specified in .env), the user is prompted to summarize the history. The user can choose to ignore this prompt, but if they accept, Nono will spawn a background process to summarize the history.
4. Once the summary returns, Nono rewrites the `session-*.json` file.
5. By the time the user types their next command, the history is already perfectly compressed and ready to go.

### How to structure the History Array

When the trigger fires, you would slice the array and prepend the summary as a system message. Your new history would look like this:

1. **`role: "user"`** -> _"[System Memory: Previously, we modified `index.js` to add context token management. The current goal is to optimize the ReAct loop...]"_
2. **`role: "user"`** -> _(Turn N-2)_
3. **`role: "model"`** -> _(Turn N-2 response)_
4. **`role: "user"`** -> _(Turn N-1)_
5. **`role: "model"`** -> _(Turn N-1 response)_
6. **`role: "user"`** -> _(Current Prompt)_
