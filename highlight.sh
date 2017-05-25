#!/bin/sh

if echo | sed -u '' > /dev/null 2>&1
then
  linebuffered='-u'
  extended='-r'
else
  linebuffered='-l'
  extended='-E'
fi

sed $linebuffered $extended "s/($1)/$(tput setf 4)\1$(tput sgr0)$(printf "\a")/g"

