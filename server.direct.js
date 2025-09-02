#!/usr/bin/env node

// Direct server start for production (bypasses startup script)
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

console.log('🚀 IDE Backend Direct Start...');

// Quick workspace setup
const workspaceDir = path.resolve(process.cwd(), 'workspace');
if (!existsSync(workspaceDir)) {
  mkdirSync(workspaceDir, { recursive: true });
  console.log('📁 Created workspace directory');
}

// Set environment
process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '8000';

console.log(`✅ Environment set: NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT}`);

// Test node-pty availability before importing server
console.log('🔍 Testing node-pty availability...');
try {
  // Test if node-pty can be loaded
  const pty = await import('node-pty');
  console.log('✅ node-pty loaded successfully');
  
  // Try to create a simple PTY to verify it works
  if (pty.default && typeof pty.default.spawn === 'function') {
    console.log('✅ node-pty.spawn function available');
  } else {
    console.log('⚠️ node-pty.spawn function not available');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ node-pty test failed:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
}

console.log('📦 Starting main server...');

// Start the server directly
try {
  // Import the server file which will start the server
  await import('./server.js');
  console.log('✅ Server started successfully');
} catch (error) {
  console.error('❌ Failed to start server:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
}

console.log('🎉 Server startup completed successfully');
