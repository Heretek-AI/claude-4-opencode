#!/usr/bin/env bash
# Feeds a note back to the model after a specific command runs.
input=$(cat)
if printf '%s' "$input" | jq -e '.tool_input.command | contains("NOTE_ME")' > /dev/null; then
  jq -n '{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "PROBE_POST_CONTEXT: remember to run the tests." } }'
fi
