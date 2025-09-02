import os
from pathlib import Path

# Google Gemini API Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.5-flash"

# Model Configuration
DEFAULT_MODEL = GEMINI_MODEL
MAX_TOKENS = 4000
DEFAULT_TEMPERATURE = 0.7

# File Chunking
MAX_CHUNK_SIZE = 3000
MAX_FILE_SIZE_FOR_CONTEXT = 2000

# Workspace Configuration
WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"

# AI Agent Configuration
AGENT_CONFIGS = {
    "developer": {
        "name": "Code Developer",
        "description": "Expert at writing, debugging, and optimizing code",
        "max_tokens": 4000,
        "temperature": 0.7,
        "model": GEMINI_MODEL
    },
    "architect": {
        "name": "System Architect", 
        "description": "Expert at system design, architecture, and code organization",
        "max_tokens": 5000,
        "temperature": 0.4,
        "model": GEMINI_MODEL
    },
    "reviewer": {
        "name": "Code Reviewer",
        "description": "Expert at code review, quality assurance, and best practices",
        "max_tokens": 4000,
        "temperature": 0.5,
        "model": GEMINI_MODEL
    },
    "debugger": {
        "name": "Debug Specialist",
        "description": "Expert at debugging, troubleshooting, and problem-solving",
        "max_tokens": 4000,
        "temperature": 0.3,
        "model": GEMINI_MODEL
    }
}
