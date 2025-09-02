#!/usr/bin/env python3
"""
Test script for terminal executor
Run this to verify the backend terminal is working
"""

import sys
import os
sys.path.append(os.path.dirname(__file__))

from terminal_executor import terminal_executor

def test_basic_commands():
    """Test basic terminal commands"""
    print("Testing terminal executor...")
    
    # Test 1: Simple echo command
    print("\n1. Testing echo command:")
    result = terminal_executor.execute_command({
        "command": "shell",
        "session_id": "test-session-1",
        "command_line": "echo 'Hello World'"
    })
    print(f"Result: {result}")
    
    # Test 2: npm version
    print("\n2. Testing npm -v:")
    result = terminal_executor.execute_command({
        "command": "shell",
        "session_id": "test-session-2",
        "command_line": "npm -v"
    })
    print(f"Result: {result}")
    
    # Test 3: node version
    print("\n3. Testing node -v:")
    result = terminal_executor.execute_command({
        "command": "shell",
        "session_id": "test-session-3",
        "command_line": "node -v"
    })
    print(f"Result: {result}")
    
    # Test 4: python version
    print("\n4. Testing python --version:")
    result = terminal_executor.execute_command({
        "command": "shell",
        "session_id": "test-session-4",
        "command_line": "python --version"
    })
    print(f"Result: {result}")
    
    # Test 5: List files
    print("\n5. Testing list files:")
    result = terminal_executor.execute_command({
        "command": "list_files",
        "cwd": ""
    })
    print(f"Result: {result}")

if __name__ == "__main__":
    test_basic_commands()
