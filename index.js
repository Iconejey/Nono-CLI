#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec, execSync, spawn } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// Load environment variables from the directory of this script or fallback locations
const dir_name = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(dir_name, '.env') });
dotenv.config({ path: path.join(os.homedir(), '.config', 'nono', '.env') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

const api_key = process.env.GEMINI_API_KEY;
const model_name = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

if (!api_key) {
  console.error('\x1b[31mError: GEMINI_API_KEY is not set.\x1b[0m');
  console.error('Please configure your GEMINI_API_KEY in a .env file.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: api_key });

// Helper to play sound
function playSound(type) {
  // Always trigger the terminal bell character first
  process.stdout.write('\x07');

  let sound_file = 'window-question.oga';
  if (type === 'attention') {
    sound_file = 'window-attention.oga';
  } else if (type === 'error') {
    sound_file = 'dialog-error.oga';
  } else if (type === 'complete') {
    sound_file = 'complete.oga';
  }

  const full_path = `/usr/share/sounds/freedesktop/stereo/${sound_file}`;
  const player = fs.existsSync('/usr/bin/pw-play') 
    ? 'pw-play' 
    : (fs.existsSync('/usr/bin/paplay') ? 'paplay' : null);

  if (player && fs.existsSync(full_path)) {
    // Run the audio player detached/non-blocking
    spawn(player, [full_path], { stdio: 'ignore', detached: true }).unref();
  }
}

// Helper to ask the user a question / confirmation
function askUser(question) {
  playSound('question');
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Find project root
function findProjectRoot(start_dir = process.cwd()) {
  const root_indicators = ['.git', 'package.json', 'cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Notes.md'];
  let current_dir = start_dir;
  while (true) {
    for (const indicator of root_indicators) {
      if (fs.existsSync(path.join(current_dir, indicator))) {
        return current_dir;
      }
    }
    const parent_dir = path.dirname(current_dir);
    if (parent_dir === current_dir) {
      break;
    }
    current_dir = parent_dir;
  }
  return null;
}

// Get kitty screen text
function getKittyScreenText() {
  try {
    const output = execSync('kitty @ get-text', {
      timeout: 500,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (output) {
      const lines = output.split('\n');
      return lines.slice(-100).join('\n');
    }
  } catch (err) {
    // Ignore error (e.g. remote control disabled, or not in kitty)
  }
  return null;
}

// Run project dry-run command if possible
function runProjectDryRun(modified_file_path) {
  const project_root = findProjectRoot(path.dirname(modified_file_path));
  if (!project_root) {
    return null;
  }

  // Node project
  const pkg_json_path = path.join(project_root, 'package.json');
  if (fs.existsSync(pkg_json_path)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkg_json_path, 'utf8'));
      let command = null;
      if (pkg.scripts) {
        if (pkg.scripts.lint) {
          command = 'npm run lint';
        } else if (pkg.scripts.test) {
          command = 'npm test';
        } else if (pkg.scripts.build) {
          command = 'npm run build';
        }
      }
      
      const tsconfig_path = path.join(project_root, 'tsconfig.json');
      if (!command && fs.existsSync(tsconfig_path)) {
        command = 'npx tsc --noEmit';
      }

      if (command) {
        console.log(`\n\x1b[33m⚡ Running dry-run validation: "${command}"...\x1b[0m`);
        try {
          const stdout = execSync(command, {
            cwd: project_root,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe']
          });
          console.log('\x1b[32m✔ Dry-run passed successfully!\x1b[0m');
          return {
            dry_run: {
              command,
              status: 'passed',
              output: stdout.trim()
            }
          };
        } catch (err) {
          const error_msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
          console.log('\x1b[31m❌ Dry-run validation failed!\x1b[0m');
          playSound('error');
          return {
            dry_run: {
              command,
              status: 'failed',
              error: error_msg.trim()
            }
          };
        }
      }
    } catch (e) {
      // Ignore package parsing errors
    }
  }

  // Rust / Cargo project
  const cargo_toml_path = path.join(project_root, 'Cargo.toml');
  if (fs.existsSync(cargo_toml_path)) {
    const command = 'cargo check';
    console.log(`\n\x1b[33m⚡ Running dry-run validation: "${command}"...\x1b[0m`);
    try {
      const stdout = execSync(command, {
        cwd: project_root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      console.log('\x1b[32m✔ Dry-run passed successfully!\x1b[0m');
      return {
        dry_run: {
          command,
          status: 'passed',
          output: stdout.trim()
        }
      };
    } catch (err) {
      const error_msg = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      console.log('\x1b[31m❌ Dry-run validation failed!\x1b[0m');
      playSound('error');
      return {
        dry_run: {
          command,
          status: 'failed',
          error: error_msg.trim()
        }
      };
    }
  }

  return null;
}

// Check if a command is high-impact
function isHighImpactCommand(command) {
  const normalized = command.toLowerCase();
  
  if (normalized.includes('sudo')) return true;
  if (normalized.includes('pacman') || normalized.includes('yay') || normalized.includes('paru')) return true;
  
  if (normalized.includes('systemctl') && (
    normalized.includes('start') ||
    normalized.includes('stop') ||
    normalized.includes('restart') ||
    normalized.includes('enable') ||
    normalized.includes('disable')
  )) {
    return true;
  }
  
  if (
    normalized.includes('/etc/') ||
    normalized.includes('/sys/') ||
    normalized.includes('/boot/') ||
    normalized.includes('/usr/lib/systemd')
  ) {
    const is_write = />|>>|tee|rm\s|mv\s|cp\s|chmod|chown|edit|mkdir|touch/g.test(command);
    if (is_write) return true;
  }
  
  return false;
}

// ----------------------------------------------------
// Tool Implementations
// ----------------------------------------------------

function listDirectoryStructure({ directory_path, depth = 2 }) {
  const abs_path = path.resolve(directory_path);
  
  function recurse(dir, current_depth = 1) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${dir}`);
    }

    const items = fs.readdirSync(dir);
    const result = [];

    for (const item of items) {
      if (item === '.git' || item === 'node_modules' || item === '.cache') {
        continue;
      }
      const item_path = path.join(dir, item);
      const item_stat = fs.statSync(item_path);
      const is_dir = item_stat.isDirectory();

      const entry = {
        name: item,
        path: path.relative(process.cwd(), item_path),
        type: is_dir ? 'directory' : 'file'
      };

      if (is_dir && current_depth < depth) {
        try {
          entry.children = recurse(item_path, current_depth + 1);
        } catch (e) {
          entry.error = e.message;
        }
      }
      result.push(entry);
    }
    return result;
  }

  return { files: recurse(abs_path, 1) };
}

function viewFileContents({ file_path, start_line, end_line }) {
  const abs_path = path.resolve(file_path);
  if (!fs.existsSync(abs_path)) {
    throw new Error(`File does not exist: ${file_path}`);
  }
  const stat = fs.statSync(abs_path);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${file_path}`);
  }

  const content = fs.readFileSync(abs_path, 'utf8');
  const lines = content.split(/\r?\n/);

  const start = start_line ? Math.max(1, start_line) : 1;
  const end = end_line ? Math.min(lines.length, end_line) : lines.length;

  const sliced_lines = lines.slice(start - 1, end);
  return {
    file_path,
    total_lines: lines.length,
    start_line: start,
    end_line: end,
    content: sliced_lines.join('\n')
  };
}

function writeFile({ file_path, content }) {
  const abs_path = path.resolve(file_path);
  const dir = path.dirname(abs_path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(abs_path, content, 'utf8');

  const lint_result = runProjectDryRun(abs_path);
  return {
    file_path,
    status: 'success',
    ...lint_result
  };
}

function patchFile({ file_path, search_block, replace_block }) {
  const abs_path = path.resolve(file_path);
  if (!fs.existsSync(abs_path)) {
    throw new Error(`File does not exist: ${file_path}`);
  }
  const content = fs.readFileSync(abs_path, 'utf8');

  const normalized_content = content.replace(/\r\n/g, '\n');
  const normalized_search = search_block.replace(/\r\n/g, '\n');
  const normalized_replace = replace_block.replace(/\r\n/g, '\n');

  const index = normalized_content.indexOf(normalized_search);
  if (index === -1) {
    throw new Error(`Search block not found in file: ${file_path}`);
  }

  const last_index = normalized_content.lastIndexOf(normalized_search);
  if (index !== last_index) {
    throw new Error(`Search block is not unique. It appears multiple times in file: ${file_path}`);
  }

  const patched_content = normalized_content.slice(0, index) + normalized_replace + normalized_content.slice(index + normalized_search.length);
  fs.writeFileSync(abs_path, patched_content, 'utf8');

  const lint_result = runProjectDryRun(abs_path);
  return {
    file_path,
    status: 'success',
    ...lint_result
  };
}

function searchGrep({ pattern, directory_path }) {
  return new Promise((resolve) => {
    const search_dir = directory_path ? path.resolve(directory_path) : process.cwd();
    const cmd = `/usr/bin/rg -n --no-heading --color=never --max-count=100 ${JSON.stringify(pattern)} ${JSON.stringify(search_dir)}`;
    
    exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error && error.code !== 1) { // 1 means no matches
        resolve({
          status: 'error',
          error: stderr || error.message
        });
      } else {
        resolve({
          status: 'success',
          matches: stdout.trim() || 'No matches found.'
        });
      }
    });
  });
}

async function executeSystemCommand({ command, timeout_ms = 30000 }) {
  if (isHighImpactCommand(command)) {
    console.log(`\n\x1b[31m⚠️ High-impact action detected: "${command}"\x1b[0m`);
    const answer = await askUser(`Do you want to run this command? [y/N]: `);
    const norm = answer.trim().toLowerCase();
    if (norm !== 'y' && norm !== 'yes') {
      return {
        status: 'error',
        error: 'Execution cancelled by the user.'
      };
    }
  }

  // Pre-authenticate sudo if command uses sudo and credentials are not cached
  if (command.includes('sudo')) {
    try {
      execSync('sudo -n true', { stdio: 'ignore' });
    } catch (e) {
      console.log(`\n\x1b[33m🔑 sudo credential caching required. Please authenticate when prompted:\x1b[0m`);
      playSound('attention');
      try {
        execSync('sudo true', { stdio: 'inherit' });
      } catch (err) {
        return {
          status: 'error',
          error: 'Sudo authentication failed.'
        };
      }
    }
  }

  return new Promise((resolve) => {
    exec(command, { timeout: timeout_ms }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout,
        stderr: stderr,
        exit_code: error ? (error.code || 1) : 0
      });
    });
  });
}

