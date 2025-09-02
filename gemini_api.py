import google.generativeai as genai
import asyncio
import logging
from typing import Dict, List, Optional
from config import GEMINI_API_KEY, GEMINI_MODEL

logger = logging.getLogger(__name__)

class GeminiAPI:
    """Integration with Google Gemini API for AI code generation and editing"""
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel(GEMINI_MODEL)
        
    async def generate_code(self, prompt: str, model: str = GEMINI_MODEL, 
                           max_tokens: int = 4000, temperature: float = 0.7) -> Dict:
        """Generate code using the Gemini API"""
        try:
            # Use a very simple, compliant prompt
            system_prompt = "JSON."
            
            full_prompt = f"{system_prompt}\n\n{prompt}"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=temperature,
                    max_output_tokens=max_tokens
                )
            )
            
            # Check for blocked responses
            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'finish_reason') and candidate.finish_reason == 2:
                    return {
                        "success": False,
                        "error": "Response blocked by content policy. Please try a different approach."
                    }
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error calling Gemini API: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def architect_solution(self, prompt: str, context: str = "", model: str = GEMINI_MODEL) -> Dict:
        """Get architectural guidance using Gemini"""
        try:
            system_prompt = """JSON."""
            
            full_prompt = f"{system_prompt}\n\nContext: {context}\n\nUser request: {prompt}"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.4,
                    max_output_tokens=5000
                )
            )
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error calling Gemini API for architecture: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def review_code(self, context: str, review_type: str = "general", model: str = GEMINI_MODEL) -> Dict:
        """Review code using Gemini"""
        try:
            system_prompt = """JSON."""
            
            full_prompt = f"{system_prompt}\n\nCode to review:\n{context}\n\nReview type: {review_type}"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.5,
                    max_output_tokens=4000
                )
            )
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error calling Gemini API for code review: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def debug_code(self, context: str, prompt: str, model: str = GEMINI_MODEL) -> Dict:
        """Debug code using Gemini"""
        try:
            system_prompt = """JSON."""
            
            full_prompt = f"{system_prompt}\n\nCode to debug:\n{context}\n\nDebug request: {prompt}"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.3,
                    max_output_tokens=4000
                )
            )
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error calling Gemini API for debugging: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def chat(self, message: str, context: str = "", model: str = GEMINI_MODEL) -> Dict:
        """Simple chat using Gemini"""
        try:
            # Check if this is a Python code execution request
            if "Execute this Python code" in message:
                # Handle Python code execution specifically
                return await self._execute_python_code(message, context, model)
            
            # Use JSON-based communication to avoid content policy violations
            system_prompt = "JSON."
            
            full_prompt = f"{system_prompt}\n\n{message}"
            if context:
                full_prompt += f"\n\nContext: {context}"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.3,  # Lower temperature for more consistent responses
                    max_output_tokens=3000  # Reduced token limit
                )
            )
            
            # Check for blocked responses
            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'finish_reason') and candidate.finish_reason == 2:
                    logger.warning("Content policy violation detected, using fallback")
                    return {
                        "success": False,
                        "error": "Content policy violation - using fallback"
                    }
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error calling Gemini API for chat: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def _execute_python_code(self, message: str, context: str = "", model: str = GEMINI_MODEL) -> Dict:
        """Execute Python code using Gemini"""
        try:
            # Extract the Python code from the message
            code_start = message.find(": ") + 2
            python_code = message[code_start:].strip()
            
            system_prompt = """You are a Python code execution assistant. Your role is to:
            - Execute Python code and return the result
            - Handle mathematical calculations (e.g., 5+5 should return 10)
            - Execute Python expressions and return their values
            - Provide clear, formatted output
            - If there's an error, explain what went wrong
            
            IMPORTANT: Return ONLY the result of the execution, formatted clearly.
            For calculations, show both the expression and result.
            For complex operations, show the output step by step."""
            
            full_prompt = f"{system_prompt}\n\nPython code to execute:\n{python_code}\n\nContext: {context}\n\nPlease execute this code and return the result:"
            
            response = await asyncio.to_thread(
                self.model.generate_content,
                full_prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.1,  # Low temperature for consistent execution
                    max_output_tokens=2000
                )
            )
            
            if response.text:
                return {
                    "success": True,
                    "content": response.text,
                    "usage": {"total_tokens": len(response.text.split())},
                    "model": model
                }
            else:
                return {
                    "success": False,
                    "error": "No content generated"
                }
                
        except Exception as e:
            logger.error(f"Error executing Python code with Gemini: {e}")
            return {
                "success": False,
                "error": str(e)
            }
