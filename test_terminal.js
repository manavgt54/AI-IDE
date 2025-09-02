#!/usr/bin/env node

// Test script to verify terminal functionality
import { execSync } from 'child_process';

console.log('🧪 Testing Terminal Environment...\n');

const tests = [
  {
    name: 'Node.js availability',
    command: 'node --version',
    expected: 'should return Node.js version'
  },
  {
    name: 'npm availability',
    command: 'npm --version',
    expected: 'should return npm version'
  },
  {
    name: 'npx availability',
    command: 'npx --version',
    expected: 'should return npx version'
  },
  {
    name: 'Basic shell commands',
    command: 'echo "Hello World"',
    expected: 'should output "Hello World"'
  },
  {
    name: 'Directory listing',
    command: 'ls -la',
    expected: 'should list directory contents'
  },
  {
    name: 'Current directory',
    command: 'pwd',
    expected: 'should show current working directory'
  },
  {
    name: 'Directory navigation',
    command: 'cd .. && pwd && cd -',
    expected: 'should navigate directories and return to original'
  },
  {
    name: 'File operations',
    command: 'touch test_file.txt && ls test_file.txt && rm test_file.txt',
    expected: 'should create, list, and remove test file'
  },
  {
    name: 'Python availability',
    command: 'python3 --version || python --version',
    expected: 'should return Python version'
  },
  {
    name: 'Git availability',
    command: 'git --version',
    expected: 'should return Git version'
  },
  {
    name: 'Environment variables',
    command: 'echo $PATH',
    expected: 'should show PATH environment variable'
  },
  {
    name: 'Shell features',
    command: 'echo "Test" | grep "Test"',
    expected: 'should demonstrate pipe functionality'
  }
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    console.log(`🔍 Testing: ${test.name}`);
    console.log(`   Command: ${test.command}`);
    
    const result = execSync(test.command, { 
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 5000
    }).trim();
    
    console.log(`   ✅ Result: ${result}`);
    console.log(`   📝 ${test.expected}\n`);
    passed++;
    
  } catch (error) {
    console.log(`   ❌ Failed: ${error.message}`);
    console.log(`   📝 ${test.expected}\n`);
    failed++;
  }
}

console.log('📊 Test Results:');
console.log(`   ✅ Passed: ${passed}`);
console.log(`   ❌ Failed: ${failed}`);
console.log(`   📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

if (failed === 0) {
  console.log('\n🎉 All tests passed! Terminal environment is ready.');
  process.exit(0);
} else {
  console.log('\n⚠️  Some tests failed. Check your environment setup.');
  process.exit(1);
}

