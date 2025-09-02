import os
import json
import asyncio
import aiohttp
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
import re
from concurrent.futures import ThreadPoolExecutor
import logging
from gemini_api import GeminiAPI
from config import AGENT_CONFIGS, MAX_CHUNK_SIZE, MAX_FILE_SIZE_FOR_CONTEXT

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class AIAgent:
    name: str
    role: str
    description: str
    system_prompt: str
    model: str = "gemini-2.5-flash"
    max_tokens: int = 4000
    temperature: float = 0.7

class CodeChunker:
    """Handles chunking large code files to avoid token limits"""
    
    def chunk_file(self, content: str, file_path: str) -> List[Dict[str, str]]:
        """Split large files into manageable chunks"""
        if len(content) <= MAX_FILE_SIZE_FOR_CONTEXT:
            return [{"content": content, "path": file_path}]
        
        chunks = []
        lines = content.split('\n')
        current_chunk = []
        current_size = 0
        
        for line in lines:
            line_size = len(line) + 1  # +1 for newline
            if current_size + line_size > MAX_CHUNK_SIZE and current_chunk:
                chunks.append({
                    "content": '\n'.join(current_chunk),
                    "path": f"{file_path} (chunk {len(chunks) + 1})"
                })
                current_chunk = [line]
                current_size = line_size
            else:
                current_chunk.append(line)
                current_size += line_size
        
        if current_chunk:
            chunks.append({
                "content": '\n'.join(current_chunk),
                "path": f"{file_path} (chunk {len(chunks) + 1})"
            })
        
        return chunks

class AIAgentManager:
    """Manages multiple AI agents with different roles"""
    
    def __init__(self, api_key: str, workspace_dir: Path):
        self.api_key = api_key
        self.workspace_dir = workspace_dir
        self.chunker = CodeChunker()
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.gemini_api = GeminiAPI(api_key)
        
        # Initialize AI agents with different roles
        self.agents = {
            "developer": AIAgent(
                name="Code Developer",
                role="developer",
                description="Expert at writing, debugging, and optimizing code",
                system_prompt="""You are an expert software developer. Your role is to:
                - Write clean, efficient, and well-documented code
                - Debug and fix issues in existing code
                - Optimize code performance and readability
                - Follow best practices and coding standards
                - Provide clear explanations for your code changes
                
                Always respond with practical, actionable code solutions.""",
                model="gemini-2.5-flash",
                max_tokens=4000,
                temperature=0.7
            ),
            "architect": AIAgent(
                name="System Architect",
                role="architect", 
                description="Expert at system design, architecture, and code organization",
                system_prompt="""You are a senior system architect. Your role is to:
                - Design and plan system architecture
                - Organize code structure and file organization
                - Plan refactoring and code restructuring
                - Ensure code follows architectural patterns
                - Provide high-level design guidance
                
                Focus on the big picture and system-level improvements.""",
                model="gemini-2.5-flash",
                max_tokens=5000,
                temperature=0.4
            ),
            "reviewer": AIAgent(
                name="Code Reviewer",
                role="reviewer",
                description="Expert at code review, quality assurance, and best practices",
                system_prompt="""You are an expert code reviewer. Your role is to:
                - Review code for bugs, security issues, and performance problems
                - Ensure code follows best practices and coding standards
                - Suggest improvements for readability and maintainability
                - Identify potential technical debt and refactoring opportunities
                - Provide constructive feedback for code improvements
                
                Always be constructive and provide specific, actionable feedback.""",
                model="gemini-2.5-flash",
                max_tokens=4000,
                temperature=0.5
            ),
            "debugger": AIAgent(
                name="Debug Specialist",
                role="debugger",
                description="Expert at debugging, troubleshooting, and problem-solving",
                system_prompt="""You are an expert debugger and problem solver. Your role is to:
                - Analyze error messages and stack traces
                - Identify root causes of bugs and issues
                - Suggest debugging strategies and tools
                - Help fix logical errors and edge cases
                - Provide step-by-step debugging guidance
                
                Focus on practical debugging solutions and prevention strategies.""",
                model="gemini-2.5-flash",
                max_tokens=4000,
                temperature=0.3
            )
        }
    
    async def call_ai_model(self, agent: AIAgent, prompt: str, context: str = "") -> str:
        """Make API call to the Gemini AI model"""
        try:
            # Use the Gemini API based on agent role
            if agent.role == "developer":
                result = await self.gemini_api.generate_code(prompt, agent.model, agent.max_tokens, agent.temperature)
            elif agent.role == "architect":
                result = await self.gemini_api.architect_solution(prompt, context, agent.model)
            elif agent.role == "reviewer":
                result = await self.gemini_api.review_code(context, "general", agent.model)
            elif agent.role == "debugger":
                result = await self.gemini_api.debug_code(context, prompt, agent.model)
            else:
                result = await self.gemini_api.generate_code(prompt, agent.model, agent.max_tokens, agent.temperature)
            
            if result.get("success"):
                return result.get("content", "No content generated")
            else:
                return f"API Error: {result.get('error', 'Unknown error')}"
                
        except Exception as e:
            logger.error(f"Error calling AI model: {e}")
            return f"Error: {str(e)}"
    
    def get_project_context(self, file_paths: Optional[List[str]] = None) -> str:
        """Get project context from files"""
        if not file_paths:
            return "No specific files provided for context"
        
        context_parts = []
        for file_path in file_paths:
            try:
                full_path = self.workspace_dir / file_path
                if full_path.exists() and full_path.is_file():
                    content = full_path.read_text(encoding='utf-8')
                    if len(content) > MAX_FILE_SIZE_FOR_CONTEXT:
                        chunks = self.chunker.chunk_file(content, file_path)
                        for chunk in chunks:
                            context_parts.append(f"File: {chunk['path']}\n```\n{chunk['content']}\n```\n")
                    else:
                        context_parts.append(f"File: {file_path}\n```\n{content}\n```\n")
                else:
                    context_parts.append(f"File: {file_path} (not found)")
            except Exception as e:
                logger.error(f"Error reading file {file_path}: {e}")
                context_parts.append(f"File: {file_path} (error reading: {e})")
        
        return "\n".join(context_parts)
    
    async def process_code_request(self, prompt: str, agent_role: str = "developer", 
                                 file_paths: Optional[List[str]] = None) -> Dict:
        """Process a code request using the specified AI agent"""
        try:
            agent = self.agents.get(agent_role)
            if not agent:
                return {
                    "success": False,
                    "error": f"Unknown agent role: {agent_role}",
                    "agent": "unknown"
                }
            
            # Get project context
            context = self.get_project_context(file_paths)
            
            # Call AI model
            response = await self.call_ai_model(agent, prompt, context)
            
            return {
                "success": True,
                "response": response,
                "agent": agent.name,
                "context_used": bool(file_paths),
                "files_referenced": file_paths or []
            }
            
        except Exception as e:
            logger.error(f"Error processing code request: {e}")
            return {
                "success": False,
                "error": str(e),
                "agent": "unknown"
            }
    
    def get_available_agents(self) -> List[Dict]:
        """Get list of available AI agents"""
        return [
            {
                "id": role,
                "name": agent.name,
                "description": agent.description,
                "model": agent.model
            }
            for role, agent in self.agents.items()
        ]
