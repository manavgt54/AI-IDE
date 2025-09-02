#!/usr/bin/env node

// Minimal production startup script
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

console.log('🚀 IDE Backend Production Startup...');

// Create workspace directory if it doesn't exist
const workspaceDir = path.resolve(process.cwd(), 'workspace');
if (!existsSync(workspaceDir)) {
  mkdirSync(workspaceDir, { recursive: true });
  console.log('✅ Workspace directory created');
}

// Set production environment
process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '8000';

console.log('✅ Production startup completed');
console.log(`🌐 Port: ${process.env.PORT}\n`);
