const ansi_regexp = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str) {
  return str.replace(ansi_regexp, '');
}

export class HistoryManager {
  constructor(max_lines = 100) {
    this.max_lines = max_lines;
    this.lines = []; // Array of { text: string, type: string }
    this.current_line = { text: '', type: 'output' };
  }

  clear() {
    this.lines = [];
    this.current_line = { text: '', type: 'output' };
  }

  append(data, type = 'output') {
    const parts = data.split(/\r?\n/);
    if (parts.length === 1) {
      this.current_line.text += parts[0];
      if (this.current_line.text === parts[0]) {
        this.current_line.type = type;
      }
    } else {
      const first_text = this.current_line.text + parts[0];
      const first_type = this.current_line.text ? this.current_line.type : type;
      this.lines.push({ text: first_text, type: first_type });

      for (let i = 1; i < parts.length - 1; i++) {
        this.lines.push({ text: parts[i], type });
      }
      this.current_line = { text: parts[parts.length - 1], type };
    }

    while (this.lines.length > this.max_lines) {
      this.lines.shift();
    }
  }

  clearCommandOutputs() {
    let removed_any = false;
    const new_lines = [];

    for (const line of this.lines) {
      if (line.type === 'output') {
        removed_any = true;
      } else {
        new_lines.push(line);
      }
    }

    if (this.current_line.type === 'output') {
      if (this.current_line.text) {
        removed_any = true;
      }
      this.current_line = { text: '', type: 'output' };
    }

    // Remove trailing empty user prompt if present
    if (new_lines.length > 0) {
      const last_line = new_lines[new_lines.length - 1];
      if (last_line.type === 'command' && !last_line.text.includes('✦')) {
        const text = stripAnsi(last_line.text).trim();
        if (text.endsWith('$') || text.endsWith('#') || text.endsWith('%') || text.endsWith('>')) {
          new_lines.pop();
        }
      }
    }

    this.lines = new_lines;

    if (this.current_line.type === 'command' && !this.current_line.text.includes('✦')) {
      const text = stripAnsi(this.current_line.text).trim();
      if (text.endsWith('$') || text.endsWith('#') || text.endsWith('%') || text.endsWith('>')) {
        this.current_line = { text: '', type: 'output' };
      }
    }

    // If we removed any command outputs, append a single placeholder line at the end
    if (removed_any) {
      this.lines.push({ text: '\x1b[2m[command outputs removed]\x1b[0m', type: 'command' });
    }

    if (this.current_line.type !== 'chat' && this.current_line.type !== 'command') {
      this.current_line = { text: '', type: 'output' };
    }
  }

  getCleanHistory() {
    const all_lines = [...this.lines, this.current_line];
    const clean_lines = all_lines.map(line => stripAnsi(line.text));
    return clean_lines.join('\n');
  }

  getColoredHistory() {
    const all_lines = [...this.lines, this.current_line];
    return all_lines.map(line => line.text).join('\n');
  }
}

