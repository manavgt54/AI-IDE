import os
import aiohttp
import asyncio
from typing import Optional, Dict


class JDoodleClient:
	"""Lightweight JDoodle execute API client."""

	def __init__(self, client_id: Optional[str], client_secret: Optional[str]):
		self.client_id = client_id
		self.client_secret = client_secret
		self.base_url = "https://api.jdoodle.com/v1/execute"

	def is_configured(self) -> bool:
		return bool(self.client_id and self.client_secret)

	async def execute(self, language: str, code: str, stdin: str = "", version_index: str = "0") -> Dict[str, str]:
		"""Execute code via JDoodle. Returns dict with stdout and stderr keys."""
		if not self.is_configured():
			return {"stdout": "", "stderr": "JDoodle credentials not configured on server"}

		payload = {
			"clientId": self.client_id,
			"clientSecret": self.client_secret,
			"script": code,
			"stdin": stdin or "",
			"language": language,
			"versionIndex": version_index,
		}

		timeout = aiohttp.ClientTimeout(total=30)
		async with aiohttp.ClientSession(timeout=timeout) as session:
			async with session.post(self.base_url, json=payload) as resp:
				data = await resp.json(content_type=None)
				# JDoodle returns fields: output, statusCode, memory, cpuTime, error(if any)
				stdout = data.get("output") or ""
				error = data.get("error") or ""
				# For compatibility, expose output in stdout, and error in stderr
				return {"stdout": stdout, "stderr": error}


