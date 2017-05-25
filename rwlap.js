#!/usr/bin/env node

const readline = require("readline");

const command = process.argv[2];
const completions = [];

const completer = line => {
  const part = line.split(" ").pop();
  if (part.length) {
    const hits = completions
      .filter(c => c.startsWith(part))
      .map(c => c + " ");
    return [hits, part];
  } else {
    return [];
  }
};

const color = "\033[32;m";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: completer,
  prompt: color + command + ">\033[0;m "
});

rl.prompt();

const completify = line => {
  line.match(/[-_.!#$%&@:a-z0-9]+/ig).forEach(term => {
    if (!completions.find(c => c == term)) {
      completions.push(term);
    }
  });
};

const write = (stream, chunk) => {
  readline.clearLine(stream);
  readline.cursorTo(stream, 0);
  stream.write(chunk);
  const line = chunk.toString();
  completify(line);
  const match = line.match(/\033]0;(.*)\007/);
  if (match) {
    rl.setPrompt(color + match[1] + ">\033[0;m ");
  }
  rl.prompt(true);
};

const spawn = require("child_process").spawn;
const child = spawn("sh", ["-c", command]);

child.on("error", err => console.error(err));
child.on("close", code => process.exit(code));

child.stdout.on("data", data => write(process.stdout, data));
child.stderr.on("data", data => write(process.stderr, "\033[30;1;m\0" + data + "\033[0;m"));

rl.on("line", (line) => {
  child.stdin.write(line + "\n");
  rl.prompt();
});

rl.on("close", () => child.stdin.end());

