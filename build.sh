#!/bin/bash
#!/bin/bash

echo "🚀 Starting IDE Backend build process..."

# Set environment variables for node-pty compilation
export PYTHON_VERSION=3.9
export PYTHON=/usr/bin/python3
export NPM_CONFIG_PYTHON=/usr/bin/python3
export NODE_ENV=production

echo "📦 Installing dependencies..."
npm install --unsafe-perm --production=false

echo "🔧 Rebuilding node-pty for this environment..."
npm rebuild node-pty --unsafe-perm

echo "✅ Verifying node-pty installation..."
node -e "
try { 
  const pty = require('node-pty'); 
  console.log('✅ node-pty loaded successfully, version:', pty.version); 
} catch(e) { 
  console.error('❌ node-pty failed to load:', e.message); 
  process.exit(1); 
}
"

echo "🏗️ Build completed successfully!"
