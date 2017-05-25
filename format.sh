#!/bin/sh

jq -r --unbuffered '
def strfts: (. | tonumber | strftime("%y%m%d%H%M%S")) + (. | split(".") | "." + .[1]);
select(
  (
    .type == "message" and
    .subtype != "message_replied" and
    (
      (.previous_message.text | not) or
      (.previous_message.text != .message.text)
    )
  ) or
  .reply_to
) |
.ts //= (now | tostring) |
.ts = (.ts | strfts) |
.thread_ts //= .reply_to.thread_ts |
.thread_ts = if .thread_ts then ":" + (.thread_ts | strfts) else "" end |
.channel.name //= .reply_to.channel.name |
.user.name //= (.message.user.name // .previous_message.user.name // .bot_id.name) |
.subtype = if .subtype then ":" + .subtype else "" end |
if .text | length == 0 then del(.text) else . end |
.prefix = .error.msg |
.prefix //= .ts + " [" + .channel.name + .thread_ts + "] (" + .user.name + .subtype + ") " |
.prefix as $prefix |
.text // .message.text // .attachments[0].fallback // "" |
split("\n") |
join("\n" + $prefix) |
$prefix + .
'
