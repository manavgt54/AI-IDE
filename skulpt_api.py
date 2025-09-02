import aiohttp
import json
import asyncio
from typing import Dict, List, Optional
import logging

logger = logging.getLogger(__name__)

class SkulptAPI:
    """Integration with Skulpt API for AI code generation and editing"""
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        # Use OpenRouter for model access with sk-or-* keys
        self.base_url = "https://openrouter.ai/api/v1"
        # Use the provided API key directly
        token = api_key
        self.headers = {
            "Authorization": f"Bearer {token}",
            # Optional metadata headers; static defaults
            "HTTP-Referer": "http://localhost",
            "X-Title": "VSCode-like IDE",
            "Content-Type": "application/json"
        }
    
    async def generate_code(self, prompt: str, model: str = "openai/gpt-3.5-turbo", 
                           max_tokens: int = 4000, temperature: float = 0.7) -> Dict:
        """Generate code using the Skulpt API"""
        try:
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are an expert software developer. Generate clean, efficient, and well-documented code based on the user's request."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stream": False
            }
            
            # Simple retry on transient errors (429/5xx/network)
            attempts = 0
            last_error = None
            async with aiohttp.ClientSession() as session:
                while attempts < 3:
                    try:
                        async with session.post(
                            f"{self.base_url}/chat/completions",
                            headers=self.headers,
                            json=payload,
                            timeout=aiohttp.ClientTimeout(total=60)
                        ) as response:
                            if response.status == 200:
                                result = await response.json()
                                return {
                                    "success": True,
                                    "content": result.get("choices", [{}])[0].get("message", {}).get("content", ""),
                                    "usage": result.get("usage", {}),
                                    "model": result.get("model", "")
                                }
                            else:
                                error_text = await response.text()
                                # If rate-limited, provide a friendly message
                                if response.status == 429:
                                    return {
                                        "success": False,
                                        "error": "The AI provider is temporarily rate-limited. Please retry in a moment or add your own provider key."
                                    }
                                # Retry on 5xx
                                if 500 <= response.status < 600:
                                    attempts += 1
                                    await asyncio.sleep(0.5 * (2 ** (attempts - 1)))
                                    continue
                                logger.error(f"API error {response.status}: {error_text}")
                                return {"success": False, "error": f"API error {response.status}: {error_text}"}
                    except Exception as e:
                        last_error = str(e)
                        attempts += 1
                        await asyncio.sleep(0.5 * (2 ** (attempts - 1)))
                return {"success": False, "error": last_error or "Unknown error"}
                        
        except asyncio.TimeoutError:
            return {
                "success": False,
                "error": "Request timed out"
            }
        except Exception as e:
            logger.error(f"Error calling Skulpt API: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def edit_code(self, file_content: str, edit_instructions: str, 
                       model: str = "qwen/qwen3-coder:free") -> Dict:
        """Edit existing code based on instructions"""
        prompt = f"""
Please edit the following code based on these instructions: {edit_instructions}

Current code:
{file_content}

Provide the complete updated code with your changes. Make sure to:
1. Follow the existing code style and formatting
2. Maintain all functionality
3. Only make the requested changes
4. Include proper error handling if relevant
"""
        
        return await self.generate_code(prompt, model, max_tokens=6000, temperature=0.3)
    
    async def review_code(self, file_content: str, review_focus: str = "general",
                         model: str = "qwen/qwen3-coder:free") -> Dict:
        """Review code and provide feedback"""
        prompt = f"""
Please review the following code with focus on: {review_focus}

Code to review:
{file_content}

Provide a comprehensive code review covering:
1. Code quality and readability
2. Potential bugs or issues
3. Performance considerations
4. Security concerns (if applicable)
5. Best practices and improvements
6. Specific suggestions for enhancement

Be constructive and provide actionable feedback.
"""
        
        return await self.generate_code(prompt, model, max_tokens=4000, temperature=0.5)
    
    async def debug_code(self, file_content: str, error_message: str = "",
                        model: str = "qwen/qwen3-coder:free") -> Dict:
        """Debug code and provide solutions"""
        prompt = f"""
Please help debug the following code:

Code:
{file_content}

Error/Issue: {error_message if error_message else "General debugging requested"}

Please provide:
1. Analysis of potential issues
2. Specific debugging steps
3. Suggested fixes
4. Prevention strategies for similar issues
5. Code improvements if applicable
"""
        
        return await self.generate_code(prompt, model, max_tokens=4000, temperature=0.3)
    
    async def architect_solution(self, requirements: str, existing_code: str = "",
                               model: str = "qwen/qwen3-coder:free") -> Dict:
        """Design architectural solutions"""
        prompt = f"""
As a system architect, please design a solution for the following requirements:

Requirements: {requirements}

Existing Code Context (if any):
{existing_code}

Please provide:
1. High-level architecture design
2. Code structure recommendations
3. File organization suggestions
4. Design patterns to use
5. Implementation roadmap
6. Code examples for key components
"""
        
        return await self.generate_code(prompt, model, max_tokens=5000, temperature=0.4)
    
    async def batch_process(self, requests: List[Dict]) -> List[Dict]:
        """Process multiple requests in parallel"""
        tasks = []
        
        for req in requests:
            if req["type"] == "generate":
                task = self.generate_code(req["prompt"], req.get("model"), 
                                       req.get("max_tokens", 4000), req.get("temperature", 0.7))
            elif req["type"] == "edit":
                task = self.edit_code(req["file_content"], req["edit_instructions"], req.get("model"))
            elif req["type"] == "review":
                task = self.review_code(req["file_content"], req.get("review_focus", "general"), req.get("model"))
            elif req["type"] == "debug":
                task = self.debug_code(req["file_content"], req.get("error_message", ""), req.get("model"))
            elif req["type"] == "architect":
                task = self.architect_solution(req["requirements"], req.get("existing_code", ""), req.get("model"))
            else:
                task = asyncio.create_task(asyncio.sleep(0))  # Placeholder for unknown types
            
            tasks.append(task)
        
        # Execute all tasks in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Process results
        processed_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                processed_results.append({
                    "success": False,
                    "error": str(result),
                    "request_index": i
                })
            else:
                processed_results.append({
                    "success": True,
                    "result": result,
                    "request_index": i
                })
        
        return processed_results
