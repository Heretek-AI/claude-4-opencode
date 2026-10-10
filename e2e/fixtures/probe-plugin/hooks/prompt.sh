#!/usr/bin/env bash
# Blocks prompts that contain a secret marker; otherwise adds plain-stdout context.
input=$(cat)
if printf '%s' "$input" | jq -e '.prompt | contains("SECRET_TOKEN")' > /dev/null; then
  echo "Prompt contains a secret and was not sent." >&2
  exit 2
fi
echo "PROBE_PROMPT_CONTEXT: the user prefers tabs."
