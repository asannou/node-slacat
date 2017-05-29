
Get Slack token from https://api.slack.com/custom-integrations/legacy-tokens

```
$ export SLACK_TOKEN=xoxp-0000000000-0000000000-000000000000-0123456789abcdef0123456789abcdef
$ export SLACK_HIGHLIGHT='\[@[^\]]+\]|yourname'
$ ./rwlap.js ./client.sh
```

or

```
$ docker run -it --rm -e SLACK_TOKEN -e SLACK_HIGHLIGHT asannou/slacat
```
