#!/usr/bin/env bash
# Denies writes to .env files through the JSON protocol.
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path')
case "$file" in
  *.env)
    jq -n '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "probe: .env files are read-only" } }'
    ;;
esac
