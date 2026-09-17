#!/bin/sh
set -eu

openai_key_file="${OPENAI_API_KEY_FILE:-/run/t3-credentials/openai-api-key}"
anthropic_key_file="${ANTHROPIC_API_KEY_FILE:-/run/t3-credentials/anthropic-api-key}"
aws_credentials_file="${AWS_SHARED_CREDENTIALS_FILE:-/run/t3-credentials/aws/credentials}"

if [ -n "${OPENAI_API_KEY_FILE:-}" ] && [ ! -r "${openai_key_file}" ]; then
  echo "OPENAI_API_KEY_FILE is not readable: ${openai_key_file}" >&2
  exit 1
fi
if [ -r "${openai_key_file}" ]; then
  OPENAI_API_KEY="$(cat "${openai_key_file}")"
  export OPENAI_API_KEY
fi

if [ -n "${ANTHROPIC_API_KEY_FILE:-}" ] && [ ! -r "${anthropic_key_file}" ]; then
  echo "ANTHROPIC_API_KEY_FILE is not readable: ${anthropic_key_file}" >&2
  exit 1
fi
if [ -r "${anthropic_key_file}" ]; then
  ANTHROPIC_API_KEY="$(cat "${anthropic_key_file}")"
  export ANTHROPIC_API_KEY
fi

if [ -n "${AWS_SHARED_CREDENTIALS_FILE:-}" ] && [ ! -r "${aws_credentials_file}" ]; then
  echo "AWS_SHARED_CREDENTIALS_FILE is not readable: ${aws_credentials_file}" >&2
  exit 1
fi
if [ -r "${aws_credentials_file}" ]; then
  AWS_SHARED_CREDENTIALS_FILE="${aws_credentials_file}"
  export AWS_SHARED_CREDENTIALS_FILE
fi

exec node /opt/t3/dist/bin.mjs "$@"
