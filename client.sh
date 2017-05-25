#!/bin/sh
./input.sh | ./index.js | ./format.jq | ./highlight.sh '\[@[^]]+\]|yourname'
