import path from 'path'
import { getPersistMaxFileMb, getPersistExcludeDirs } from '../config/env.js'

export function normalizeWorkspacePath(p) {
  return path.resolve(p).replace(/\\/g, '/')
}

export function isExcludedPath(relPath) {
  if (!relPath) return false
  const p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = p.split('/')
  const excluded = getPersistExcludeDirs()
  // Exclude if any path segment matches excluded dirs
  return parts.some(seg => excluded.includes(seg))
}

export function isTooLarge(byteLength) {
  const maxBytes = Math.max(0, getPersistMaxFileMb()) * 1024 * 1024
  return maxBytes > 0 && byteLength > maxBytes
}

export function shouldPersistInDb(relPath, content) {
  if (isExcludedPath(relPath)) return false
  const length = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ''), 'utf8')
  if (isTooLarge(length)) return false
  return true
}














