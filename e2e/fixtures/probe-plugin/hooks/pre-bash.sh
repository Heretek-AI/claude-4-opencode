#!/usr/bin/env bash
# Records what the hook was given, blocks one command, and rewrites another.
input=$(cat)
printf '%s\n' "$input" >> "$CLAUDE_PROJECT_DIR/.probe-pre-bash.jsonl"
command=$(printf '%s' "$input" | jq -r '.tool_input.command')
case "$command" in
  *FORBIDDEN*)
    echo "probe: FORBIDDEN commands are blocked by policy" >&2
    exit 2
    ;;
  *REWRITE*)
    jq -n '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo rewritten-by-hook" } } }'
    ;;
esac
