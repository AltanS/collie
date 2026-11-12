#!/bin/sh
# Count the sessions in the facts and print one mark at the end of the Belt.
facts=$(cat)
n=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')
printf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","label":"%s","tone":"plain"}}]}\n' "$n"
