#!/bin/sh

channel=''
echo '.channel .create .history .activity .threads .restart' >&2

parse() {
  echo "$1$2" | cut -d "$2" -f "$3"
}

parse_command() {
  parse "$1" ' ' 1
}

parse_arg() {
  parse "$1" ' ' 2
}

parse_channel() {
  parse "$1" : 1
}

parse_thread() {
  parse "$1" : 2
}

add_channel() {
  if [ -n "$1" ]
  then
    c=$(echo "$1" | jq -R -c '{ name: . }')
    jq -c --unbuffered ".channel = $c"
  else
    jq -c --unbuffered '.'
  fi
}

add_thread() {
  if [ -n "$1" ]
  then
    t=$(echo "$1" | jq -R -c '. | split(".") | (.[0] | strptime("%y%m%d%H%M%S") | mktime | tostring) + "." + .[1]')
    jq -c --unbuffered ".thread_ts = $t"
  else
    jq -c --unbuffered '.'
  fi
}

while IFS='' read line
do
  command=$(parse_command "$line")
  if [ "$command" = '.channel' ]
  then
    channel=$(parse_arg "$line")
    printf "\033]0;%s\007" "$channel" >&2
  elif [ "$command" = '.create' ]
  then
    c=$(parse_arg "$line")
    c=$(parse_channel "$c")
    [ -z "$c" ] && c=$(parse_channel "$channel")
    jq -n -c --unbuffered '{ type: "channels_create" }' | add_channel "$c"
  elif [ "$command" = '.history' ]
  then
    c=$(parse_arg "$line")
    c=$(parse_channel "$c")
    [ -z "$c" ] && c=$(parse_channel "$channel")
    jq -n -c --unbuffered '{ type: "channels_history" }' | add_channel "$c"
  elif [ "$command" = '.activity' ]
  then
    jq -n -c --unbuffered '{ type: "activity_mentions" }'
  elif [ "$command" = '.threads' ]
  then
    jq -n -c --unbuffered '{ type: "thread_getview" }'
  elif [ "$command" = '.restart' ]
  then
    jq -n -c --unbuffered '{ type: "rtm_start" }'
  else
    c=$(parse_channel "$channel")
    t=$(parse_thread "$channel")
    echo "$line" | jq -R -c --unbuffered '{ type: "message", text: . }' | add_channel "$c" | add_thread "$t"
  fi
done

