### Forget useless outputs

Allow Nono to disgard useless outputs, like reading a file that happended not to be useful for the task.

```json
{
	"name": "discard_specific_output",
	"description": "Replaces the output of a specific previous tool call (such as a read file or an executed command) with an 'erased' placeholder to optimize context window space. Use this when you realize a specific file or command output is useless.",
	"parameters": {
		"type": "OBJECT",
		"properties": {
			"target": {
				"type": "STRING",
				"description": "The exact file path or command string whose output should be cleared from memory."
			}
		},
		"required": ["target"]
	}
}
```

```json
{
	"name": "discard_last_steps",
	"description": "Replaces the outputs of the last N tool calls with an 'erased' placeholder. Use this to quickly clean up memory after realizing your most recent steps or explorations were a dead end.",
	"parameters": {
		"type": "OBJECT",
		"properties": {
			"steps_count": {
				"type": "INTEGER",
				"description": "The number of recent tool outputs to erase from memory (counting backwards from the most recent call)."
			}
		},
		"required": ["steps_count"]
	}
}
```

### Prevent early "✦ Task completed."

Sometimes the ReAct loop will stop after reading the files only, thinking its job is not to edit files.