function proposeTerminalInput({ command_to_inject }) {
  return new Promise((resolve) => {
    const window_id = process.env.KITTY_WINDOW_ID;
    const match_arg = window_id ? `--match id:${window_id}` : '';
    const cmd = `kitty @ send-text ${match_arg} ${JSON.stringify(command_to_inject)}`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve({
          status: 'error',
          error: stderr || error.message
        });
      } else {
        resolve({
          status: 'success',
          message: `Injected command into terminal prompt: "${command_to_inject}"`
        });
      }
    });
  });
}

// Map tool name to implementation function
const tools_mapping = {
  list_directory_structure: listDirectoryStructure,
  view_file_contents: viewFileContents,
  write_file: writeFile,
  patch_file: patchFile,
  search_grep: searchGrep,
  execute_system_command: executeSystemCommand,
  propose_terminal_input: proposeTerminalInput
};

// ----------------------------------------------------
// Gemini Tool Declarations
// ----------------------------------------------------

const tools_declarations = [
  {
    name: 'list_directory_structure',
    description: 'Lists the files and folders in a directory recursively up to a certain depth to understand the project workspace layout.',
    parameters: {
      type: 'OBJECT',
      properties: {
        directory_path: { type: 'STRING', description: 'The absolute or relative path to the directory.' },
        depth: { type: 'INTEGER', description: 'Maximum depth of recursion (default: 2).' }
      },
      required: ['directory_path']
    }
  },
  {
    name: 'view_file_contents',
    description: 'Reads the exact content of a file. Supports line-range targeting for processing large source files safely.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_path: { type: 'STRING', description: 'The path to the file.' },
        start_line: { type: 'INTEGER', description: 'Optional line number to start reading from.' },
        end_line: { type: 'INTEGER', description: 'Optional line number to stop reading at.' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'write_file',
    description: 'Creates a new file or overwrites an existing file with complete fresh content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_path: { type: 'STRING', description: 'Path where the file should be created/written.' },
        content: { type: 'STRING', description: 'The exact textual content to write.' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'patch_file',
    description: 'Applies a specific diff, line replacement, or block modification to a file to minimize rewriting huge files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_path: { type: 'STRING', description: 'Path to the target file.' },
        search_block: { type: 'STRING', description: 'The original code block to find.' },
        replace_block: { type: 'STRING', description: 'The new code block to substitute.' }
      },
      required: ['file_path', 'search_block', 'replace_block']
    }
  },
  {
    name: 'search_grep',
    description: 'Performs a fast regex-based substring search across the workspace (equivalent to ripgrep) to find references or declarations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: { type: 'STRING', description: 'The regex pattern or substring to search for.' },
        directory_path: { type: 'STRING', description: 'The directory root to search inside.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'execute_system_command',
    description: 'Executes a non-blocking or blocking bash command on the Arch Linux host. Returns stdout, stderr, and exit status code.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: 'The exact terminal command to run (e.g. \'nmcli dev wifi list\', \'cargo build\').' },
        timeout_ms: { type: 'INTEGER', description: 'Maximum execution time in milliseconds (default: 30000).' }
      },
      required: ['command']
    }
  },
  {
    name: 'propose_terminal_input',
    description: 'Injects text straight into the user\'s active Zsh prompt using Kitty\'s remote control feature, leaving the user to hit Enter.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command_to_inject: { type: 'STRING', description: 'The command string to stage on the user shell line.' }
      },
      required: ['command_to_inject']
    }
  }
];

