from fastapi import APIRouter, HTTPException, Depends
import logging
from pydantic import BaseModel
from typing import List, Optional
from pathlib import Path
import os
import asyncio
from ai_agents import AIAgentManager
from multi_agent_system import MultiAgentSystem
from config import GEMINI_API_KEY

# Initialize AI Agent Manager with Gemini API
workspace_dir = Path(__file__).resolve().parent / "workspace"
ai_manager = AIAgentManager(GEMINI_API_KEY, workspace_dir)
multi_agent_system = MultiAgentSystem(GEMINI_API_KEY)

router = APIRouter(prefix="/ai", tags=["AI Chatbot"])
logger = logging.getLogger("ide.ai")

class ChatRequest(BaseModel):
    message: str
    mode: str = "ask"  # "ask" or "agent"
    file_paths: Optional[List[str]] = None
    context: Optional[str] = ""

class AgentExecutionRequest(BaseModel):
    user_request: str
    project_name: Optional[str] = "IDE Enhancement"

@router.post("/chat")
async def chat_with_ai(request: ChatRequest):
    """Chat with AI - either simple ask mode or agent execution mode"""
    try:
        logger.info("/ai/chat request: mode=%s, message_len=%d, files=%s", request.mode, len(request.message or ""), request.file_paths)
        if request.mode == "agent":
            # Agent mode: Execute full plan-review-create-debug-review cycle
            resp = await execute_agent_mode(request)
            logger.info("/ai/chat agent response keys: %s", list(resp.keys()) if isinstance(resp, dict) else type(resp))
            return resp
        else:
            # Ask mode: Simple Gemini API response
            resp = await execute_ask_mode(request)
            logger.info("/ai/chat ask response keys: %s", list(resp.keys()) if isinstance(resp, dict) else type(resp))
            return resp
    except Exception as e:
        logger.exception("/ai/chat error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

async def execute_ask_mode(request: ChatRequest):
    """Simple ask mode - direct Gemini API response"""
    try:
        # Use the AI manager for simple chat
        response = await ai_manager.process_code_request(
            request.message, 
            "developer",  # Default agent for simple chat
            request.file_paths
        )
        logger.info("execute_ask_mode response keys: %s", list(response.keys()) if isinstance(response, dict) else type(response))
        return response
    except Exception as e:
        logger.exception("execute_ask_mode error: %s", e)
        return {
            "success": False,
            "error": str(e),
            "mode": "ask"
        }

async def execute_agent_mode(request: ChatRequest):
    """Agent mode - execute intelligent multi-agent development cycle"""
    try:
        # Start the multi-agent system with step-by-step progress
        result = await multi_agent_system.start_project(request.message)
        logger.info("execute_agent_mode result keys: %s", list(result.keys()) if isinstance(result, dict) else type(result))
        
        # Extract created files information
        created_files = []
        if "project_context" in result and "created_files" in result["project_context"]:
            created_files = result["project_context"]["created_files"]
        
        # Build comprehensive response with step-by-step progress
        response_text = f"🤖 **Intelligent Multi-Agent System**\n\n"
        
        if result.get("status") == "success":
            response_text += "✅ **Project created successfully!**\n\n"
            
            # Show step-by-step progress
            step_progress = result.get("project_context", {}).get("step_progress", "")
            if step_progress:
                response_text += f"📊 **Progress Summary:**\n{step_progress}\n\n"
            
            if created_files:
                response_text += "📁 **Created Files:**\n"
                for file_info in created_files:
                    response_text += f"• `{file_info.get('path', 'Unknown')}` - {file_info.get('type', 'Unknown')} ({file_info.get('size', 0)} chars)\n"
                response_text += "\n"
            
            if result.get("run_instructions"):
                response_text += "🚀 **Run Instructions:**\n"
                response_text += f"```\n{result['run_instructions']}\n```\n\n"
            
            # Show agent involvement
            agents_involved = result.get("project_context", {}).get("agents_involved", [])
            if agents_involved:
                response_text += "🤖 **Agents Involved:**\n"
                for agent in agents_involved:
                    response_text += f"• **{agent.title()}**: {_get_agent_description(agent)}\n"
                response_text += "\n"
            
            response_text += "💡 **Next Steps:**\n"
            response_text += "• Files are now available in your workspace\n"
            response_text += "• Use the terminal to run your project\n"
            response_text += "• Check the file explorer to see created files\n"
            response_text += "• Follow the run instructions above\n"
        else:
            response_text += "❌ **Project creation failed**\n\n"
            response_text += f"Error: {result.get('message', 'Unknown error')}\n"
        
        return {
            "success": True,
            "mode": "agent",
            "response": response_text,
            "status": result.get("status", "unknown"),
            "run_instructions": result.get("run_instructions", ""),
            "project_context": result.get("project_context", {}),
            "agent": "Intelligent Multi-Agent System",
            "created_files": created_files,
            "trigger_file_refresh": True  # Signal frontend to refresh files
        }
    except Exception as e:
        logger.exception("execute_agent_mode error: %s", e)
        return {
            "success": False,
            "error": str(e),
            "mode": "agent"
        }

def _get_agent_description(agent: str) -> str:
    """Get description for each agent"""
    descriptions = {
        "planner": "Analyzed requirements and created project plan",
        "architect": "Designed system architecture and file structure", 
        "developer": "Generated all code files with complete implementation",
        "reviewer": "Reviewed and improved code quality",
        "tester": "Validated project and created run instructions"
    }
    return descriptions.get(agent, "Contributed to project creation")

@router.post("/agent/execute")
async def execute_agent_project(request: AgentExecutionRequest):
    """Execute a full agent project"""
    try:
        logger.info("/ai/agent/execute request: message_len=%d", len(request.user_request or ""))
        result = await multi_agent_system.start_project(request.user_request)
        logger.info("/ai/agent/execute result keys: %s", list(result.keys()) if isinstance(result, dict) else type(result))
        return {
            "success": True,
            "status": result.get("status", "unknown"),
            "message": result.get("message", "Project completed"),
            "run_instructions": result.get("run_instructions", ""),
            "project_context": result.get("project_context", {})
        }
    except Exception as e:
        logger.exception("/ai/agent/execute error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/agents")
async def get_available_agents():
    """Get list of available AI agents"""
    try:
        agents = ai_manager.get_available_agents()
        logger.info("/ai/agents count=%d", len(agents) if hasattr(agents, '__len__') else -1)
        return {"agents": agents}
    except Exception as e:
        logger.exception("/ai/agents error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/health")
async def health_check():
    """Health check endpoint"""
    payload = {
        "status": "healthy",
        "api": "Google Gemini",
        "model": "gemini-2.5-flash",
        "modes": ["ask", "agent"],
        "agents_available": len(ai_manager.agents)
    }
    logger.info("/ai/health: %s", payload)
    return payload
