const ansi_regexp = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str) {
  return str.replace(ansi_regexp, '');
}

export class HistoryManager {
  constructor(max_lines = 100) {
    this.max_lines = max_lines;
    this.lines = [];
    this.current_line = '';
  }

  append(data) {
    const parts = data.split(/\r?\n/);
    if (parts.length === 1) {
      this.current_line += parts[0];
    } else {
      this.lines.push(this.current_line + parts[0]);
      for (let i = 1; i < parts.length - 1; i++) {
        this.lines.push(parts[i]);
      }
      this.current_line = parts[parts.length - 1];
    }

    while (this.lines.length > this.max_lines) {
      this.lines.shift();
    }
  }

  getCleanHistory() {
    const all_lines = [...this.lines, this.current_line];
    const clean_lines = all_lines.map(line => stripAnsi(line));
    return clean_lines.join('\n');
  }
}

