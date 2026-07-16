### Forget useless outputs

Allow Nono to disgard useless outputs, like reading a file that happended not to be useful for the task.

### Given text context [Completed]

We want to separate the `--selection (-s)` command into :

- [x] `--vscode (-vs)` for current implementation, gathering selected vscode text and file path.
- [x] `--file (-f) [path][:line][:start_line-end_line]` to include whole/parts of text file.
- [x] `--clipboard (-c)` to include the copied text in clipboard.

Note that the `--full (-f)` command will be replaced with `--write (-w)`. And a .env will allow to force the editor ("vim" or "nano").

### Prevent early "✦ Task completed."

Sometimes the ReAct loop will stop after reading the files only, thinking its job is not to edit files.
