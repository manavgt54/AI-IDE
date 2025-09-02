#!/bin/bash

# Deployment script for IDE Backend
echo "🚀 Starting IDE Backend deployment..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the backend directory."
    exit 1
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf node_modules package-lock.json

# Install dependencies for deployment
echo "📦 Installing dependencies..."
npm install --production --no-optional --ignore-scripts

# Create workspace directory if it doesn't exist
echo "📁 Setting up workspace..."
mkdir -p workspace

# Test the startup script
echo "🧪 Testing startup script..."
if node startup.js; then
    echo "✅ Startup script test passed"
else
    echo "❌ Startup script test failed"
    exit 1
fi

echo "🎉 Deployment preparation completed successfully!"
echo "📋 Next steps:"
echo "   1. Build Docker image: docker build -t ide-backend ."
echo "   2. Run container: docker run -p 8000:8000 ide-backend"
echo "   3. Or deploy to Render using the render.yaml configuration"
