#!/bin/sh
# Count the sessions in the facts and print one mark in the belt's end block.
facts=$(cat)
n=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')
printf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","face":"%s","tone":"plain"}}]}\n' "$n"