const system_prompt = `You are Nono, an ultra-efficient CLI AI Agent & Coding Workspace Specialist.
You run on an Arch Linux host and operate in one of two modes:
1. System Admin Mode: Focused on minimal, precise system calls (NetworkManager, systemctl, diagnostics).
2. Workspace Developer Mode: Focused on codebase understanding, editing, and software engineering.

CRITICAL INSTRUCTIONS:
- You operate using an Agentic Loop (ReAct: Reason + Act). Before invoking any tool, you MUST output your plan and reasoning.
- Plan-Before-Code Protocol: Before writing or patching any file, you must output a clear technical strategy.
- Deterministic Patching: Prefer patch_file over complete rewrites for existing files to conserve tokens and reduce errors.
- Dry-run validation: After modifying files, the local engine automatically runs dry-run checks (like linting or tsc), but you should review the results and fix any errors.
- If you need to search for code or references, use search_grep.
- If you need up-to-date web information, use the googleSearch tool.

Guidelines:
- Keep your final output concise and accurate.
- Maintain documentation integrity.
`;

// ----------------------------------------------------
// Main Agentic Loop Orchestrator
// ----------------------------------------------------

async function main() {
  // Capture CLI arguments
  let user_query = process.argv.slice(2).join(' ');

  // If no arguments, prompt interactively
  if (!user_query.trim()) {
    console.log('\x1b[32mNono Workspace Specialist\x1b[0m');
    user_query = await askUser('How can I help you today? ');
    if (!user_query.trim()) {
      console.log('No prompt provided. Exiting.');
      process.exit(0);
    }
  }

  // Load or initialize session
  const cache_dir = path.join(os.homedir(), '.cache', 'nono');
  if (!fs.existsSync(cache_dir)) {
    fs.mkdirSync(cache_dir, { recursive: true });
  }
  const session_path = path.join(cache_dir, `session-${process.ppid}.json`);
  
  let history = [];
  if (fs.existsSync(session_path)) {
    try {
      history = JSON.parse(fs.readFileSync(session_path, 'utf8'));
    } catch (e) {
      // Clear corrupt file
    }
  }

  // Ingest environmental context
  const project_root = findProjectRoot();
  const screen_text = getKittyScreenText();

  let context_bonus = '';
  if (screen_text) {
    context_bonus += `\n\n[Live Terminal Buffer (last 100 lines)]:\n${screen_text}`;
  }
  if (project_root) {
    context_bonus += `\n\n[Workspace Developer Mode active. Project root: ${project_root}]`;
    try {
      const root_structure = listDirectoryStructure({ directory_path: project_root, depth: 1 });
      context_bonus += `\n[Project Root Directory Structure (depth 1)]:\n${JSON.stringify(root_structure, null, 2)}`;
    } catch (e) {
      // Ignore directory structure listing error
    }
  } else {
    context_bonus += `\n\n[System Admin Mode active]`;
  }

  // Add the new user query to the history
  const full_user_prompt = `${user_query}${context_bonus}`;
  history.push({
    role: 'user',
    parts: [{ text: full_user_prompt }]
  });

  // Start the ReAct execution loop
  console.log('\n\x1b[33m⚡ Thinking...\x1b[0m');

  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: model_name,
        contents: history,
        config: {
          systemInstruction: system_prompt,
          tools: [
            { functionDeclarations: tools_declarations },
            { googleSearch: {} }
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: 'AUTO'
            },
            includeServerSideToolInvocations: true
          }
        }
      });

      const candidate = response.candidates?.[0];
      const model_message = candidate?.content;
      if (!model_message) {
        console.log('\x1b[31mNo response received from model.\x1b[0m');
        break;
      }

      // Add model's turn to history
      history.push(model_message);

      // Print any thoughts/explanations the model outputs in this turn
      const text_part = model_message.parts?.find(p => p.text);
      
      const function_calls = model_message.parts?.filter(p => p.functionCall);
      const has_function_calls = function_calls && function_calls.length > 0;

      if (text_part && text_part.text) {
        if (has_function_calls) {
          console.log(`\n\x1b[32m[Thought]\x1b[0m \x1b[2m${text_part.text.trim()}\x1b[0m`);
        } else {
          console.log(`\n\x1b[1m\x1b[32mNono:\x1b[0m ${text_part.text.trim()}\n`);
        }
      }

      if (!has_function_calls) {
        // No functions to call, we have reached the final state
        playSound('complete');
        break;
      }

      // Execute requested functions in parallel
      const response_parts = [];
      const execution_promises = function_calls.map(async (call_part) => {
        const call = call_part.functionCall;
        const { name, args, id } = call;

        console.log(`\x1b[34m⚙️ [Tool Call] Running: ${name}...\x1b[0m`);
        
        const tool_fn = tools_mapping[name];
        let result;
        if (!tool_fn) {
          result = { error: `Tool "${name}" is not implemented.` };
        } else {
          try {
            result = await tool_fn(args);
          } catch (err) {
            result = { error: err.message || String(err) };
          }
        }

        const function_response_part = {
          functionResponse: {
            name,
            response: result
          }
        };
        if (id) {
          function_response_part.functionResponse.id = id;
        }
        return function_response_part;
      });

      const results = await Promise.all(execution_promises);
      response_parts.push(...results);

      // Push user/tool execution results back into the conversation history
      history.push({
        role: 'user',
        parts: response_parts
      });

      // Save intermediate history state
      fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');

    } catch (err) {
      console.error('\x1b[31mError during orchestration loop:\x1b[0m', err.message || err);
      playSound('error');
      break;
    }
  }

  // Save final history state
  fs.writeFileSync(session_path, JSON.stringify(history, null, 2), 'utf8');
}

main().catch(err => {
  console.error('\x1b[31mFatal error:\x1b[0m', err);
  playSound('error');
  process.exit(1);
});
