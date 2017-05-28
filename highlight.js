#!/usr/bin/env node
"use strict";

const pattern = new RegExp(process.argv[2], "g");

const highlight = require("stream").Transform({
  transform: function(chunk, encoding, callback) {
    const replacement = match => `\x1b[31m${match}\x1b[0m\x07`;
    this.push(chunk.toString().replace(pattern, replacement));
    callback();
  }
});

process.stdin.pipe(highlight).pipe(process.stdout);

