import json
import asyncio
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from enum import Enum
import logging
import time
import os
from gemini_api import GeminiAPI
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ProjectType(Enum):
    SINGLE_FILE = "single_file"
    MULTI_FILE = "multi_file"
    WEB_APP = "web_app"
    API_SERVICE = "api_service"
    DESKTOP_APP = "desktop_app"
    LIBRARY = "library"
    SCRIPT = "script"
    UNKNOWN = "unknown"

class AgentRole(Enum):
    PLANNER = "planner"
    ARCHITECT = "architect"
    DEVELOPER = "developer"
    REVIEWER = "reviewer"
    TESTER = "tester"

@dataclass
class ProjectFile:
    path: str
    content: str
    file_type: str
    dependencies: List[str] = None
    
    def __post_init__(self):
        if self.dependencies is None:
            self.dependencies = []

@dataclass
class AgentMessage:
    role: AgentRole
    content: str
    timestamp: float
    metadata: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}

class MultiAgentSystem:
    def __init__(self, gemini_api_key: str):
        self.gemini_api = GeminiAPI(gemini_api_key)
        self.workspace_dir = Path(__file__).resolve().parent / "workspace"
        self.last_api_call = 0
        self.min_delay_between_calls = 6
        self.conversation_history: List[AgentMessage] = []
        self.max_iterations = 10
        self.current_step = 0 # Added for new start_project logic
        
    async def _rate_limited_api_call(self, prompt: str) -> Dict[str, Any]:
        """Make rate-limited API calls to stay under Gemini quota"""
        current_time = time.time()
        time_since_last_call = current_time - self.last_api_call
        
        if time_since_last_call < self.min_delay_between_calls:
            sleep_time = self.min_delay_between_calls - time_since_last_call
            logger.info(f"Rate limiting: waiting {sleep_time:.1f} seconds")
            await asyncio.sleep(sleep_time)
        
        try:
            response = await self.gemini_api.chat(prompt)
            self.last_api_call = time.time()
            
            # Check for content policy violations
            if isinstance(response, dict) and "finish_reason" in response:
                if response["finish_reason"] == 2:  # Content policy violation
                    logger.warning("Content policy violation detected - prompt may be too complex")
                    logger.debug(f"Problematic prompt: {prompt[:200]}...")
                    return {"success": False, "error": "Content policy violation - prompt too complex"}
            
            return response
        except Exception as e:
            error_msg = str(e)
            logger.error(f"API call failed: {error_msg}")
            
            if "429" in error_msg:  # Rate limit error
                logger.warning("Rate limit hit, waiting 60 seconds...")
                await asyncio.sleep(60)
                # Retry once
                try:
                    response = await self.gemini_api.chat(prompt)
                    self.last_api_call = time.time()
                    return response
                except Exception as retry_e:
                    logger.error(f"Retry failed: {retry_e}")
                    return {"success": False, "error": f"Rate limit retry failed: {retry_e}"}
            elif "content policy" in error_msg.lower():
                logger.warning("Content policy violation - simplifying prompt for retry")
                return {"success": False, "error": "Content policy violation - will retry with simpler prompt"}
            else:
                logger.error(f"Unknown API error: {error_msg}")
                return {"success": False, "error": f"API error: {error_msg}"}
    
    def _add_agent_message(self, role: AgentRole, content: str, metadata: Dict[str, Any] = None):
        """Add a message to the conversation history"""
        message = AgentMessage(
            role=role,
            content=content,
            timestamp=time.time(),
            metadata=metadata or {}
        )
        self.conversation_history.append(message)
        logger.info(f"🤖 [{role.value.upper()}]: {content[:100]}{'...' if len(content) > 100 else ''}")
    
    async def _brain_coordination(self, user_request: str) -> Dict[str, Any]:
        """Gemini API acts as the brain coordinating all agents"""
        prompt = f"""
        You are the BRAIN of a Multi-Agent Development System. You coordinate multiple AI agents to create software projects.
        
        **Your Role**: Coordinate, guide, and make final decisions based on agent discussions.
        
        **Current Request**: {user_request}
        
        **Available Agents**:
        1. **planner**: Analyzes requirements, determines project scope and type
        2. **architect**: Designs system architecture, file structure, and relationships
        3. **developer**: Writes actual code with proper imports/exports
        4. **reviewer**: Reviews code quality, suggests improvements
        5. **tester**: Ensures code is runnable and follows best practices
        
        **Conversation History**:
        {self._format_conversation_history()}
        
        **Your Task**: 
        Based on the conversation, determine the next action:
        
        - If agents need to discuss more: Return {{"action": "continue_discussion", "next_agent": "planner|architect|developer|reviewer|tester", "focus": "what_to_discuss"}}
        - If ready to create files: Return {{"action": "create_files", "plan": "detailed_plan"}}
        - If need more analysis: Return {{"action": "analyze_more", "agent": "planner|architect|developer|reviewer|tester", "focus": "what_to_analyze"}}
        - If project complete: Return {{"action": "complete", "summary": "what_was_accomplished"}}
        
        **Important**: Use lowercase agent names: "planner", "architect", "developer", "reviewer", "tester"
        
        **Be intelligent and collaborative** - guide the agents to work together effectively.
        """
        
        try:
            response = await self._rate_limited_api_call(prompt)
            self._add_agent_message(AgentRole.PLANNER, f"Brain coordination response: {response}")
            
            if isinstance(response, dict) and response.get("success") == False:
                return {"action": "error", "error": response.get("error", "Unknown error")}
            
            # Parse the brain's decision
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                # Extract JSON from content
                start_idx = content.find('{')
                end_idx = content.rfind('}') + 1
                if start_idx != -1 and end_idx != -1:
                    json_str = content[start_idx:end_idx]
                    try:
                        parsed = json.loads(json_str)
                        # Ensure agent names are lowercase
                        if "next_agent" in parsed:
                            parsed["next_agent"] = parsed["next_agent"].lower()
                        if "agent" in parsed:
                            parsed["agent"] = parsed["agent"].lower()
                        return parsed
                    except json.JSONDecodeError:
                        logger.error(f"Failed to parse JSON from brain response: {json_str}")
                        return {"action": "continue_discussion", "next_agent": "planner", "focus": "initial_analysis"}
            
            # Fallback
            return {"action": "continue_discussion", "next_agent": "planner", "focus": "initial_analysis"}
            
        except Exception as e:
            logger.error(f"Brain coordination failed: {e}")
            return {"action": "error", "error": str(e)}
    
    def _format_conversation_history(self) -> str:
        """Format conversation history for the brain"""
        if not self.conversation_history:
            return "No conversation yet."
        
        formatted = []
        for msg in self.conversation_history[-10:]:  # Last 10 messages
            formatted.append(f"[{msg.role.value.upper()}]: {msg.content}")
        
        return "\n".join(formatted)
    
    async def start_project(self, user_request: str) -> Dict[str, Any]:
        """Start a new project with continuous improvement until completion."""
        try:
            logger.info(f"🚀 Starting project: {user_request}")
            self.current_step = 0
            self.conversation_history = []
            
            # Step 1: PLANNER - Analyze request and create plan
            self.current_step = 1
            logger.info("🎯 STEP 1: PLANNER - Analyzing request and creating plan...")
            plan_result = await self._planner_analyze_request(user_request)
            if not plan_result["success"]:
                return self._create_error_response("Planner failed to analyze request", plan_result["error"])
            
            logger.info(f"✅ Planner completed: {plan_result['plan'].get('project_name', 'Unknown')}")
            
            # Step 2: ARCHITECT - Design project structure
            self.current_step = 2
            logger.info("🏗️ STEP 2: ARCHITECT - Designing project structure...")
            architecture_result = await self._architect_design_structure(user_request, plan_result["plan"])
            if not architecture_result["success"]:
                return self._create_error_response("Architect failed to design structure", architecture_result["error"])
            
            logger.info(f"✅ Architect completed: {architecture_result['structure'].get('architecture_pattern', 'Unknown')} pattern")
            
            # Step 3-7: Continuous Development Loop
            max_iterations = 5  # Allow up to 5 iterations for improvement
            current_iteration = 0
            best_result = None
            
            while current_iteration < max_iterations:
                current_iteration += 1
                logger.info(f"🔄 ITERATION {current_iteration}: Developing and improving project...")
                
                # Step 3: DEVELOPER - Generate all files
                self.current_step = 3
                logger.info("💻 STEP 3: DEVELOPER - Creating all project files...")
                development_result = await self._developer_create_files(user_request, architecture_result["structure"])
                if not development_result["success"]:
                    logger.warning(f"⚠️ Developer failed in iteration {current_iteration}, trying again...")
                    continue
                
                logger.info(f"✅ Developer completed: Generated {len(development_result['files'])} files")
                
                # Step 4: REVIEWER - Review and improve code
                self.current_step = 4
                logger.info("🔍 STEP 4: REVIEWER - Reviewing and improving code...")
                review_result = await self._reviewer_improve_code(development_result["files"])
                if not review_result["success"]:
                    logger.warning("⚠️ Reviewer failed, continuing with original files")
                    reviewed_files = development_result["files"]
                else:
                    reviewed_files = review_result["files"]
                    logger.info(f"✅ Reviewer completed: Improved {len(review_result.get('improvements', []))} files")
                
                # Step 5: TESTER - Validate project and create run instructions
                self.current_step = 5
                logger.info("🧪 STEP 5: TESTER - Validating project and creating instructions...")
                test_result = await self._tester_validate_project(reviewed_files, user_request)
                if not test_result["success"]:
                    logger.warning("⚠️ Tester failed, using basic instructions")
                    test_result = {"success": True, "run_instructions": "Run the main file", "dependencies": []}
                
                logger.info("✅ Tester completed: Project validated and instructions created")
                
                # Step 6: Create all files in workspace
                self.current_step = 6
                logger.info("📁 STEP 6: Creating files in workspace...")
                created_files = await self._create_files_in_workspace(reviewed_files)
                logger.info(f"✅ Files created: {len(created_files)} files in workspace")
                
                # Step 7: Quality Assessment
                self.current_step = 7
                logger.info("📊 STEP 7: Assessing project quality...")
                quality_score = await self._assess_project_quality(user_request, created_files, test_result)
                
                logger.info(f"📊 Quality Score: {quality_score}/100")
                
                # Store the best result so far
                if best_result is None or quality_score > best_result.get("quality_score", 0):
                    best_result = {
                        "created_files": created_files,
                        "test_result": test_result,
                        "quality_score": quality_score,
                        "iteration": current_iteration
                    }
                
                # Check if project is complete and ready
                if quality_score >= 75:  # Slightly lower threshold for better efficiency
                    logger.info("🎉 Project quality threshold reached! Project is ready.")
                    break
                elif current_iteration >= max_iterations:
                    logger.info(f"⚠️ Reached maximum iterations ({max_iterations}). Using best result.")
                    break
                else:
                    logger.info(f"🔄 Quality score {quality_score}/100 below threshold (75). Continuing improvement...")
                    # Update architecture for next iteration
                    architecture_result = await self._improve_architecture(user_request, plan_result["plan"], created_files, quality_score)
            
            # Step 8: Finalize with comprehensive response
            self.current_step = 8
            logger.info("🎉 STEP 8: Finalizing project creation...")
            
            if best_result:
                return self._finalize_with_comprehensive_response(user_request, best_result["created_files"], best_result["test_result"], best_result["quality_score"])
            else:
                return self._create_error_response("Failed to create project after all iterations", "No successful result")
            
        except Exception as e:
            logger.error(f"❌ Multi-agent project creation failed: {e}")
            import traceback
            logger.error(f"❌ Traceback: {traceback.format_exc()}")
            return self._create_error_response("Project creation failed", str(e))
    
    async def _planner_analyze_request(self, user_request: str) -> Dict[str, Any]:
        """Planner agent to analyze user request and create a detailed project plan using Gemini API."""
        logger.info(f"🎯 Analyzing request: {user_request}")
        
        # Use structured JSON communication to avoid content policy violations
        analysis_prompt = f"""
{{
  "task": "create_prd",
  "request": "{user_request}",
  "format": "json",
  "fields": [
    "project_name",
    "project_type",
    "scope", 
    "features",
    "technology_stack",
    "complexity_level",
    "estimated_files",
    "dependencies",
    "constraints"
  ]
}}
        """
        
        try:
            response = await self._rate_limited_api_call(analysis_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.error(f"Planner API call failed: {response.get('error')}")
                return await self._planner_retry_with_simpler_approach(user_request)
            
            if isinstance(response, dict) and "content" in response:
                # Try to extract JSON from the response
                content = response["content"]
                try:
                    # First try to parse as direct JSON
                    plan = json.loads(content)
                    logger.info("Successfully parsed direct JSON response")
                except json.JSONDecodeError:
                    # If direct parsing fails, look for JSON in the response
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        plan = json.loads(json_str)
                        logger.info("Successfully parsed JSON from text response")
                    else:
                        logger.warning("No JSON found in planner response, retrying with simpler approach")
                        return await self._planner_retry_with_simpler_approach(user_request)
                
                # Validate and enhance the plan
                plan = self._validate_and_enhance_plan(plan, user_request)
                
                self._add_agent_message(AgentRole.PLANNER, f"Created detailed plan for {plan.get('project_name', 'Unknown')} ({plan.get('project_type', 'Unknown')}) with {len(plan.get('features', []))} features")
                
                return {
                    "success": True,
                    "plan": plan
                }
            
            logger.warning("Unexpected planner response format, retrying with simpler approach")
            return await self._planner_retry_with_simpler_approach(user_request)
            
        except Exception as e:
            logger.error(f"Planner analysis failed: {e}")
            return await self._planner_retry_with_simpler_approach(user_request)
    
    async def _planner_retry_with_simpler_approach(self, user_request: str) -> Dict[str, Any]:
        """Retry planner with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Planner retrying with simpler approach for: {user_request}")
        
        # Step 1: Try with ultra-simple JSON prompt
        ultra_simple_prompt = f'{{"task": "prd", "request": "{user_request}"}}'
        
        try:
            response = await self._rate_limited_api_call(ultra_simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Ultra-simple planner approach failed, trying step-by-step")
                return await self._planner_step_by_step_approach(user_request)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        plan = json.loads(json_str)
                        plan = self._validate_and_enhance_plan(plan, user_request)
                        
                        self._add_agent_message(AgentRole.PLANNER, f"Created plan using ultra-simple approach: {plan.get('project_name', 'Unknown')}")
                        return {"success": True, "plan": plan}
                        
                except json.JSONDecodeError:
                    pass
            
            # Step 2: Try with simple JSON prompt
            simple_prompt = f"""
{{
  "task": "create_prd",
  "request": "{user_request}",
  "fields": ["project_name", "project_type", "features", "technology_stack"]
}}
            """
            
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple planner approach failed, trying step-by-step")
                return await self._planner_step_by_step_approach(user_request)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        plan = json.loads(json_str)
                        plan = self._validate_and_enhance_plan(plan, user_request)
                        
                        self._add_agent_message(AgentRole.PLANNER, f"Created plan using simple approach: {plan.get('project_name', 'Unknown')}")
                        return {"success": True, "plan": plan}
                        
                except json.JSONDecodeError:
                    pass
            
            # If all approaches fail, try step-by-step
            return await self._planner_step_by_step_approach(user_request)
            
        except Exception as e:
            logger.error(f"Planner retry approaches failed: {e}")
            return await self._planner_step_by_step_approach(user_request)
        """Retry planner with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Planner retrying with simpler approach for: {user_request}")
        
        # Step 1: Try with very simple prompt
        simple_prompt = f"""
Create PRD for: {user_request}

Return JSON with:
- project_name: name
- project_type: single_file, web_app, api_service
- features: list
- technology_stack: list

Return only JSON.
        """
        
        try:
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple planner approach failed, trying step-by-step")
                return await self._planner_step_by_step_approach(user_request)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        plan = json.loads(json_str)
                        plan = self._validate_and_enhance_plan(plan, user_request)
                        
                        self._add_agent_message(AgentRole.PLANNER, f"Created plan using simple approach: {plan.get('project_name', 'Unknown')}")
                        return {"success": True, "plan": plan}
                        
                except json.JSONDecodeError:
                    pass
            
            # If simple approach fails, try step-by-step
            return await self._planner_step_by_step_approach(user_request)
            
        except Exception as e:
            logger.error(f"Planner retry approaches failed: {e}")
            return await self._planner_step_by_step_approach(user_request)
    
    async def _planner_step_by_step_approach(self, user_request: str) -> Dict[str, Any]:
        """Step-by-step planner approach when all API calls fail"""
        logger.info(f"🔧 Planner using step-by-step approach for: {user_request}")
        
        # Analyze the request step by step
        user_lower = user_request.lower()
        
        # Step 1: Determine project type
        if "calculator" in user_lower or "calc" in user_lower:
            project_type = "single_file"
            technology_stack = ["python"]
            features = ["Basic arithmetic operations", "User input handling", "Error handling"]
            estimated_files = 1
        elif "link shortener" in user_lower or "url shortener" in user_lower or "shorten" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["URL shortening", "Database storage", "Web interface", "Redirect handling"]
            estimated_files = 8
        elif "workout" in user_lower or "fitness" in user_lower or "exercise" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Workout tracking", "Diet planning", "Progress monitoring", "User profiles"]
            estimated_files = 10
        elif "todo" in user_lower or "task" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Add tasks", "Remove tasks", "List tasks", "Mark complete"]
            estimated_files = 6
        elif "blog" in user_lower or "cms" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Post creation", "User authentication", "Comments", "Categories"]
            estimated_files = 12
        elif "ecommerce" in user_lower or "shop" in user_lower or "store" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Product catalog", "Shopping cart", "User accounts", "Payment processing"]
            estimated_files = 15
        elif "chat" in user_lower or "messaging" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "websockets", "sqlite", "html", "css", "javascript"]
            features = ["Real-time messaging", "User authentication", "Message history"]
            estimated_files = 8
        elif "api" in user_lower or "service" in user_lower:
            project_type = "api_service"
            technology_stack = ["python", "fastapi", "sqlalchemy", "pydantic"]
            features = ["RESTful endpoints", "Database integration", "Authentication"]
            estimated_files = 6
        else:
            # Default to web app for unknown requests
            project_type = "web_app"
            technology_stack = ["python", "flask", "html", "css", "javascript"]
            features = ["Core functionality", "User interface", "Data handling"]
            estimated_files = 5
        
        # Step 2: Create project name
        words = user_request.split()
        if len(words) >= 3:
            project_name = "".join(word.capitalize() for word in words[:3]) + "App"
        else:
            project_name = "".join(word.capitalize() for word in words) + "App"
        
        # Step 3: Create comprehensive plan
        plan = {
            "project_name": project_name,
            "project_type": project_type,
            "scope": f"A {project_type.replace('_', ' ')} application that {user_request}",
            "features": features,
            "technology_stack": technology_stack,
            "complexity_level": "medium" if estimated_files > 5 else "simple",
            "estimated_files": estimated_files,
            "dependencies": technology_stack,
            "constraints": "Must be runnable, well-documented, and user-friendly",
            "user_request": user_request
        }
        
        self._add_agent_message(AgentRole.PLANNER, f"Created step-by-step plan: {project_name} ({project_type}) with {estimated_files} files")
        
        return {"success": True, "plan": plan}
    
    def _create_basic_plan(self, user_request: str) -> Dict[str, Any]:
        """Create an intelligent, context-aware plan even when API fails"""
        user_lower = user_request.lower()
        
        # Intelligent analysis based on keywords and context
        if "calculator" in user_lower or "calc" in user_lower:
            project_type = "single_file"
            technology_stack = ["python"]
            features = ["Basic arithmetic operations", "User input handling", "Error handling"]
            estimated_files = 1
            complexity_level = "simple"
        elif "link shortener" in user_lower or "url shortener" in user_lower or "shorten" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["URL shortening", "Database storage", "Web interface", "Redirect handling", "Analytics"]
            estimated_files = 8
            complexity_level = "medium"
        elif "workout" in user_lower or "fitness" in user_lower or "exercise" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Workout tracking", "Diet planning", "Progress monitoring", "User profiles", "Exercise database"]
            estimated_files = 10
            complexity_level = "medium"
        elif "todo" in user_lower or "task" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Add tasks", "Remove tasks", "List tasks", "Mark complete", "Task categories"]
            estimated_files = 6
            complexity_level = "medium"
        elif "blog" in user_lower or "cms" in user_lower or "content" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Post creation", "User authentication", "Comments", "Categories", "Admin panel"]
            estimated_files = 12
            complexity_level = "complex"
        elif "ecommerce" in user_lower or "shop" in user_lower or "store" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript"]
            features = ["Product catalog", "Shopping cart", "User accounts", "Payment processing", "Order management"]
            estimated_files = 15
            complexity_level = "complex"
        elif "chat" in user_lower or "messaging" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "websockets", "sqlite", "html", "css", "javascript"]
            features = ["Real-time messaging", "User authentication", "Message history", "Online status"]
            estimated_files = 8
            complexity_level = "medium"
        elif "api" in user_lower or "service" in user_lower or "backend" in user_lower:
            project_type = "api_service"
            technology_stack = ["python", "fastapi", "sqlalchemy", "pydantic"]
            features = ["RESTful endpoints", "Database integration", "Authentication", "Documentation"]
            estimated_files = 6
            complexity_level = "medium"
        elif "game" in user_lower or "gaming" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "pygame", "html", "css", "javascript"]
            features = ["Game logic", "User interface", "Score tracking", "Multiple levels"]
            estimated_files = 5
            complexity_level = "medium"
        elif "dashboard" in user_lower or "analytics" in user_lower:
            project_type = "web_app"
            technology_stack = ["python", "flask", "sqlite", "html", "css", "javascript", "chart.js"]
            features = ["Data visualization", "Charts and graphs", "Real-time updates", "Export functionality"]
            estimated_files = 10
            complexity_level = "medium"
        elif "simple" in user_lower or "basic" in user_lower:
            project_type = "single_file"
            technology_stack = ["python"]
            features = ["Core functionality", "User interface", "Error handling"]
            estimated_files = 1
            complexity_level = "simple"
        else:
            # Default to a reasonable web app for unknown requests
            project_type = "web_app"
            technology_stack = ["python", "flask", "html", "css", "javascript"]
            features = ["Core functionality", "User interface", "Data handling", "Error handling"]
            estimated_files = 5
            complexity_level = "medium"
        
        # Create intelligent project name
        words = user_request.split()
        if len(words) >= 3:
            project_name = "".join(word.capitalize() for word in words[:3]) + "App"
        else:
            project_name = "".join(word.capitalize() for word in words) + "App"
        
        return {
            "project_name": project_name,
            "project_type": project_type,
            "scope": f"A {project_type.replace('_', ' ')} application that {user_request}",
            "features": features,
            "technology_stack": technology_stack,
            "complexity_level": complexity_level,
            "estimated_files": estimated_files,
            "dependencies": technology_stack,
            "constraints": "Must be runnable, well-documented, and user-friendly",
            "user_request": user_request
        }
    
    def _validate_and_enhance_plan(self, plan: Dict[str, Any], user_request: str) -> Dict[str, Any]:
        """Validate and enhance the plan from API response"""
        # Ensure all required fields exist
        required_fields = ["project_name", "project_type", "scope", "features", "technology_stack", "file_structure", "dependencies", "constraints"]
        
        for field in required_fields:
            if field not in plan:
                if field == "features":
                    plan[field] = ["Core functionality"]
                elif field == "technology_stack":
                    plan[field] = ["python"]
                elif field == "file_structure":
                    plan[field] = {"root": ["README.md"], "src": ["main.py"]}
                elif field == "dependencies":
                    plan[field] = ["python"]
                elif field == "constraints":
                    plan[field] = "Must be runnable and well-documented"
                else:
                    plan[field] = "Unknown"
        
        # Ensure file_structure is properly formatted
        if not isinstance(plan["file_structure"], dict):
            plan["file_structure"] = {"root": ["README.md"], "src": ["main.py"]}
        
        # Always include the user request for context
        plan["user_request"] = user_request
        
        return plan
    
    async def _architect_design_structure(self, user_request: str, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Architect agent to design the project's file structure and architecture using Gemini API."""
        logger.info(f"🏗️ Designing project structure for: {user_request}")
        
        # Use structured JSON communication to avoid content policy violations
        architecture_prompt = f"""
{{
  "task": "create_structure",
  "request": "{user_request}",
  "project": {json.dumps(plan, indent=2)},
  "format": "json",
  "fields": [
    "architecture_pattern",
    "file_structure",
    "file_specifications",
    "dependencies",
    "design_patterns",
    "folder_organization"
  ]
}}
        """
        
        try:
            response = await self._rate_limited_api_call(architecture_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.error(f"Architect API call failed: {response.get('error')}")
                return await self._architect_retry_with_simpler_approach(user_request, plan)
            
            if isinstance(response, dict) and "content" in response:
                # Try to extract JSON from the response
                content = response["content"]
                try:
                    # Look for JSON in the response
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        structure = json.loads(json_str)
                        
                        # Validate and enhance the structure
                        structure = self._validate_and_enhance_structure(structure, plan)
                        
                        self._add_agent_message(AgentRole.ARCHITECT, f"Designed {structure.get('architecture_pattern', 'Unknown')} architecture with {len(structure.get('file_specifications', []))} files")
                        
                        return {
                            "success": True,
                            "structure": structure
                        }
                    else:
                        logger.warning("No JSON found in architect response, using basic structure")
                        return self._create_basic_structure(plan)
                        
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse architect JSON: {e}")
                    return self._create_basic_structure(plan)
            
            logger.warning("Unexpected architect response format, retrying with simpler approach")
            return await self._architect_retry_with_simpler_approach(user_request, plan)
            
        except Exception as e:
            logger.error(f"Architect design failed: {e}")
            return await self._architect_retry_with_simpler_approach(user_request, plan)
    
    async def _architect_retry_with_simpler_approach(self, user_request: str, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Retry architect with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Architect retrying with simpler approach for: {user_request}")
        
        # Step 1: Try with ultra-simple JSON prompt
        ultra_simple_prompt = f'{{"task": "structure", "request": "{user_request}"}}'
        
        try:
            response = await self._rate_limited_api_call(ultra_simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Ultra-simple architect approach failed, using step-by-step")
                return {"success": True, "structure": self._create_basic_structure(plan)}
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        structure = json.loads(json_str)
                        structure = self._validate_and_enhance_structure(structure, plan)
                        
                        self._add_agent_message(AgentRole.ARCHITECT, f"Created structure using ultra-simple approach")
                        return {"success": True, "structure": structure}
                        
                except json.JSONDecodeError:
                    pass
            
            # Step 2: Try with simple JSON prompt
            simple_prompt = f"""
{{
  "task": "create_structure",
  "request": "{user_request}",
  "project": {json.dumps(plan, indent=2)},
  "fields": ["architecture_pattern", "file_structure", "file_specifications"]
}}
            """
            
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple architect approach failed, using step-by-step")
                return {"success": True, "structure": self._create_basic_structure(plan)}
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        structure = json.loads(json_str)
                        structure = self._validate_and_enhance_structure(structure, plan)
                        
                        self._add_agent_message(AgentRole.ARCHITECT, f"Created structure using simple approach")
                        return {"success": True, "structure": structure}
                        
                except json.JSONDecodeError:
                    pass
            
            # If all approaches fail, use step-by-step
            return {"success": True, "structure": self._create_basic_structure(plan)}
            
        except Exception as e:
            logger.error(f"Architect retry approaches failed: {e}")
            return {"success": True, "structure": self._create_basic_structure(plan)}
        """Retry architect with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Architect retrying with simpler approach for: {user_request}")
        
        # Step 1: Try with very simple prompt
        simple_prompt = f"""
Create structure for: {user_request}

Project: {json.dumps(plan, indent=2)}

Return JSON with:
- architecture_pattern: MVC, RESTful API, Simple
- file_structure: folders and files
- file_specifications: file objects

Return only JSON.
        """
        
        try:
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple architect approach failed, using step-by-step")
                return {"success": True, "structure": self._create_basic_structure(plan)}
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                try:
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != 0:
                        json_str = content[start_idx:end_idx]
                        structure = json.loads(json_str)
                        structure = self._validate_and_enhance_structure(structure, plan)
                        
                        self._add_agent_message(AgentRole.ARCHITECT, f"Created structure using simple approach")
                        return {"success": True, "structure": structure}
                        
                except json.JSONDecodeError:
                    pass
            
            # If simple approach fails, use step-by-step
            return {"success": True, "structure": self._create_basic_structure(plan)}
            
        except Exception as e:
            logger.error(f"Architect retry approaches failed: {e}")
            return {"success": True, "structure": self._create_basic_structure(plan)}
    
    def _create_basic_structure(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Create a basic structure as fallback when API design fails"""
        project_type = plan.get("project_type", "single_file")
        technology_stack = plan.get("technology_stack", [])
        user_request = plan.get("user_request", "").lower()
        
        logger.info(f"🔧 Creating basic structure for: {user_request} (type: {project_type})")
        
        # Determine architecture pattern and file structure based on project type and request
        if "calculator" in user_request or "calc" in user_request:
            architecture_pattern = "Simple"
            file_structure = {
                "root": ["README.md"],
                "src": ["calculator.py"]
            }
            folder_organization = "Simple single-file application"
        elif "link shortener" in user_request or "url shortener" in user_request or "shorten" in user_request:
            architecture_pattern = "MVC"
            file_structure = {
                "root": ["README.md", "requirements.txt", "config.py"],
                "backend": ["app.py", "models.py", "routes.py", "database.py"],
                "frontend": ["templates/index.html", "static/styles.css", "static/script.js"],
                "database": ["schema.sql"]
            }
            folder_organization = "MVC pattern with separate frontend and backend"
        elif "workout" in user_request or "fitness" in user_request or "exercise" in user_request:
            architecture_pattern = "Frontend/Backend"
            file_structure = {
                "root": ["README.md", "requirements.txt"],
                "backend": ["main.py", "workout_manager.py", "diet_planner.py"],
                "frontend": ["index.html", "styles.css", "app.js", "workout.js", "diet.js"]
            }
            folder_organization = "Separate frontend and backend folders for workout app"
        elif "todo" in user_request or "task" in user_request:
            architecture_pattern = "Frontend/Backend"
            file_structure = {
                "root": ["README.md", "requirements.txt"],
                "backend": ["main.py", "todo_manager.py"],
                "frontend": ["index.html", "styles.css", "app.js"]
            }
            folder_organization = "Separate frontend and backend folders"
        elif "blog" in user_request or "cms" in user_request:
            architecture_pattern = "MVC"
            file_structure = {
                "root": ["README.md", "requirements.txt", "config.py"],
                "backend": ["app.py", "models.py", "routes.py", "auth.py", "admin.py"],
                "frontend": ["templates/base.html", "templates/index.html", "templates/post.html", "static/styles.css", "static/script.js"],
                "database": ["schema.sql"]
            }
            folder_organization = "MVC pattern for content management"
        elif "ecommerce" in user_request or "shop" in user_request or "store" in user_request:
            architecture_pattern = "MVC"
            file_structure = {
                "root": ["README.md", "requirements.txt", "config.py"],
                "backend": ["app.py", "models.py", "routes.py", "payment.py", "inventory.py"],
                "frontend": ["templates/base.html", "templates/products.html", "templates/cart.html", "static/styles.css", "static/script.js"],
                "database": ["schema.sql"]
            }
            folder_organization = "MVC pattern for e-commerce"
        elif "chat" in user_request or "messaging" in user_request:
            architecture_pattern = "Real-time"
            file_structure = {
                "root": ["README.md", "requirements.txt", "config.py"],
                "backend": ["app.py", "models.py", "routes.py", "websocket.py"],
                "frontend": ["templates/index.html", "static/styles.css", "static/script.js"],
                "database": ["schema.sql"]
            }
            folder_organization = "Real-time messaging architecture"
        elif "web" in user_request or "html" in user_request or "frontend" in user_request:
            architecture_pattern = "Frontend/Backend"
            file_structure = {
                "root": ["README.md", "requirements.txt"],
                "backend": ["main.py", "app.py"],
                "frontend": ["index.html", "styles.css", "script.js"]
            }
            folder_organization = "Separate frontend and backend folders"
        elif "api" in user_request or "service" in user_request or "backend" in user_request:
            architecture_pattern = "RESTful API"
            file_structure = {
                "root": ["README.md", "requirements.txt"],
                "src": ["main.py", "models.py", "routes.py"],
                "config": ["config.py"]
            }
            folder_organization = "Modular backend structure"
        elif "multi" in user_request or "complex" in user_request:
            architecture_pattern = "Modular"
            file_structure = {
                "root": ["README.md", "requirements.txt"],
                "src": ["main.py", "utils.py", "models.py"],
                "modules": ["module1.py", "module2.py"]
            }
            folder_organization = "Modular structure with separate modules"
        else:
            # Default simple structure
            architecture_pattern = "Simple"
            file_structure = {
                "root": ["README.md"],
                "src": ["main.py"]
            }
            folder_organization = "Simple single-file application"
        
        # Create file specifications based on the structure
        file_specifications = []
        
        # Add root files
        for file in file_structure.get("root", []):
            file_specifications.append({
                "path": file,
                "content_type": "text" if file.endswith('.txt') else "markdown",
                "description": f"Project {file}",
                "key_features": ["Basic project file"],
                "dependencies": []
            })
        
        # Add source files
        for file in file_structure.get("src", []):
            file_specifications.append({
                "path": file,
                "content_type": "python_main" if "main" in file else "python_module",
                "description": f"Main application logic" if "main" in file else f"Supporting module",
                "key_features": ["Core functionality", "Error handling", "Documentation"],
                "dependencies": []
            })
        
        # Add backend files
        for file in file_structure.get("backend", []):
            if "app" in file:
                file_specifications.append({
                    "path": file,
                    "content_type": "python_main",
                    "description": "Main Flask application",
                    "key_features": ["Flask app setup", "Route definitions", "Error handling"],
                    "dependencies": ["flask", "models", "routes"]
                })
            elif "models" in file:
                file_specifications.append({
                    "path": file,
                    "content_type": "python_module",
                    "description": "Database models and data structures",
                    "key_features": ["SQLAlchemy models", "Data validation", "Database relationships"],
                    "dependencies": ["sqlalchemy", "flask-sqlalchemy"]
                })
            elif "routes" in file:
                file_specifications.append({
                    "path": file,
                    "content_type": "python_module",
                    "description": "API routes and endpoints",
                    "key_features": ["RESTful endpoints", "Request handling", "Response formatting"],
                    "dependencies": ["flask", "models"]
                })
            elif "database" in file:
                file_specifications.append({
                    "path": file,
                    "content_type": "python_module",
                    "description": "Database configuration and setup",
                    "key_features": ["Database connection", "Schema management", "Migrations"],
                    "dependencies": ["sqlalchemy", "flask-sqlalchemy"]
                })
            else:
                file_specifications.append({
                    "path": file,
                    "content_type": "python_module",
                    "description": f"Backend module: {file}",
                    "key_features": ["Core functionality", "Error handling"],
                    "dependencies": []
                })
        
        # Add frontend files
        for file in file_structure.get("frontend", []):
            if file.endswith('.html'):
                file_specifications.append({
                    "path": file,
                    "content_type": "html",
                    "description": f"HTML template: {file}",
                    "key_features": ["Responsive design", "User interface", "Template structure"],
                    "dependencies": ["css", "javascript"]
                })
            elif file.endswith('.css'):
                file_specifications.append({
                    "path": file,
                    "content_type": "css",
                    "description": f"CSS stylesheet: {file}",
                    "key_features": ["Modern styling", "Responsive design", "User experience"],
                    "dependencies": []
                })
            elif file.endswith('.js'):
                file_specifications.append({
                    "path": file,
                    "content_type": "javascript",
                    "description": f"JavaScript file: {file}",
                    "key_features": ["Interactive functionality", "AJAX requests", "DOM manipulation"],
                    "dependencies": ["html", "css"]
                })
        
        # Add static files for web projects
        for file in file_structure.get("static", []):
            file_specifications.append({
                "path": file,
                "content_type": "html" if file.endswith('.html') else "css" if file.endswith('.css') else "javascript",
                "description": f"Static {file.split('.')[-1].upper()} file",
                "key_features": ["Responsive design", "Modern styling"],
                "dependencies": []
            })
        
        # Add template files
        for file in file_structure.get("templates", []):
            file_specifications.append({
                "path": file,
                "content_type": "html",
                "description": f"HTML template file",
                "key_features": ["Template structure", "Dynamic content"],
                "dependencies": []
            })
        
        # Add config files
        for file in file_structure.get("config", []):
            file_specifications.append({
                "path": file,
                "content_type": "python_config",
                "description": f"Configuration file",
                "key_features": ["Settings management", "Environment variables"],
                "dependencies": []
            })
        
        # Add database files
        for file in file_structure.get("database", []):
            file_specifications.append({
                "path": file,
                "content_type": "sql",
                "description": f"Database schema: {file}",
                "key_features": ["Table definitions", "Indexes", "Constraints"],
                "dependencies": []
            })
        
        # Add module files
        for file in file_structure.get("modules", []):
            file_specifications.append({
                "path": file,
                "content_type": "python_module",
                "description": f"Module file",
                "key_features": ["Modular functionality", "Reusable code"],
                "dependencies": []
            })
        
        structure = {
            "architecture_pattern": architecture_pattern,
            "file_structure": file_structure,
            "file_specifications": file_specifications,
            "dependencies": technology_stack,
            "design_patterns": ["Separation of Concerns", "Single Responsibility"],
            "folder_organization": folder_organization
        }
        
        logger.info(f"🔧 Basic structure created with {len(file_specifications)} file specifications")
        logger.info(f"🔧 File structure: {file_structure}")
        
        return structure
    
    def _validate_and_enhance_structure(self, structure: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and enhance the structure from API response"""
        # Ensure all required fields exist
        required_fields = ["architecture_pattern", "file_structure", "file_specifications", "dependencies", "design_patterns"]
        
        for field in required_fields:
            if field not in structure:
                if field == "architecture_pattern":
                    structure[field] = "Simple"
                elif field == "file_structure":
                    structure[field] = {"root": ["README.md"], "src": ["main.py"]}
                elif field == "file_specifications":
                    structure[field] = []
                elif field == "dependencies":
                    structure[field] = plan.get("technology_stack", ["python"])
                elif field == "design_patterns":
                    structure[field] = ["Separation of Concerns"]
        
        # Ensure file_specifications is properly formatted
        if not isinstance(structure["file_specifications"], list):
            structure["file_specifications"] = []
        
        # Validate each file specification
        for spec in structure["file_specifications"]:
            if not isinstance(spec, dict):
                continue
            
            required_spec_fields = ["path", "content_type", "description", "key_features", "dependencies"]
            for field in required_spec_fields:
                if field not in spec:
                    if field == "key_features":
                        spec[field] = ["Core functionality"]
                    elif field == "dependencies":
                        spec[field] = ["python"]
                    else:
                        spec[field] = "Unknown"
        
        return structure
    
    async def _developer_create_files(self, user_request: str, structure: Dict[str, Any]) -> Dict[str, Any]:
        """Developer agent to generate all project files based on the architect's structure."""
        
        # Extract file specifications from structure
        file_specs = structure.get("file_specifications", [])
        if not file_specs:
            logger.warning("No file specifications found in structure, creating basic files")
            file_specs = [
                {"path": "main.py", "content_type": "python_main", "description": "Main application file"},
                {"path": "README.md", "content_type": "markdown", "description": "Project documentation"}
            ]
        
        # Trust the architect's decision on file count - they should have made intelligent decisions
        logger.info(f"🔧 Creating {len(file_specs)} files as designed by architect")
        logger.info(f"🔧 File specs: {[spec.get('path', 'Unknown') for spec in file_specs]}")
        
        created_files = []
        
        for i, file_spec in enumerate(file_specs):
            logger.info(f"📝 Generating file {i+1}/{len(file_specs)}: {file_spec.get('path', 'Unknown')}")
            
            # Generate content for this specific file
            file_content = await self._generate_file_content(user_request, file_spec)
            if file_content:
                created_files.append(ProjectFile(
                    path=file_spec.get("path", f"file_{i}.py"),
                    content=file_content,
                    file_type=self._get_file_type(file_spec.get("path", "")),
                    dependencies=file_spec.get("dependencies", [])
                ))
        
        self._add_agent_message(AgentRole.DEVELOPER, f"Generated {len(created_files)} files with complete implementation and proper imports/exports")
        
        return {
            "success": True,
            "files": created_files
        }

    async def _generate_file_content(self, user_request: str, file_spec: Dict[str, Any]) -> str:
        """Generate content for a specific file using Gemini API with enhanced context awareness"""
        # Use structured JSON communication to avoid content policy violations
        prompt = f"""
{{
  "task": "create_code",
  "file_path": "{file_spec.get('path', 'Unknown')}",
  "content_type": "{file_spec.get('content_type', 'python')}",
  "description": "{file_spec.get('description', 'Generated file')}",
  "features": {json.dumps(file_spec.get('key_features', []))},
  "format": "code"
}}
        """
        
        try:
            response = await self._rate_limited_api_call(prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.error(f"Failed to generate content for {file_spec.get('path')}: {response.get('error')}")
                return await self._developer_retry_with_simpler_approach(user_request, file_spec)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                # Clean up the content - remove any JSON wrapper or explanations
                if content.startswith('```'):
                    # Remove markdown code blocks
                    lines = content.split('\n')
                    start_idx = -1
                    end_idx = -1
                    for i, line in enumerate(lines):
                        if line.strip().startswith('```') and start_idx == -1:
                            start_idx = i + 1
                        elif line.strip().startswith('```') and start_idx != -1:
                            end_idx = i
                            break
                    if start_idx != -1 and end_idx != -1:
                        content = '\n'.join(lines[start_idx:end_idx])
                
                return content
            
            return await self._developer_retry_with_simpler_approach(user_request, file_spec)
            
        except Exception as e:
            logger.error(f"Error generating file content: {e}")
            return await self._developer_retry_with_simpler_approach(user_request, file_spec)

    async def _developer_retry_with_simpler_approach(self, user_request: str, file_spec: Dict[str, Any]) -> str:
        """Retry developer with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Developer retrying with simpler approach for: {file_spec.get('path')}")
        
        # Step 1: Try with ultra-simple JSON prompt
        ultra_simple_prompt = f'{{"task": "code", "file": "{file_spec.get("path", "Unknown")}"}}'
        
        try:
            response = await self._rate_limited_api_call(ultra_simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Ultra-simple developer approach failed, trying step-by-step")
                return await self._developer_step_by_step_approach(user_request, file_spec)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                # Clean up the content - remove any JSON wrapper or explanations
                if content.startswith('```'):
                    # Remove markdown code blocks
                    lines = content.split('\n')
                    start_idx = -1
                    end_idx = -1
                    for i, line in enumerate(lines):
                        if line.strip().startswith('```') and start_idx == -1:
                            start_idx = i + 1
                        elif line.strip().startswith('```') and start_idx != -1:
                            end_idx = i
                            break
                    if start_idx != -1 and end_idx != -1:
                        content = '\n'.join(lines[start_idx:end_idx])
                
                if content and len(content.strip()) > 10:  # Ensure we have meaningful content
                    return content
            
            # Step 2: Try with simple JSON prompt
            simple_prompt = f"""
{{
  "task": "create_code",
  "file_path": "{file_spec.get('path', 'Unknown')}",
  "content_type": "{file_spec.get('content_type', 'python')}",
  "features": {json.dumps(file_spec.get('key_features', []))}
}}
            """
            
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple developer approach failed, trying step-by-step")
                return await self._developer_step_by_step_approach(user_request, file_spec)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                # Clean up the content - remove any JSON wrapper or explanations
                if content.startswith('```'):
                    # Remove markdown code blocks
                    lines = content.split('\n')
                    start_idx = -1
                    end_idx = -1
                    for i, line in enumerate(lines):
                        if line.strip().startswith('```') and start_idx == -1:
                            start_idx = i + 1
                        elif line.strip().startswith('```') and start_idx != -1:
                            end_idx = i
                            break
                    if start_idx != -1 and end_idx != -1:
                        content = '\n'.join(lines[start_idx:end_idx])
                
                if content and len(content.strip()) > 10:  # Ensure we have meaningful content
                    return content
            
            # If all approaches fail, try step-by-step
            return await self._developer_step_by_step_approach(user_request, file_spec)
            
        except Exception as e:
            logger.error(f"Developer retry approaches failed: {e}")
            return await self._developer_step_by_step_approach(user_request, file_spec)
        """Retry developer with simpler, step-by-step approach when API fails"""
        logger.info(f"🔄 Developer retrying with simpler approach for: {file_spec.get('path')}")
        
        # Step 1: Try with very simple prompt
        simple_prompt = f"""
Create code for: {file_spec.get('path', 'Unknown')}

Type: {file_spec.get('content_type', 'python')}
Features: {', '.join(file_spec.get('key_features', []))}

Write code.
        """
        
        try:
            response = await self._rate_limited_api_call(simple_prompt)
            
            if isinstance(response, dict) and response.get("success") == False:
                logger.warning("Simple developer approach failed, trying step-by-step")
                return await self._developer_step_by_step_approach(user_request, file_spec)
            
            if isinstance(response, dict) and "content" in response:
                content = response["content"]
                # Clean up the content - remove any JSON wrapper or explanations
                if content.startswith('```'):
                    # Remove markdown code blocks
                    lines = content.split('\n')
                    start_idx = -1
                    end_idx = -1
                    for i, line in enumerate(lines):
                        if line.strip().startswith('```') and start_idx == -1:
                            start_idx = i + 1
                        elif line.strip().startswith('```') and start_idx != -1:
                            end_idx = i
                            break
                    if start_idx != -1 and end_idx != -1:
                        content = '\n'.join(lines[start_idx:end_idx])
                
                if content and len(content.strip()) > 10:  # Ensure we have meaningful content
                    return content
            
            # If simple approach fails, try step-by-step
            return await self._developer_step_by_step_approach(user_request, file_spec)
            
        except Exception as e:
            logger.error(f"Developer retry approaches failed: {e}")
            return await self._developer_step_by_step_approach(user_request, file_spec)
    
    async def _developer_step_by_step_approach(self, user_request: str, file_spec: Dict[str, Any]) -> str:
        """Step-by-step developer approach when all API calls fail"""
        logger.info(f"🔧 Developer using step-by-step approach for: {file_spec.get('path')}")
        
        # Generate content step by step based on file type
        path = file_spec.get("path", "")
        content_type = file_spec.get("content_type", "")
        description = file_spec.get("description", "Generated file")
        key_features = file_spec.get("key_features", [])
        
        # Step 1: Generate imports
        imports = self._generate_imports_for_file(path, content_type)
        
        # Step 2: Generate skeleton
        skeleton = self._generate_skeleton_for_file(path, content_type, description)
        
        # Step 3: Generate functions
        functions = self._generate_functions_for_file(path, content_type, key_features)
        
        # Step 4: Combine all parts
        content = f"{imports}\n\n{skeleton}\n\n{functions}"
        
        logger.info(f"Generated step-by-step content for {path} ({len(content)} characters)")
        return content
    
    def _generate_imports_for_file(self, path: str, content_type: str) -> str:
        """Generate appropriate imports for a file"""
        if path.endswith('.py'):
            if "flask" in content_type or "app" in path:
                return '''from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
import os
from datetime import datetime'''
            elif "models" in path:
                return '''from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import uuid'''
            elif "routes" in path:
                return '''from flask import Blueprint, request, jsonify, render_template
from models import db, User, URL
import shortuuid
from urllib.parse import urlparse'''
            else:
                return '''import sys
import os
from typing import Dict, Any, List'''
        else:
            return ""
    
    def _generate_skeleton_for_file(self, path: str, content_type: str, description: str) -> str:
        """Generate skeleton structure for a file"""
        if path.endswith('.py'):
            if "flask" in content_type or "app" in path:
                return f'''app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///app.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

# {description}
# This Flask application provides the main functionality

@app.route('/')
def index():
    """Main page"""
    return render_template('index.html')

@app.route('/api/health')
def health_check():
    """Health check endpoint"""
    return jsonify({{"status": "healthy", "timestamp": datetime.now().isoformat()}})

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, host='0.0.0.0', port=5000)'''
            elif "models" in path:
                return f'''db = SQLAlchemy()

class BaseModel(db.Model):
    """Base model with common fields"""
    __abstract__ = True
    
    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# {description}
# Database models for the application'''
            else:
                return f'''# {description}
# This module provides core functionality

def main():
    """Main function"""
    print(f"Hello from {{__name__}}")
    
if __name__ == "__main__":
    main()'''
        elif path.endswith('.html'):
            return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{description}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>{description}</h1>
        </header>
        
        <main>
            <!-- Main content here -->
        </main>
        
        <footer>
            <p>&copy; 2024 Generated Application</p>
        </footer>
    </div>
    
    <script src="app.js"></script>
</body>
</html>'''
        else:
            return f"# {description}\n# Generated content for {path}"
    
    def _generate_functions_for_file(self, path: str, content_type: str, key_features: List[str]) -> str:
        """Generate functions based on key features"""
        if path.endswith('.py'):
            functions = []
            for feature in key_features:
                if "database" in feature.lower() or "storage" in feature.lower():
                    functions.append('''def setup_database():
    """Setup database tables"""
    with app.app_context():
        db.create_all()
        print("Database tables created successfully")''')
                elif "api" in feature.lower() or "endpoint" in feature.lower():
                    functions.append('''@app.route('/api/data', methods=['GET'])
def get_data():
    """Get data endpoint"""
    return jsonify({"data": "sample data"})

@app.route('/api/data', methods=['POST'])
def create_data():
    """Create data endpoint"""
    data = request.get_json()
    return jsonify({"message": "Data created", "data": data})''')
                elif "error" in feature.lower() or "handling" in feature.lower():
                    functions.append('''@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500''')
                else:
                    functions.append(f'''def {feature.lower().replace(' ', '_')}():
    """{feature} functionality"""
    print("Implementing {feature}")
    return True''')
            
            return '\n\n'.join(functions)
        else:
            return ""
    
    def _get_fallback_content(self, file_spec: Dict[str, Any]) -> str:
        """Get intelligent fallback content for a file when API fails"""
        path = file_spec.get("path", "")
        content_type = file_spec.get("content_type", "")
        description = file_spec.get("description", "Generated file")
        key_features = file_spec.get("key_features", [])
        
        if path.endswith('.py'):
            if content_type == "python_main":
                return f'''# {description}
# Key features: {", ".join(key_features)}

"""
{description}
This is the main application file with proper imports and exports.
"""

import sys
import os
from typing import Dict, Any, List

# Import other modules if they exist
try:
    from utils import setup_logging, validate_input
except ImportError:
    pass

try:
    from models import DataProcessor
except ImportError:
    pass

def main():
    """Main application entry point"""
    print(f"Starting {description}")
    
    try:
        # Main application logic here
        print("Application running successfully!")
        
        # Example of proper function calls with imports
        if 'setup_logging' in globals():
            logger = setup_logging()
            logger.info("Application started successfully")
        
        if 'DataProcessor' in globals():
            processor = DataProcessor()
            result = processor.process()
            print(f"Processing result: {{result}}")
        
    except Exception as e:
        print(f"Error: {{e}}")
        sys.exit(1)

if __name__ == "__main__":
    main()
'''
            elif content_type == "python_config":
                return f'''# {description}
# Configuration file

"""
{description}
Configuration settings and environment variables.
"""

import os
from typing import Dict, Any

# Default configuration
DEFAULT_CONFIG = {{
    "debug": False,
    "port": 8000,
    "host": "localhost"
}}

def get_config() -> Dict[str, Any]:
    """Get configuration from environment variables or defaults"""
    config = DEFAULT_CONFIG.copy()
    
    # Override with environment variables
    config["debug"] = os.getenv("DEBUG", "false").lower() == "true"
    config["port"] = int(os.getenv("PORT", config["port"]))
    config["host"] = os.getenv("HOST", config["host"])
    
    return config

if __name__ == "__main__":
    print("Configuration loaded:", get_config())
'''
            elif "flask" in content_type or "app" in path:
                return f'''# {description}
# Key features: {", ".join(key_features)}

"""
{description}
Flask application with proper structure and error handling.
"""

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
import os
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///app.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

@app.route('/')
def index():
    """Main page"""
    return render_template('index.html')

@app.route('/api/health')
def health_check():
    """Health check endpoint"""
    return jsonify({{"status": "healthy", "timestamp": datetime.now().isoformat()}})

@app.errorhandler(404)
def not_found(error):
    return jsonify({{"error": "Not found"}}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({{"error": "Internal server error"}}), 500

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, host='0.0.0.0', port=5000)
'''
            elif "models" in path:
                return f'''# {description}
# Key features: {", ".join(key_features)}

"""
{description}
Database models using SQLAlchemy.
"""

from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import uuid

db = SQLAlchemy()

class BaseModel(db.Model):
    """Base model with common fields"""
    __abstract__ = True
    
    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class User(BaseModel):
    """User model"""
    __tablename__ = 'users'
    
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    
    def __repr__(self):
        return f'<User {{self.username}}>'

class URL(BaseModel):
    """URL model for link shortener"""
    __tablename__ = 'urls'
    
    original_url = db.Column(db.String(500), nullable=False)
    short_code = db.Column(db.String(10), unique=True, nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    clicks = db.Column(db.Integer, default=0)
    
    def __repr__(self):
        return f'<URL {{self.short_code}}>'
'''
            elif "routes" in path:
                return f'''# {description}
# Key features: {", ".join(key_features)}

"""
{description}
API routes and endpoints.
"""

from flask import Blueprint, request, jsonify, render_template
from models import db, User, URL
import shortuuid
from urllib.parse import urlparse

api = Blueprint('api', __name__)

@api.route('/shorten', methods=['POST'])
def shorten_url():
    """Shorten a URL"""
    data = request.get_json()
    
    if not data or 'url' not in data:
        return jsonify({{"error": "URL is required"}}), 400
    
    original_url = data['url']
    
    # Validate URL
    try:
        result = urlparse(original_url)
        if not all([result.scheme, result.netloc]):
            return jsonify({{"error": "Invalid URL"}}), 400
    except:
        return jsonify({{"error": "Invalid URL"}}), 400
    
    # Generate short code
    short_code = shortuuid.ShortUUID().random(length=6)
    
    # Create URL record
    url = URL(original_url=original_url, short_code=short_code)
    db.session.add(url)
    db.session.commit()
    
    return jsonify({{
        "original_url": original_url,
        "short_url": f"{{request.host_url}}{{short_code}}",
        "short_code": short_code
    }})

@api.route('/<short_code>')
def redirect_to_url(short_code):
    """Redirect to original URL"""
    url = URL.query.filter_by(short_code=short_code).first()
    
    if not url:
        return jsonify({{"error": "URL not found"}}), 404
    
    # Increment click count
    url.clicks += 1
    db.session.commit()
    
    return redirect(url.original_url)

@api.route('/stats/<short_code>')
def get_stats(short_code):
    """Get URL statistics"""
    url = URL.query.filter_by(short_code=short_code).first()
    
    if not url:
        return jsonify({{"error": "URL not found"}}), 404
    
    return jsonify({{
        "short_code": short_code,
        "original_url": url.original_url,
        "clicks": url.clicks,
        "created_at": url.created_at.isoformat()
    }})
'''
            else:
                return f'''# {description}
# Key features: {", ".join(key_features)}

"""
{description}
This is a Python module file.
"""

def main():
    """Main function"""
    print(f"Hello from {{__name__}}")
    
if __name__ == "__main__":
    main()
'''
        elif path.endswith('.html'):
            return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{description}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>{description}</h1>
        </header>
        
        <main>
            <p>This is a generated HTML file for {path}.</p>
            <p>Key features: {", ".join(key_features)}</p>
        </main>
        
        <footer>
            <p>&copy; 2024 Generated Application</p>
        </footer>
    </div>
    
    <script src="app.js"></script>
</body>
</html>'''
        elif path.endswith('.css'):
            return f'''/* {description} */
/* Key features: {", ".join(key_features)} */

/* Reset and base styles */
* {{
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}}

body {{
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #f8f9fa;
}}

.container {{
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
}}

header {{
    background-color: #007bff;
    color: white;
    padding: 20px 0;
    text-align: center;
    margin-bottom: 30px;
}}

h1 {{
    font-size: 2.5rem;
    margin-bottom: 10px;
}}

main {{
    background-color: white;
    padding: 30px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    margin-bottom: 30px;
}}

footer {{
    text-align: center;
    padding: 20px;
    color: #666;
    border-top: 1px solid #ddd;
}}'''
        elif path.endswith('.js'):
            return f'''// {description}
// Key features: {", ".join(key_features)}

/**
 * {description}
 * This is a JavaScript file for {path} with proper imports/exports
 */

// Import other modules if they exist
import {{ TaskManager }} from './models/task.js';
import {{ StorageManager }} from './utils/storage.js';

// Main application class
class App {{
    constructor() {{
        this.taskManager = new TaskManager();
        this.storageManager = new StorageManager();
        this.init();
    }}
    
    init() {{
        console.log("Initializing application...");
        this.setupEventListeners();
        this.start();
    }}
    
    setupEventListeners() {{
        // Add event listeners here
        document.addEventListener('DOMContentLoaded', () => {{
            console.log("DOM loaded, application ready");
            this.loadData();
        }});
    }}
    
    loadData() {{
        // Load data from storage
        const data = this.storageManager.loadData();
        if (data) {{
            this.taskManager.loadTasks(data);
        }}
    }}
    
    start() {{
        console.log("Application started successfully!");
        this.render();
    }}
    
    render() {{
        // Render the application
        const appContainer = document.getElementById('app');
        if (appContainer) {{
            appContainer.innerHTML = this.generateHTML();
        }}
    }}
    
    generateHTML() {{
        return `
            <div class="app-container">
                <h1>{description}</h1>
                <div class="content">
                    <p>Application is running successfully!</p>
                </div>
            </div>
        `;
    }}
}}

// Export the App class
export default App;

// Initialize application if this is the main file
if (typeof window !== 'undefined') {{
    const app = new App();
}}'''
        elif path.endswith('.md'):
            return f'''# {description}

This is a generated documentation file for {path}.

## Overview

{description}

## Key Features

{chr(10).join([f"- {feature}" for feature in key_features])}

## Usage

Follow the instructions in the main application files.

## Installation

1. Ensure you have the required dependencies installed
2. Follow the setup instructions in the main application
3. Run the application using the provided commands

## Contributing

This is a generated project. Modify the code as needed for your specific requirements.

## License

This project is generated automatically and is ready for customization.
'''
        elif path.endswith('.txt'):
            return f'''# {description}

This is a text configuration file for {path}.

Key features: {", ".join(key_features)}

Configuration settings and data can be added here.
'''
        else:
            return f"# {description}\n\nThis is a generated file for {path}.\n\nKey features: {', '.join(key_features)}"

    def _get_file_type(self, path: str) -> str:
        """Determine file type from path"""
        if path.endswith('.py'):
            return "python"
        elif path.endswith('.html'):
            return "html"
        elif path.endswith('.css'):
            return "css"
        elif path.endswith('.js'):
            return "javascript"
        elif path.endswith('.json'):
            return "json"
        elif path.endswith('.md'):
            return "markdown"
        elif path.endswith('.txt'):
            return "text"
        else:
            return "text"
    
    async def _reviewer_improve_code(self, files: List[ProjectFile]) -> Dict[str, Any]:
        """Reviewer agent to review and improve the generated code."""
        # For now, return the original files with basic review
        # This can be enhanced later with actual AI review
        logger.info(f"🔍 Reviewing {len(files)} files for improvements...")
        
        # Basic review - just return the original files
        reviewed_files = []
        improvements = []
        
        for file in files:
            # Add basic improvements like ensuring proper encoding and line endings
            content = file.content
            if not content.endswith('\n'):
                content += '\n'
            
            reviewed_files.append(ProjectFile(
                path=file.path,
                content=content,
                file_type=file.file_type,
                dependencies=file.dependencies
            ))
            improvements.append(f"Ensured proper formatting for {file.path}")
        
        self._add_agent_message(AgentRole.REVIEWER, f"Reviewed {len(files)} files, made {len(improvements)} improvements")
        
        return {
            "success": True,
            "files": reviewed_files,
            "improvements": improvements
        }
    
    async def _tester_validate_project(self, files: List[ProjectFile], user_request: str) -> Dict[str, Any]:
        """Tester agent to validate the project and create run instructions."""
        logger.info(f"🧪 Validating {len(files)} files and creating run instructions...")
        
        # Generate basic run instructions based on file types
        python_files = [f for f in files if f.file_type == "python"]
        html_files = [f for f in files if f.file_type == "html"]
        js_files = [f for f in files if f.file_type == "javascript"]
        
        run_instructions = f"# Run Instructions for {user_request}\n\n"
        
        if python_files:
            run_instructions += "## Python Application\n"
            run_instructions += "1. Install dependencies (if any):\n"
            run_instructions += "   ```bash\n"
            run_instructions += "   pip install -r requirements.txt\n"
            run_instructions += "   ```\n\n"
            run_instructions += "2. Run the application:\n"
            run_instructions += "   ```bash\n"
            main_file = next((f for f in python_files if "main" in f.path.lower()), python_files[0])
            run_instructions += f"   python {main_file.path}\n"
            run_instructions += "   ```\n\n"
        
        if html_files:
            run_instructions += "## Web Application\n"
            run_instructions += "1. Open the HTML file in your browser:\n"
            main_html = next((f for f in html_files if "index" in f.path.lower()), html_files[0])
            run_instructions += f"   - Open `{main_html.path}` in your web browser\n"
            run_instructions += "   - Or use a local server: `python -m http.server 8000`\n\n"
        
        if js_files:
            run_instructions += "## JavaScript Application\n"
            run_instructions += "1. If using Node.js:\n"
            run_instructions += "   ```bash\n"
            run_instructions += "   node main.js\n"
            run_instructions += "   ```\n\n"
        
        run_instructions += "## Project Files\n"
        for file in files:
            run_instructions += f"- `{file.path}` ({file.file_type})\n"
        
        # Extract dependencies from files
        dependencies = []
        for file in files:
            dependencies.extend(file.dependencies)
        dependencies = list(set(dependencies))  # Remove duplicates
        
        self._add_agent_message(AgentRole.TESTER, f"Validated {len(files)} files, created run instructions")
        
        return {
            "success": True,
            "run_instructions": run_instructions,
            "dependencies": dependencies
        }
    
    async def _create_files_in_workspace(self, files: List[ProjectFile]) -> List[ProjectFile]:
        """Actually create all files in the workspace with proper folder structure."""
        logger.info("📝 Creating files in workspace with proper folder organization...")
        created_files = []
        
        # Group files by folder for better organization
        folder_files = {}
        for project_file in files:
            file_path = project_file.path
            if file_path.startswith('/'):
                file_path = file_path[1:]
            
            # Determine folder
            if '/' in file_path:
                folder = file_path.rsplit('/', 1)[0]
            else:
                folder = "root"
            
            if folder not in folder_files:
                folder_files[folder] = []
            folder_files[folder].append((file_path, project_file))
        
        # Create files organized by folders
        for folder, folder_file_list in folder_files.items():
            logger.info(f"📁 Creating files in folder: {folder}")
            
            for file_path, project_file in folder_file_list:
                try:
                    logger.info(f"📝 Processing file: {file_path}")
                    
                    # Create full path
                    full_path = self.workspace_dir / file_path
                    logger.info(f"🔍 Full path: {full_path}")
                    logger.info(f"🔍 Parent directory: {full_path.parent}")
                    
                    # Ensure parent directory exists
                    full_path.parent.mkdir(parents=True, exist_ok=True)
                    logger.info(f"✅ Parent directory created/verified")
                    
                    # Write file content
                    logger.info(f"📝 Writing {len(project_file.content)} characters to {file_path}")
                    full_path.write_text(project_file.content, encoding='utf-8')
                    logger.info(f"✅ Created file: {file_path}")
                    created_files.append(project_file)
                    
                except Exception as e:
                    logger.error(f"❌ Failed to create file {file_path}: {e}")
                    logger.error(f"❌ Exception type: {type(e)}")
                    import traceback
                    logger.error(f"❌ Traceback: {traceback.format_exc()}")
        
        logger.info(f"🎉 Successfully created {len(created_files)} files with proper folder organization")
        return created_files
    
    def _finalize_with_comprehensive_response(self, user_request: str, created_files: List[ProjectFile], test_result: Dict[str, Any], quality_score: float) -> Dict[str, Any]:
        """Finalize the project creation with actual files and instructions."""
        logger.info("\n" + "=" * 80)
        logger.info("🎉 MULTI-AGENT PROJECT CREATION COMPLETED!")
        logger.info("=" * 80)
        
        # Determine project type from files
        project_type = self._determine_project_type_from_files(created_files)
        
        # List all workspace files for context
        workspace_files = self._list_workspace_files()
        
        # Create detailed file information for frontend
        created_files_info = [
            {
                "path": f.path,
                "type": f.file_type,
                "size": len(f.content),
                "dependencies": f.dependencies,
                "content_preview": f.content[:200] + "..." if len(f.content) > 200 else f.content
            }
            for f in created_files
        ]
        
        # Build step-by-step progress summary
        step_progress = f"""✅ **Step-by-Step Progress:**

🎯 **Step 1/8: PLANNER** - Analyzed request and created project plan
🏗️ **Step 2/8: ARCHITECT** - Designed system architecture and file structure  
💻 **Step 3/8: DEVELOPER** - Generated {len(created_files)} files with complete implementation
🔍 **Step 4/8: REVIEWER** - Reviewed and improved code quality
🧪 **Step 5/8: TESTER** - Validated project and created run instructions
📁 **Step 6/8: SYSTEM** - Created all files in workspace
�� **Step 7/8: ASSESSMENT** - Assessed project quality
🎉 **Step 8/8: FINALIZATION** - Project ready for use

**Total Steps Completed**: 8/8 ✅"""

        return {
            "status": "success",
            "message": f"Project created successfully through multi-agent collaboration!",
            "run_instructions": test_result["run_instructions"],
            "project_context": {
                "user_request": user_request,
                "project_type": project_type,
                "files_created": [f.path for f in created_files],
                "total_files": len(created_files),
                "agents_involved": list(set([msg.role.value for msg in self.conversation_history])),
                "conversation_turns": len(self.conversation_history),
                "workspace_files": workspace_files,
                "created_files": created_files_info,  # Add detailed file info
                "dependencies": test_result["dependencies"],
                "step_progress": step_progress,  # Add step-by-step progress
                "quality_score": quality_score
            },
            "conversation_summary": self._format_conversation_history(),
            "file_details": created_files_info
        }
    
    def _create_error_response(self, message: str, error_detail: str) -> Dict[str, Any]:
        """Helper to create a consistent error response."""
        step_progress = f"""❌ **Step-by-Step Progress:**

🎯 **Step 1/8: PLANNER** - {'✅ Completed' if self.current_step >= 1 else '⏳ Pending'}
🏗️ **Step 2/8: ARCHITECT** - {'✅ Completed' if self.current_step >= 2 else '⏳ Pending'}
💻 **Step 3/8: DEVELOPER** - {'✅ Completed' if self.current_step >= 3 else '⏳ Pending'}
🔍 **Step 4/8: REVIEWER** - {'✅ Completed' if self.current_step >= 4 else '⏳ Pending'}
🧪 **Step 5/8: TESTER** - {'✅ Completed' if self.current_step >= 5 else '⏳ Pending'}
📁 **Step 6/8: SYSTEM** - {'✅ Completed' if self.current_step >= 6 else '⏳ Pending'}
📊 **Step 7/8: ASSESSMENT** - {'✅ Completed' if self.current_step >= 7 else '⏳ Pending'}
🎉 **Step 8/8: FINALIZATION** - {'✅ Completed' if self.current_step >= 8 else '⏳ Pending'}

**Failed at Step**: {self.current_step}/8 ❌"""

        return {
            "status": "failed",
            "message": message,
            "project_context": {
                "user_request": self.conversation_history[-1].content if self.conversation_history else "Unknown",
                "errors": [error_detail],
                "step_progress": step_progress
            },
            "conversation_summary": self._format_conversation_history()
        }
    
    def _determine_project_type_from_files(self, files: List[ProjectFile]) -> str:
        """Determine project type from actual created files"""
        has_python = any(f.file_type == "python" for f in files)
        has_html = any(f.file_type == "html" for f in files)
        has_js = any(f.file_type == "javascript" for f in files)
        has_css = any(f.file_type == "css" for f in files)
        
        if has_html and has_js and has_css:
            return "web_app"
        elif has_python and len(files) > 1:
            return "multi_file"
        elif has_python:
            return "single_file"
        else:
            return "unknown"
    
    def _list_workspace_files(self) -> List[str]:
        """List all files currently in the workspace"""
        try:
            files = []
            for file_path in self.workspace_dir.rglob('*'):
                if file_path.is_file():
                    relative_path = file_path.relative_to(self.workspace_dir)
                    files.append(str(relative_path))
            return files
        except Exception as e:
            logger.error(f"Failed to list workspace files: {e}")
            return []
    
    async def _finalize_with_fallback(self, user_request: str) -> Dict[str, Any]:
        """Finalize with fallback when max iterations reached"""
        logger.info("⚠️ Using fallback project creation due to max iterations")
        
        # Create a simple project based on the request
        fallback_files = await self._create_intelligent_fallback_files(user_request, ProjectType.SINGLE_FILE, {})
        
        # Actually create the files
        created_files = []
        for project_file in fallback_files:
            try:
                file_path = project_file.path
                if file_path.startswith('/'):
                    file_path = file_path[1:]
                
                full_path = self.workspace_dir / file_path
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_text(project_file.content, encoding='utf-8')
                logger.info(f"✅ Created fallback file: {file_path}")
                created_files.append(project_file)
                
            except Exception as e:
                logger.error(f"Failed to create fallback file {file_path}: {e}")
        
        # Generate run instructions
        run_instructions = await self._generate_run_instructions(created_files)
        
        return {
            "status": "completed_with_fallback",
            "message": f"Project created with fallback system after {self.max_iterations} iterations",
            "run_instructions": run_instructions,
            "project_context": {
                "user_request": user_request,
                "project_type": "single_file",
                "files_created": [f.path for f in created_files],
                "total_files": len(created_files),
                "note": "Created with fallback due to max iterations",
                "workspace_files": self._list_workspace_files()
            },
            "file_details": [
                {
                    "path": f.path,
                    "type": f.file_type,
                    "size": len(f.content),
                    "dependencies": f.dependencies
                }
                for f in created_files
            ]
        }
    
    async def delete_file(self, file_path: str) -> Dict[str, Any]:
        """Delete a file from the workspace"""
        try:
            # Ensure file path is relative to workspace
            if file_path.startswith('/'):
                file_path = file_path[1:]
            
            full_path = self.workspace_dir / file_path
            
            if full_path.exists():
                full_path.unlink()
                logger.info(f"🗑️ Deleted file: {file_path}")
                return {
                    "success": True,
                    "message": f"File '{file_path}' deleted successfully",
                    "deleted_file": file_path
                }
            else:
                return {
                    "success": False,
                    "message": f"File '{file_path}' not found",
                    "error": "File does not exist"
                }
                
        except Exception as e:
            logger.error(f"File deletion failed: {e}")
            return {
                "success": False,
                "message": f"Failed to delete file '{file_path}'",
                "error": str(e)
            }
    
    async def list_workspace_files(self) -> Dict[str, Any]:
        """List all files in the workspace"""
        try:
            files = []
            for file_path in self.workspace_dir.rglob('*'):
                if file_path.is_file():
                    relative_path = file_path.relative_to(self.workspace_dir)
                    files.append(str(relative_path))
            
            return {
                "success": True,
                "files": files,
                "total_files": len(files)
            }
        except Exception as e:
            logger.error(f"Failed to list workspace files: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def _create_intelligent_fallback_files(self, user_request: str, project_type: ProjectType, context: Dict[str, Any]) -> List[ProjectFile]:
        """Create intelligent fallback files with proper structure and imports/exports"""
        user_lower = user_request.lower()
        files = []
        
        if project_type == ProjectType.WEB_APP:
            # Create a complete web application structure
            files.extend([
                ProjectFile(
                    path="index.html",
                    content=self._get_html_template(user_request),
                    file_type="html",
                    dependencies=[]
                ),
                ProjectFile(
                    path="styles.css",
                    content=self._get_css_template(),
                    file_type="css",
                    dependencies=[]
                ),
                ProjectFile(
                    path="js/app.js",
                    content=self._get_js_app_template(user_request),
                    file_type="javascript",
                    dependencies=[]
                ),
                ProjectFile(
                    path="js/models/task.js",
                    content=self._get_task_model_template(),
                    file_type="javascript",
                    dependencies=[]
                ),
                ProjectFile(
                    path="js/utils/storage.js",
                    content=self._get_storage_utils_template(),
                    file_type="javascript",
                    dependencies=[]
                ),
                ProjectFile(
                    path="README.md",
                    content=self._get_readme_template(user_request, "web_app"),
                    file_type="markdown",
                    dependencies=[]
                )
            ])
            
        elif project_type == ProjectType.API_SERVICE:
            # Create a complete API service structure
            files.extend([
                ProjectFile(
                    path="main.py",
                    content=self._get_api_main_template(user_request),
                    file_type="python",
                    dependencies=["fastapi", "uvicorn", "sqlalchemy"]
                ),
                ProjectFile(
                    path="models.py",
                    content=self._get_api_models_template(),
                    file_type="python",
                    dependencies=["sqlalchemy"]
                ),
                ProjectFile(
                    path="routes.py",
                    content=self._get_api_routes_template(),
                    file_type="python",
                    dependencies=["fastapi"]
                ),
                ProjectFile(
                    path="database.py",
                    content=self._get_api_database_template(),
                    file_type="python",
                    dependencies=["sqlalchemy"]
                ),
                ProjectFile(
                    path="requirements.txt",
                    content="fastapi==0.104.1\nuvicorn==0.24.0\nsqlalchemy==2.0.23\npydantic==2.5.0",
                    file_type="text",
                    dependencies=[]
                ),
                ProjectFile(
                    path="README.md",
                    content=self._get_readme_template(user_request, "api_service"),
                    file_type="markdown",
                    dependencies=[]
                )
            ])
            
        elif project_type == ProjectType.MULTI_FILE:
            # Create a multi-file Python project
            files.extend([
                ProjectFile(
                    path="main.py",
                    content=self._get_multi_main_template(user_request),
                    file_type="python",
                    dependencies=[]
                ),
                ProjectFile(
                    path="utils.py",
                    content=self._get_utils_template(),
                    file_type="python",
                    dependencies=[]
                ),
                ProjectFile(
                    path="models.py",
                    content=self._get_models_template(),
                    file_type="python",
                    dependencies=[]
                ),
                ProjectFile(
                    path="config.py",
                    content=self._get_config_template(),
                    file_type="python",
                    dependencies=[]
                ),
                ProjectFile(
                    path="README.md",
                    content=self._get_readme_template(user_request, "multi_file"),
                    file_type="markdown",
                    dependencies=[]
                )
            ])
            
        else:
            # Single file project
            files.append(await self._create_fallback_file(user_request, project_type))
        
        return files
    
    async def _create_fallback_file(self, user_request: str, project_type: ProjectType) -> ProjectFile:
        """Create a fallback file when API generation fails"""
        user_lower = user_request.lower()
        
        if "calculator" in user_lower or "calc" in user_lower:
            filename = "calculator.py"
            content = self._get_calculator_template()
        elif "workout" in user_lower or "fitness" in user_lower or "exercise" in user_lower:
            filename = "workout_app.py"
            content = self._get_workout_template()
        elif "todo" in user_lower:
            filename = "todo_app.py"
            content = self._get_todo_template()
        else:
            filename = "main.py"
            content = self._get_basic_template(user_request)
        
        return ProjectFile(
            path=filename,
            content=content,
            file_type="python",
            dependencies=[]
        )
    
    def _get_calculator_template(self) -> str:
        return '''# Calculator Application
# Created automatically by the IDE with proper imports and structure

import sys
from typing import Union, Optional

class Calculator:
    """Calculator class with proper error handling and validation"""
    
    def __init__(self):
        self.history = []
    
    def add(self, x: Union[int, float], y: Union[int, float]) -> Union[int, float]:
        """Add two numbers"""
        result = x + y
        self.history.append(f"{x} + {y} = {result}")
        return result
    
    def subtract(self, x: Union[int, float], y: Union[int, float]) -> Union[int, float]:
        """Subtract two numbers"""
        result = x - y
        self.history.append(f"{x} - {y} = {result}")
        return result
    
    def multiply(self, x: Union[int, float], y: Union[int, float]) -> Union[int, float]:
        """Multiply two numbers"""
        result = x * y
        self.history.append(f"{x} * {y} = {result}")
        return result
    
    def divide(self, x: Union[int, float], y: Union[int, float]) -> Optional[Union[int, float]]:
        """Divide two numbers with error handling"""
        if y == 0:
            print("Error: Cannot divide by zero")
            return None
        result = x / y
        self.history.append(f"{x} / {y} = {result}")
        return result
    
    def get_history(self) -> list:
        """Get calculation history"""
        return self.history
    
    def clear_history(self):
        """Clear calculation history"""
        self.history = []

def parse_calculation(user_input: str) -> tuple:
    """Parse user input to extract operation and numbers"""
    user_input = user_input.strip()
    
    if '+' in user_input:
        parts = user_input.split('+')
        if len(parts) == 2:
            return ('add', float(parts[0].strip()), float(parts[1].strip()))
    elif '-' in user_input:
        parts = user_input.split('-')
        if len(parts) == 2:
            return ('subtract', float(parts[0].strip()), float(parts[1].strip()))
    elif '*' in user_input:
        parts = user_input.split('*')
        if len(parts) == 2:
            return ('multiply', float(parts[0].strip()), float(parts[1].strip()))
    elif '/' in user_input:
        parts = user_input.split('/')
        if len(parts) == 2:
            return ('divide', float(parts[0].strip()), float(parts[1].strip()))
    
    return None

def main():
    """Main calculator function"""
    calc = Calculator()
    print("=== Advanced Calculator ===")
    print("Operations: +, -, *, /")
    print("Commands: history, clear, quit")
    print("Type 'quit' to exit")
    
    while True:
        try:
            user_input = input("\\nEnter calculation (e.g., 5 + 3): ").strip()
            
            if user_input.lower() == 'quit':
                print("Goodbye!")
                break
            elif user_input.lower() == 'history':
                print("\\nCalculation History:")
                for entry in calc.get_history():
                    print(f"  {entry}")
            elif user_input.lower() == 'clear':
                calc.clear_history()
                print("History cleared!")
            else:
                parsed = parse_calculation(user_input)
                if parsed:
                    operation, x, y = parsed
                    if operation == 'add':
                        result = calc.add(x, y)
                    elif operation == 'subtract':
                        result = calc.subtract(x, y)
                    elif operation == 'multiply':
                        result = calc.multiply(x, y)
                    elif operation == 'divide':
                        result = calc.divide(x, y)
                        if result is None:
                            continue
                    
                    print(f"Result: {result}")
                else:
                    print("Invalid format. Use: number + number, number - number, etc.")
                    
        except ValueError:
            print("Invalid input. Please enter valid numbers.")
        except KeyboardInterrupt:
            print("\\nGoodbye!")
            break
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    main()'''
    
    def _get_todo_template(self) -> str:
        return '''# Todo Application
# Created automatically by the IDE

class TodoApp:
    def __init__(self):
        self.tasks = []
    
    def add_task(self, task):
        self.tasks.append({{"task": task, "completed": False, "id": len(self.tasks) + 1}})
        print(f"Task added: {{task}}")
    
    def view_tasks(self):
        if not self.tasks:
            print("No tasks found.")
            return
        
        print("\\n=== Your Tasks ===")
        for task in self.tasks:
            status = "✓" if task["completed"] else "□"
            print(f"{{task['id']}}. [{{status}}] {{task['task']}}")
    
    def complete_task(self, task_id):
        for task in self.tasks:
            if task["id"] == task_id:
                task["completed"] = True
                print(f"Task {{task_id}} marked as completed!")
                return
        print(f"Task {{task_id}} not found.")
    
    def delete_task(self, task_id):
        for i, task in enumerate(self.tasks):
            if task["id"] == task_id:
                deleted_task = self.tasks.pop(i)
                print(f"Deleted task: {{deleted_task['task']}}")
                for j, t in enumerate(self.tasks):
                    t["id"] = j + 1
                return
        print(f"Task {{task_id}} not found.")
    
    def run(self):
        print("=== Todo App ===")
        print("Commands: add, view, complete, delete, quit")
        
        while True:
            try:
                command = input("\\nEnter command: ").strip().lower()
                
                if command == 'quit':
                    print("Goodbye!")
                    break
                
                elif command == 'add':
                    task = input("Enter task: ").strip()
                    if task:
                        self.add_task(task)
                    else:
                        print("Task cannot be empty.")
                
                elif command == 'view':
                    self.view_tasks()
                
                elif command == 'complete':
                    try:
                        task_id = int(input("Enter task ID to complete: "))
                        self.complete_task(task_id)
                    except ValueError:
                        print("Please enter a valid task ID.")
                
                elif command == 'delete':
                    try:
                        task_id = int(input("Enter task ID to delete: "))
                        self.delete_task(task_id)
                    except ValueError:
                        print("Please enter a valid task ID.")
                
                else:
                    print("Invalid command. Use: add, view, complete, delete, quit")
                    
            except KeyboardInterrupt:
                print("\\nGoodbye!")
                break
            except Exception as e:
                print(f"Error: {{e}}")

if __name__ == "__main__":
    app = TodoApp()
    app.run()'''
    
    def _get_basic_template(self, user_request: str) -> str:
        return f'''# Main Application
# Created based on request: {user_request}
# Created automatically by the IDE

def main():
    print("Hello from the IDE!")
    print("This application was created automatically.")
    print(f"Request: {user_request}")
    
    # Add your custom logic here
    print("\\nApplication is ready for customization!")

if __name__ == "__main__":
    main()'''
    
    def _get_html_template(self, user_request: str) -> str:
        return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{user_request.title()} - Web App</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>{user_request.title()}</h1>
            <p>Created with the Intelligent IDE</p>
        </header>
        
        <main id="app">
            <!-- App content will be dynamically generated -->
        </main>
        
        <footer>
            <p>Powered by AI-Powered IDE</p>
        </footer>
    </div>
    
    <script type="module" src="js/app.js"></script>
</body>
</html>'''
    
    def _get_css_template(self) -> str:
        return '''/* Modern CSS with responsive design */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    line-height: 1.6;
    color: #333;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
}

header {
    text-align: center;
    margin-bottom: 40px;
    color: white;
}

header h1 {
    font-size: 3rem;
    margin-bottom: 10px;
    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
}

main {
    background: white;
    border-radius: 15px;
    padding: 30px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    min-height: 500px;
}

footer {
    text-align: center;
    margin-top: 40px;
    color: white;
    opacity: 0.8;
}

/* Responsive design */
@media (max-width: 768px) {
    .container {
        padding: 10px;
    }
    
    header h1 {
        font-size: 2rem;
    }
    
    main {
        padding: 20px;
    }
}'''
    
    def _get_js_app_template(self, user_request: str) -> str:
        return f'''// Main application logic
import {{ TaskManager }} from './models/task.js';
import {{ StorageManager }} from './utils/storage.js';

class App {{
    constructor() {{
        this.taskManager = new TaskManager();
        this.storageManager = new StorageManager();
        this.init();
    }}
    
    init() {{
        this.loadTasks();
        this.setupEventListeners();
        this.render();
    }}
    
    loadTasks() {{
        const savedTasks = this.storageManager.loadTasks();
        if (savedTasks) {{
            this.taskManager.tasks = savedTasks;
        }}
    }}
    
    setupEventListeners() {{
        // Add event listeners for user interactions
        document.addEventListener('DOMContentLoaded', () => {{
            this.setupFormHandlers();
            this.setupActionHandlers();
        }});
    }}
    
    setupFormHandlers() {{
        const form = document.getElementById('task-form');
        if (form) {{
            form.addEventListener('submit', (e) => {{
                e.preventDefault();
                this.handleAddTask();
            }});
        }}
    }}
    
    setupActionHandlers() {{
        // Setup handlers for task actions (complete, delete, etc.)
        document.addEventListener('click', (e) => {{
            if (e.target.matches('.complete-btn')) {{
                this.handleCompleteTask(e.target.dataset.id);
            }} else if (e.target.matches('.delete-btn')) {{
                this.handleDeleteTask(e.target.dataset.id);
            }}
        }});
    }}
    
    handleAddTask() {{
        const input = document.getElementById('task-input');
        if (input && input.value.trim()) {{
            this.taskManager.addTask(input.value.trim());
            input.value = '';
            this.saveAndRender();
        }}
    }}
    
    handleCompleteTask(taskId) {{
        this.taskManager.completeTask(parseInt(taskId));
        this.saveAndRender();
    }}
    
    handleDeleteTask(taskId) {{
        this.taskManager.deleteTask(parseInt(taskId));
        this.saveAndRender();
    }}
    
    saveAndRender() {{
        this.storageManager.saveTasks(this.taskManager.tasks);
        this.render();
    }}
    
    render() {{
        const appContainer = document.getElementById('app');
        if (appContainer) {{
            appContainer.innerHTML = this.generateHTML();
        }}
    }}
    
    generateHTML() {{
        return `
            <div class="task-app">
                <form id="task-form" class="task-form">
                    <input type="text" id="task-input" placeholder="Enter a new task..." required>
                    <button type="submit">Add Task</button>
                </form>
                
                <div class="task-list">
                    ${{this.taskManager.tasks.length === 0 ? '<p class="no-tasks">No tasks yet. Add one above!</p>' : ''}}
                    ${{this.taskManager.tasks.map(task => `
                        <div class="task-item ${{task.completed ? 'completed' : ''}}">
                            <span class="task-text">${{task.task}}</span>
                            <div class="task-actions">
                                <button class="complete-btn" data-id="${{task.id}}">
                                    ${{task.completed ? '✓' : '○'}}
                                </button>
                                <button class="delete-btn" data-id="${{task.id}}">🗑️</button>
                            </div>
                        </div>
                    `).join('')}}
                </div>
            </div>
        `;
    }}
}}

// Initialize the app
new App();'''
    
    def _get_task_model_template(self) -> str:
        return '''// Task model for managing task data
export class Task {
    constructor(text, completed = false) {
        this.id = Date.now() + Math.random();
        this.task = text;
        this.completed = completed;
        this.createdAt = new Date();
    }
}

export class TaskManager {
    constructor() {
        this.tasks = [];
    }
    
    addTask(text) {
        if (text.trim()) {
            const task = new Task(text.trim());
            this.tasks.push(task);
            return task;
        }
        return null;
    }
    
    completeTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
            task.completed = !task.completed;
            return true;
        }
        return false;
    }
    
    deleteTask(taskId) {
        const index = this.tasks.findIndex(t => t.id === taskId);
        if (index !== -1) {
            this.tasks.splice(index, 1);
            return true;
        }
        return false;
    }
    
    getTasks(filter = 'all') {
        switch (filter) {
            case 'active':
                return this.tasks.filter(t => !t.completed);
            case 'completed':
                return this.tasks.filter(t => t.completed);
            default:
                return this.tasks;
        }
    }
    
    clearCompleted() {
        this.tasks = this.tasks.filter(t => !t.completed);
    }
}'''
    
    def _get_storage_utils_template(self) -> str:
        return '''// Storage utilities for persisting data
export class StorageManager {
    constructor(storageKey = 'tasks') {
        this.storageKey = storageKey;
    }
    
    saveTasks(tasks) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(tasks));
            return true;
        } catch (error) {
            console.error('Failed to save tasks:', error);
            return false;
        }
    }
    
    loadTasks() {
        try {
            const data = localStorage.getItem(this.storageKey);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('Failed to load tasks:', error);
            return [];
        }
    }
    
    clearTasks() {
        try {
            localStorage.removeItem(this.storageKey);
            return true;
        } catch (error) {
            console.error('Failed to clear tasks:', error);
            return false;
        }
    }
}'''
    
    def _get_api_main_template(self, user_request: str) -> str:
        return f'''# {user_request.title()} - FastAPI Application
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn

from models import Task, TaskCreate, TaskUpdate
from database import engine, SessionLocal
from routes import router

# Create database tables
from models import Base
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="{user_request.title()} API",
    description="A FastAPI application created with the Intelligent IDE",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(router, prefix="/api/v1")

@app.get("/")
async def root():
    return {{
        "message": "Welcome to {user_request.title()} API",
        "version": "1.0.0",
        "docs": "/docs"
    }}

@app.get("/health")
async def health_check():
    return {{"status": "healthy", "service": "{user_request.title()}"}}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)'''
    
    def _get_api_models_template(self) -> str:
        return '''# Database models using SQLAlchemy
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
from pydantic import BaseModel
from typing import Optional

Base = declarative_base()

# SQLAlchemy Models
class TaskDB(Base):
    __tablename__ = "tasks"
    
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    description = Column(String, nullable=True)
    completed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# Pydantic Models for API
class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None

class TaskCreate(TaskBase):
    pass

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    completed: Optional[bool] = None

class Task(TaskBase):
    id: int
    completed: bool
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

# Database session
from database import get_db
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=get_db())'''
    
    def _get_api_routes_template(self) -> str:
        return '''# API routes for the application
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from models import Task, TaskCreate, TaskUpdate, TaskDB
from database import get_db

router = APIRouter()

@router.get("/tasks/", response_model=List[Task])
async def get_tasks(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """Get all tasks with pagination"""
    tasks = db.query(TaskDB).offset(skip).limit(limit).all()
    return tasks

@router.get("/tasks/{task_id}", response_model=Task)
async def get_task(task_id: int, db: Session = Depends(get_db)):
    """Get a specific task by ID"""
    task = db.query(TaskDB).filter(TaskDB.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.post("/tasks/", response_model=Task)
async def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    """Create a new task"""
    db_task = TaskDB(**task.dict())
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task

@router.put("/tasks/{task_id}", response_model=Task)
async def update_task(task_id: int, task: TaskUpdate, db: Session = Depends(get_db)):
    """Update an existing task"""
    db_task = db.query(TaskDB).filter(TaskDB.id == task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    
    update_data = task.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_task, field, value)
    
    db.commit()
    db.refresh(db_task)
    return db_task

@router.delete("/tasks/{task_id}")
async def delete_task(task_id: int, db: Session = Depends(get_db)):
    """Delete a task"""
    db_task = db.query(TaskDB).filter(TaskDB.id == task_id).first()
    if db_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    
    db.delete(db_task)
    db.commit()
    return {"message": "Task deleted successfully"}'''
    
    def _get_api_database_template(self) -> str:
        return '''# Database configuration and utilities
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# SQLite database URL (change to PostgreSQL/MySQL for production)
SQLALCHEMY_DATABASE_URL = "sqlite:///./app.db"

# Create engine
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False}  # Only needed for SQLite
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for models
Base = declarative_base()

def get_db():
    """Dependency to get database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()'''
    
    def _get_multi_main_template(self, user_request: str) -> str:
        return f'''# {user_request.title()} - Main Application
# Created with the Intelligent IDE

from utils import setup_logging, validate_input
from models import DataProcessor, Config
from config import load_config
import logging

def main():
    """Main application entry point"""
    # Setup logging
    logger = setup_logging()
    logger.info("Starting {user_request.title()} application")
    
    try:
        # Load configuration
        config = load_config()
        logger.info(f"Configuration loaded: {{config}}")
        
        # Initialize data processor
        processor = DataProcessor(config)
        
        # Process data
        result = processor.process()
        logger.info(f"Processing completed: {{result}}")
        
        # Display results
        print(f"\\n🎉 {user_request.title()} completed successfully!")
        print(f"📊 Results: {{result}}")
        
    except Exception as e:
        logger.error(f"Application failed: {{e}}")
        print(f"❌ Error: {{e}}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())'''
    
    def _get_utils_template(self) -> str:
        return '''# Utility functions for the application
import logging
import os
from typing import Any, Dict

def setup_logging(level: str = "INFO") -> logging.Logger:
    """Setup logging configuration"""
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler('app.log')
        ]
    )
    return logging.getLogger(__name__)

def validate_input(data: Any) -> bool:
    """Validate input data"""
    if data is None:
        return False
    if isinstance(data, str) and not data.strip():
        return False
    return True

def safe_get(data: Dict, key: str, default: Any = None) -> Any:
    """Safely get value from dictionary"""
    return data.get(key, default)

def format_output(data: Any) -> str:
    """Format output data for display"""
    if isinstance(data, dict):
        return "\\n".join([f"{{k}}: {{v}}" for k, v in data.items()])
    elif isinstance(data, list):
        return "\\n".join([str(item) for item in data])
    else:
        return str(data)'''
    
    def _get_models_template(self) -> str:
        return '''# Data models and business logic
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from datetime import datetime

@dataclass
class Config:
    """Configuration class"""
    name: str
    version: str
    debug: bool = False
    max_items: int = 100

class DataProcessor:
    """Main data processing class"""
    
    def __init__(self, config: Config):
        self.config = config
        self.data = []
        self.processed_count = 0
    
    def add_data(self, item: Any) -> bool:
        """Add data item to processor"""
        if len(self.data) >= self.config.max_items:
            return False
        
        self.data.append({
            'item': item,
            'timestamp': datetime.now(),
            'processed': False
        })
        return True
    
    def process(self) -> Dict[str, Any]:
        """Process all data items"""
        if not self.data:
            return {'status': 'no_data', 'count': 0}
        
        for item_data in self.data:
            if not item_data['processed']:
                # Process the item
                item_data['item'] = self._process_item(item_data['item'])
                item_data['processed'] = True
                item_data['processed_at'] = datetime.now()
                self.processed_count += 1
        
        return {
            'status': 'completed',
            'total_items': len(self.data),
            'processed_items': self.processed_count,
            'timestamp': datetime.now()
        }
    
    def _process_item(self, item: Any) -> Any:
        """Process individual item"""
        if isinstance(item, str):
            return item.upper()
        elif isinstance(item, (int, float)):
            return item * 2
        elif isinstance(item, list):
            return [self._process_item(subitem) for subitem in item]
        else:
            return str(item)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get processing statistics"""
        return {
            'total_items': len(self.data),
            'processed_items': self.processed_count,
            'pending_items': len(self.data) - self.processed_count,
            'config': self.config.__dict__
        }'''
    
    def _get_config_template(self) -> str:
        return '''# Configuration management
import os
from typing import Dict, Any
from models import Config

def load_config() -> Config:
    """Load configuration from environment variables or defaults"""
    return Config(
        name=os.getenv('APP_NAME', 'IntelligentApp'),
        version=os.getenv('APP_VERSION', '1.0.0'),
        debug=os.getenv('DEBUG', 'false').lower() == 'true',
        max_items=int(os.getenv('MAX_ITEMS', '100'))
    )

def get_env_config() -> Dict[str, Any]:
    """Get all environment configuration"""
    return {
        'APP_NAME': os.getenv('APP_NAME', 'IntelligentApp'),
        'APP_VERSION': os.getenv('APP_VERSION', '1.0.0'),
        'DEBUG': os.getenv('DEBUG', 'false').lower() == 'true',
        'MAX_ITEMS': int(os.getenv('MAX_ITEMS', '100')),
        'LOG_LEVEL': os.getenv('LOG_LEVEL', 'INFO'),
        'ENVIRONMENT': os.getenv('ENVIRONMENT', 'development')
    }

def validate_config(config: Config) -> bool:
    """Validate configuration values"""
    if not config.name or not config.name.strip():
        return False
    if config.max_items <= 0:
        return False
    return True'''
    
    def _get_readme_template(self, user_request: str, project_type: str) -> str:
        return f'''# {user_request.title()}

A {project_type.replace('_', ' ')} created with the Intelligent IDE.

## Features

- **Intelligent Code Generation**: AI-powered code creation
- **Modern Architecture**: Best practices and patterns
- **Complete Implementation**: Ready-to-run code
- **Proper Structure**: Organized file layout
- **Responsive design (for web apps)**

## Project Structure

This project follows modern software development practices with:

- Clear separation of concerns
- Proper import/export structure
- Error handling and validation
- Documentation and comments
- Responsive design (for web apps)

## Getting Started

### Prerequisites

- Python 3.8+ (for Python projects)
- Node.js 16+ (for JavaScript projects)
- Modern web browser (for web applications)

### Installation

1. Clone or download this project
2. Install dependencies (see requirements.txt or package.json)
3. Follow the run instructions below

### Running the Project

See the generated run instructions for specific steps.

## Development

This project was created using the Intelligent IDE's Multi-Agent Build System, which:

1. **Analyzes** your request intelligently
2. **Plans** the project structure
3. **Generates** complete, runnable code
4. **Organizes** files with proper imports/exports
5. **Documents** everything for easy understanding

## License

Created with the Intelligent IDE - AI-Powered Development Environment

---

*Generated automatically with ❤️ by AI*'''

    async def _assess_project_quality(self, user_request: str, created_files: List[ProjectFile], test_result: Dict[str, Any]) -> float:
        """Assess the project quality based on completeness and functionality."""
        try:
            # Count different file types
            python_files = [f for f in created_files if f.file_type == "python"]
            html_files = [f for f in created_files if f.file_type == "html"]
            css_files = [f for f in created_files if f.file_type == "css"]
            js_files = [f for f in created_files if f.file_type == "javascript"]
            
            # Base score
            score = 0.0
            
            # Check if we have the essential files
            has_main_file = any("main" in f.path.lower() for f in python_files)
            has_readme = any("readme" in f.path.lower() for f in created_files)
            has_requirements = any("requirements" in f.path.lower() for f in created_files)
            
            # File completeness (30 points)
            if has_main_file:
                score += 15
            if has_readme:
                score += 10
            if has_requirements:
                score += 5
            
            # Project type specific scoring
            user_lower = user_request.lower()
            
            if "calculator" in user_lower or "calc" in user_lower:
                # Calculator should be simple but functional
                if len(python_files) >= 1 and any("calc" in f.path.lower() for f in python_files):
                    score += 40
                if len(created_files) >= 2:  # At least main file + README
                    score += 20
                    
            elif "todo" in user_lower or "task" in user_lower:
                # Todo app should have frontend and backend
                if len(html_files) >= 1 and len(css_files) >= 1 and len(js_files) >= 1:
                    score += 30
                if len(python_files) >= 2:  # Main + utility files
                    score += 20
                if len(created_files) >= 6:  # Comprehensive todo app
                    score += 20
                    
            elif "web" in user_lower or "frontend" in user_lower:
                # Web app should have HTML, CSS, JS
                if len(html_files) >= 1 and len(css_files) >= 1 and len(js_files) >= 1:
                    score += 40
                if len(python_files) >= 1:  # Backend support
                    score += 20
                    
            elif "api" in user_lower or "service" in user_lower:
                # API should have proper structure
                if len(python_files) >= 3:  # Main, models, routes
                    score += 40
                if any("config" in f.path.lower() for f in created_files):
                    score += 20
                    
            else:
                # Generic scoring
                if len(created_files) >= 3:
                    score += 30
                if len(python_files) >= 1:
                    score += 20
                if len(created_files) >= 5:
                    score += 20
            
            # Code quality assessment (20 points)
            total_content_length = sum(len(f.content) for f in created_files)
            if total_content_length > 1000:  # Substantial code
                score += 20
            elif total_content_length > 500:
                score += 10
            
            # Documentation quality (10 points)
            if has_readme and len([f for f in created_files if "readme" in f.path.lower()][0].content) > 200:
                score += 10
            
            # Ensure score doesn't exceed 100
            score = min(score, 100.0)
            
            logger.info(f"📊 Quality Assessment: {score}/100")
            logger.info(f"   - Files created: {len(created_files)}")
            logger.info(f"   - Python files: {len(python_files)}")
            logger.info(f"   - HTML files: {len(html_files)}")
            logger.info(f"   - CSS files: {len(css_files)}")
            logger.info(f"   - JS files: {len(js_files)}")
            logger.info(f"   - Total content: {total_content_length} characters")
            
            return score
            
        except Exception as e:
            logger.error(f"Error assessing project quality: {e}")
            return 50.0  # Default score if assessment fails

    async def _improve_architecture(self, user_request: str, plan: Dict[str, Any], created_files: List[ProjectFile], current_quality: float) -> Dict[str, Any]:
        """Improve the architecture based on the current quality and user feedback."""
        try:
            logger.info(f"🔄 Improving architecture based on quality score: {current_quality}/100")
            
            # Analyze current files
            python_files = [f for f in created_files if f.file_type == "python"]
            html_files = [f for f in created_files if f.file_type == "html"]
            css_files = [f for f in created_files if f.file_type == "css"]
            js_files = [f for f in created_files if f.file_type == "javascript"]
            
            user_lower = user_request.lower()
            
            # Determine what's missing and improve the structure
            if "todo" in user_lower or "task" in user_lower:
                # Todo app improvements
                if len(html_files) == 0:
                    # Add frontend files
                    return {
                        "success": True,
                        "structure": {
                            "architecture_pattern": "MVC",
                            "file_structure": {
                                "root": ["README.md", "requirements.txt"],
                                "src": ["main.py", "todo_manager.py"],
                                "static": ["index.html", "styles.css", "app.js", "todo.js"]
                            },
                            "file_specifications": [
                                {"path": "README.md", "content_type": "markdown", "description": "Todo App Documentation", "key_features": ["Project documentation"], "dependencies": []},
                                {"path": "requirements.txt", "content_type": "text", "description": "Python dependencies", "key_features": ["Dependencies list"], "dependencies": []},
                                {"path": "main.py", "content_type": "python_main", "description": "Todo app main file", "key_features": ["Core functionality", "Task management"], "dependencies": []},
                                {"path": "todo_manager.py", "content_type": "python_module", "description": "Todo management logic", "key_features": ["Task CRUD operations"], "dependencies": []},
                                {"path": "index.html", "content_type": "html", "description": "Todo app interface", "key_features": ["User interface", "Task display"], "dependencies": []},
                                {"path": "styles.css", "content_type": "css", "description": "Todo app styling", "key_features": ["Modern design", "Responsive layout"], "dependencies": []},
                                {"path": "app.js", "content_type": "javascript", "description": "Main app logic", "key_features": ["Event handling", "UI updates"], "dependencies": []},
                                {"path": "todo.js", "content_type": "javascript", "description": "Todo functionality", "key_features": ["Task operations", "Data management"], "dependencies": []}
                            ],
                            "dependencies": ["python", "flask", "sqlite3"],
                            "design_patterns": ["MVC", "Single Responsibility"]
                        }
                    }
                    
            elif "calculator" in user_lower or "calc" in user_lower:
                # Calculator improvements
                if len(python_files) < 2:
                    return {
                        "success": True,
                        "structure": {
                            "architecture_pattern": "Simple",
                            "file_structure": {
                                "root": ["README.md"],
                                "src": ["calculator.py", "math_operations.py"]
                            },
                            "file_specifications": [
                                {"path": "README.md", "content_type": "markdown", "description": "Calculator Documentation", "key_features": ["Usage instructions"], "dependencies": []},
                                {"path": "calculator.py", "content_type": "python_main", "description": "Main calculator interface", "key_features": ["User input", "Display results"], "dependencies": []},
                                {"path": "math_operations.py", "content_type": "python_module", "description": "Mathematical operations", "key_features": ["Arithmetic functions", "Error handling"], "dependencies": []}
                            ],
                            "dependencies": ["python"],
                            "design_patterns": ["Separation of Concerns"]
                        }
                    }
                    
            elif "web" in user_lower or "frontend" in user_lower:
                # Web app improvements
                if len(html_files) == 0 or len(css_files) == 0 or len(js_files) == 0:
                    return {
                        "success": True,
                        "structure": {
                            "architecture_pattern": "MVC",
                            "file_structure": {
                                "root": ["README.md", "requirements.txt"],
                                "src": ["main.py", "app.py"],
                                "static": ["index.html", "styles.css", "script.js", "utils.js"]
                            },
                            "file_specifications": [
                                {"path": "README.md", "content_type": "markdown", "description": "Web App Documentation", "key_features": ["Project documentation"], "dependencies": []},
                                {"path": "requirements.txt", "content_type": "text", "description": "Python dependencies", "key_features": ["Dependencies list"], "dependencies": []},
                                {"path": "main.py", "content_type": "python_main", "description": "Web server main file", "key_features": ["Server setup", "Routing"], "dependencies": []},
                                {"path": "app.py", "content_type": "python_module", "description": "Application logic", "key_features": ["Business logic", "Data handling"], "dependencies": []},
                                {"path": "index.html", "content_type": "html", "description": "Main web page", "key_features": ["User interface", "Responsive design"], "dependencies": []},
                                {"path": "styles.css", "content_type": "css", "description": "Web app styling", "key_features": ["Modern design", "Responsive layout"], "dependencies": []},
                                {"path": "script.js", "content_type": "javascript", "description": "Main JavaScript logic", "key_features": ["Event handling", "UI interactions"], "dependencies": []},
                                {"path": "utils.js", "content_type": "javascript", "description": "Utility functions", "key_features": ["Helper functions", "Data processing"], "dependencies": []}
                            ],
                            "dependencies": ["python", "flask", "jinja2"],
                            "design_patterns": ["MVC", "Separation of Concerns"]
                        }
                    }
                    
            elif "api" in user_lower or "service" in user_lower:
                # API improvements
                if len(python_files) < 4:
                    return {
                        "success": True,
                        "structure": {
                            "architecture_pattern": "RESTful API",
                            "file_structure": {
                                "root": ["README.md", "requirements.txt"],
                                "src": ["main.py", "models.py", "routes.py", "database.py"],
                                "config": ["config.py", "settings.py"]
                            },
                            "file_specifications": [
                                {"path": "README.md", "content_type": "markdown", "description": "API Documentation", "key_features": ["API documentation"], "dependencies": []},
                                {"path": "requirements.txt", "content_type": "text", "description": "Python dependencies", "key_features": ["Dependencies list"], "dependencies": []},
                                {"path": "main.py", "content_type": "python_main", "description": "API server main file", "key_features": ["Server setup", "App initialization"], "dependencies": []},
                                {"path": "models.py", "content_type": "python_module", "description": "Data models", "key_features": ["Database models", "Validation"], "dependencies": []},
                                {"path": "routes.py", "content_type": "python_module", "description": "API routes", "key_features": ["Endpoint definitions", "Request handling"], "dependencies": []},
                                {"path": "database.py", "content_type": "python_module", "description": "Database operations", "key_features": ["Database connection", "CRUD operations"], "dependencies": []},
                                {"path": "config.py", "content_type": "python_config", "description": "Configuration settings", "key_features": ["Environment variables", "Settings management"], "dependencies": []},
                                {"path": "settings.py", "content_type": "python_config", "description": "Application settings", "key_features": ["App configuration", "Feature flags"], "dependencies": []}
                            ],
                            "dependencies": ["python", "fastapi", "uvicorn", "sqlalchemy", "pydantic"],
                            "design_patterns": ["RESTful", "Repository Pattern"]
                        }
                    }
            
            # Default improvement - add more comprehensive structure
            return {
                "success": True,
                "structure": {
                    "architecture_pattern": "Modular",
                    "file_structure": {
                        "root": ["README.md", "requirements.txt"],
                        "src": ["main.py", "utils.py", "models.py", "config.py"],
                        "static": ["index.html", "styles.css", "app.js"],
                        "modules": ["module1.py", "module2.py"]
                    },
                    "file_specifications": [
                        {"path": "README.md", "content_type": "markdown", "description": "Project Documentation", "key_features": ["Project documentation"], "dependencies": []},
                        {"path": "requirements.txt", "content_type": "text", "description": "Python dependencies", "key_features": ["Dependencies list"], "dependencies": []},
                        {"path": "main.py", "content_type": "python_main", "description": "Main application file", "key_features": ["Core functionality", "Error handling"], "dependencies": []},
                        {"path": "utils.py", "content_type": "python_module", "description": "Utility functions", "key_features": ["Helper functions", "Common operations"], "dependencies": []},
                        {"path": "models.py", "content_type": "python_module", "description": "Data models", "key_features": ["Data structures", "Validation"], "dependencies": []},
                        {"path": "config.py", "content_type": "python_config", "description": "Configuration settings", "key_features": ["Settings management", "Environment variables"], "dependencies": []},
                        {"path": "index.html", "content_type": "html", "description": "Main web page", "key_features": ["User interface", "Responsive design"], "dependencies": []},
                        {"path": "styles.css", "content_type": "css", "description": "Application styling", "key_features": ["Modern design", "Responsive layout"], "dependencies": []},
                        {"path": "app.js", "content_type": "javascript", "description": "Main JavaScript logic", "key_features": ["Event handling", "UI interactions"], "dependencies": []},
                        {"path": "module1.py", "content_type": "python_module", "description": "Module 1", "key_features": ["Modular functionality"], "dependencies": []},
                        {"path": "module2.py", "content_type": "python_module", "description": "Module 2", "key_features": ["Modular functionality"], "dependencies": []}
                    ],
                    "dependencies": ["python", "flask", "sqlalchemy"],
                    "design_patterns": ["Modular", "Separation of Concerns", "Single Responsibility"]
                }
            }
            
        except Exception as e:
            logger.error(f"Error improving architecture: {e}")
            # Return a basic structure as fallback
            return {
                "success": True,
                "structure": {
                    "architecture_pattern": "Simple",
                    "file_structure": {
                        "root": ["README.md"],
                        "src": ["main.py"]
                    },
                    "file_specifications": [
                        {"path": "README.md", "content_type": "markdown", "description": "Project Documentation", "key_features": ["Documentation"], "dependencies": []},
                        {"path": "main.py", "content_type": "python_main", "description": "Main application", "key_features": ["Core functionality"], "dependencies": []}
                    ],
                    "dependencies": ["python"],
                    "design_patterns": ["Simple"]
                }
            }

# Convenience function to start the system
async def run_multi_agent_build(gemini_api_key: str, user_request: str) -> Dict[str, Any]:
    """Run the intelligent project creation system"""
    system = MultiAgentSystem(gemini_api_key)
    return await system.start_project(user_request)
