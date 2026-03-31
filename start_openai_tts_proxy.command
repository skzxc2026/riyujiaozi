#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Starting OpenAI TTS proxy at http://127.0.0.1:8787 ..."
node openai_tts_proxy.js
