#!/bin/sh

sed -l -E "s/($1)/$(tput setf 4)\1$(tput sgr0)$(echo "\007")/g"
