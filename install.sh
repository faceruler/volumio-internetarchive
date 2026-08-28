#!/bin/bash

echo "Installing volumio-internetarchive plugin dependencies"

# Check for required commands
if ! command -v curl &> /dev/null; then
    echo "curl not found, installing..."
    apt-get update
    apt-get install -y curl
fi

if ! command -v jq &> /dev/null; then
    echo "jq not found, installing..."
    apt-get update
    apt-get install -y jq
fi

# Install npm dependencies
npm install --production

echo "volumio-internetarchive plugin installed successfully"
