#!/bin/bash

set -e

echo "🚀 OneDrive Photo Service - Setup"
echo "=================================="
echo ""

# Check if tokens.json exists
if [ ! -f "tokens.json" ]; then
  echo "⚠️  tokens.json not found"
  echo ""
  echo "Option 1: Copy from test project (if you have it)"
  echo "  cp ../test/tokens.json ."
  echo ""
  echo "Option 2: Generate new tokens"
  echo "  npm run login --workspace=packages/backend"
  echo ""
  exit 1
fi

echo "✓ Found tokens.json"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "⚠️  Docker not found. Running without Docker..."
  echo ""
  echo "Install dependencies:"
  npm install
  echo ""
  echo "Start PostgreSQL and run services manually:"
  echo "  npm run dev"
  echo ""
else
  echo "✓ Docker found"
  echo ""
  echo "Starting services with docker-compose..."
  docker-compose up -d
  echo ""
  echo "✓ Services started!"
  echo ""
  echo "Web UI:  http://localhost:5173"
  echo "API:     http://localhost:3000/api"
  echo ""
  echo "View logs: docker-compose logs -f backend"
  echo ""
fi
