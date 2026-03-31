#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Serving files at http://127.0.0.1:5500 ..."
python3 -m http.server 5500
