from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Dict, Any, Optional
import asyncio
import logging
from multi_agent_system import MultiAgentSystem
from config import GEMINI_API_KEY

router = APIRouter(prefix="/multi-agent", tags=["multi-agent"])

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class BuildRequest(BaseModel):
    user_request: str

class BuildResponse(BaseModel):
    build_id: str
    status: str
    message: str

class FileOperationRequest(BaseModel):
    file_path: str

class FileOperationResponse(BaseModel):
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None

# Store active builds
active_builds: Dict[str, Dict[str, Any]] = {}

@router.post("/start-build", response_model=BuildResponse)
async def start_build(request: BuildRequest, background_tasks: BackgroundTasks):
    """Start a new multi-agent build process"""
    try:
        build_id = f"build_{len(active_builds) + 1}_{int(asyncio.get_event_loop().time())}"
        
        # Initialize the build
        active_builds[build_id] = {
            "status": "starting",
            "user_request": request.user_request,
            "progress": 0,
            "logs": []
        }
        
        # Start the build in background
        background_tasks.add_task(run_build_process, build_id, request.user_request)
        
        return BuildResponse(
            build_id=build_id,
            status="started",
            message="Build process started successfully"
        )
        
    except Exception as e:
        logger.error(f"Failed to start build: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/build-status/{build_id}")
async def get_build_status(build_id: str):
    """Get the status of a specific build"""
    if build_id not in active_builds:
        raise HTTPException(status_code=404, detail="Build not found")
    
    return active_builds[build_id]

@router.get("/list-builds")
async def list_builds():
    """List all active builds"""
    return {
        "active_builds": len(active_builds),
        "builds": [
            {
                "build_id": bid,
                "status": build["status"],
                "user_request": build["user_request"],
                "progress": build["progress"]
            }
            for bid, build in active_builds.items()
        ]
    }

@router.delete("/cancel-build/{build_id}")
async def cancel_build(build_id: str):
    """Cancel a specific build"""
    if build_id not in active_builds:
        raise HTTPException(status_code=404, detail="Build not found")
    
    active_builds[build_id]["status"] = "cancelled"
    return {"message": f"Build {build_id} cancelled successfully"}

@router.delete("/delete-file", response_model=FileOperationResponse)
async def delete_file(request: FileOperationRequest):
    """Delete a file from the workspace"""
    try:
        system = MultiAgentSystem(GEMINI_API_KEY)
        result = await system.delete_file(request.file_path)
        
        return FileOperationResponse(
            success=result["success"],
            message=result["message"],
            data=result
        )
        
    except Exception as e:
        logger.error(f"Failed to delete file: {e}")
        return FileOperationResponse(
            success=False,
            message=f"Failed to delete file: {str(e)}"
        )

@router.get("/list-workspace-files")
async def list_workspace_files():
    """List all files in the workspace"""
    try:
        system = MultiAgentSystem(GEMINI_API_KEY)
        result = await system.list_workspace_files()
        
        if result["success"]:
            return {
                "success": True,
                "files": result["files"],
                "total_files": result["total_files"]
            }
        else:
            raise HTTPException(status_code=500, detail=result["error"])
            
    except Exception as e:
        logger.error(f"Failed to list workspace files: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def run_build_process(build_id: str, user_request: str):
    """Run the build process in the background"""
    try:
        # Update build status
        active_builds[build_id]["status"] = "running"
        active_builds[build_id]["progress"] = 25
        
        # Initialize the multi-agent system
        system = MultiAgentSystem(GEMINI_API_KEY)
        
        # Update progress
        active_builds[build_id]["progress"] = 50
        
        # Start the project creation
        result = await system.start_project(user_request)
        
        # Update build status
        if result["status"] == "completed":
            active_builds[build_id]["status"] = "completed"
            active_builds[build_id]["progress"] = 100
            active_builds[build_id]["result"] = result
        else:
            active_builds[build_id]["status"] = "failed"
            active_builds[build_id]["error"] = result.get("message", "Unknown error")
        
        logger.info(f"Build {build_id} completed with status: {result['status']}")
        
    except Exception as e:
        logger.error(f"Build {build_id} failed: {e}")
        active_builds[build_id]["status"] = "failed"
        active_builds[build_id]["error"] = str(e)
        active_builds[build_id]["progress"] = 0

