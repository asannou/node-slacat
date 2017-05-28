#!/bin/sh
./input.sh | ./index.js | ./format.sh | ./highlight.js '\[@[^\]]+\]|yourname'
