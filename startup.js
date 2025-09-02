#!/usr/bin/env node

// Startup script to ensure proper environment setup
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

console.log('🚀 IDE Backend Startup Check...');

// Check if Node.js is available
try {
  const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
  console.log(`✅ Node.js version: ${nodeVersion}`);
} catch (error) {
  console.error('❌ Node.js not found in PATH');
  process.exit(1);
}

// Check if npm is available
try {
  const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
  console.log(`✅ npm version: ${npmVersion}`);
} catch (error) {
  console.error('❌ npm not found in PATH');
  process.exit(1);
}

// Check if npx is available
try {
  const npxVersion = execSync('npx --version', { encoding: 'utf8' }).trim();
  console.log(`✅ npx version: ${npxVersion}`);
} catch (error) {
  console.error('❌ npx not found in PATH');
  process.exit(1);
}

// Check workspace directory
const workspaceDir = path.resolve(process.cwd(), 'workspace');
if (!existsSync(workspaceDir)) {
  console.log('📁 Creating workspace directory...');
  try {
    execSync(`mkdir -p "${workspaceDir}"`);
    console.log('✅ Workspace directory created');
  } catch (error) {
    console.error('❌ Failed to create workspace directory:', error.message);
  }
} else {
  console.log('✅ Workspace directory exists');
}

// Check if we're in a container environment
const isContainer = existsSync('/.dockerenv') || process.env.CONTAINER === 'true';
if (isContainer) {
  console.log('🐳 Running in container environment');
  
  // Set environment variables for container
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.PORT = process.env.PORT || '8000';
  
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 Port: ${process.env.PORT}`);
}

// Test basic terminal functionality
console.log('\n🧪 Testing basic terminal functionality...');
try {
  // Test if we can spawn a basic process
  const { spawn } = await import('child_process');
  // Use platform-appropriate command
  const command = process.platform === 'win32' ? 'cmd' : 'echo';
  const args = process.platform === 'win32' ? ['/c', 'echo Hello World'] : ['Hello World'];
  
  const testProcess = spawn(command, args, { stdio: 'pipe' });
  
  testProcess.on('error', (error) => {
    console.error('❌ Basic process spawning failed:', error.message);
    process.exit(1);
  });
  
  testProcess.on('exit', (code) => {
    if (code === 0) {
      console.log('✅ Basic process spawning works');
    } else {
      console.error('❌ Basic process exited with code:', code);
      process.exit(1);
    }
  });
  
  // Kill test process after a short delay
  setTimeout(() => {
    if (!testProcess.killed) {
      testProcess.kill();
    }
  }, 1000);
  
} catch (error) {
  console.error('❌ Failed to test process spawning:', error.message);
  process.exit(1);
}

console.log('✅ Startup check completed successfully');
console.log('🚀 Starting IDE Backend...\n');

