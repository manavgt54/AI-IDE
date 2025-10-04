import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import path from 'path'
import fs from 'fs-extra'
import crypto from 'crypto'

// SQLite database configuration
const DB_PATH = process.env.SQLITE_DB_PATH || './data/ide.db'
const DATA_DIR = path.dirname(DB_PATH)

let db = null

// Ensure data directory exists
await fs.ensureDir(DATA_DIR)

export async function getDatabase() {
  if (!db) {
    console.log('🗄️ SQLite: Opening database connection...')
    console.log('🗄️ SQLite: Database path:', path.resolve(DB_PATH))
    
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    })
    
    // Enable foreign keys and WAL mode for better performance
    await db.exec('PRAGMA foreign_keys = ON')
    await db.exec('PRAGMA journal_mode = WAL')
    await db.exec('PRAGMA synchronous = NORMAL')
    await db.exec('PRAGMA cache_size = 1000')
    await db.exec('PRAGMA temp_store = MEMORY')
    
    console.log('✅ SQLite: Database connection established')
  }
  return db
}

export async function initSchema() {
  console.log('🗄️ SQLite: Initializing database schema...')
  const database = await getDatabase()
  
  try {
    // Create users table
    await database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_id TEXT UNIQUE,
        github_id TEXT UNIQUE,
        email TEXT,
        name TEXT,
        github_token TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    console.log('✅ SQLite: Users table created')

    // Create sessions table with unique terminal verification
    await database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        terminal_token TEXT UNIQUE NOT NULL,
        workspace_path TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
    console.log('✅ SQLite: Sessions table created')

    // Create files table with session isolation
    await database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content BLOB,
        file_size INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        UNIQUE(session_id, filename)
      )
    `)
    console.log('✅ SQLite: Files table created')

    // Create indexes for better performance
    await database.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_terminal ON sessions(terminal_token);
      CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
      CREATE INDEX IF NOT EXISTS idx_files_name ON files(filename);
      CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);
      CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `)
    console.log('✅ SQLite: Indexes created')
    
    console.log('✅ SQLite: Database schema initialized successfully')
  } catch (error) {
    console.error('❌ SQLite: Schema initialization failed:', error)
    throw error
  }
}

// Generate unique terminal token for session verification
function generateTerminalToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Generate unique workspace path for session isolation
function generateWorkspacePath(userId, sessionId) {
  // Use forward slashes for Linux containers, normalize the path
  const workspacePath = path.resolve('./workspaces', `user_${userId}`, sessionId)
  return workspacePath.replace(/\\/g, '/')
}

export async function upsertUserAndCreateSession({ googleId, email, provider, githubId, githubToken, name }) {
  console.log('🗄️ SQLite: Starting upsertUserAndCreateSession for:', { googleId, email, provider, githubId })
  const database = await getDatabase()
  
  try {
    await database.run('BEGIN TRANSACTION')
    console.log('🗄️ SQLite: Transaction started')
    
    // Find existing user
    let user
    if (provider === 'github') {
      user = await database.get(
        'SELECT id FROM users WHERE github_id = ? OR email = ? LIMIT 1',
        [githubId || null, email || null]
      )
    } else {
      user = await database.get(
        'SELECT id FROM users WHERE google_id = ? OR email = ? LIMIT 1',
        [googleId || null, email || null]
      )
    }
    
    let userId
    if (user) {
      userId = user.id
      console.log('🗄️ SQLite: Found existing user:', userId)
      
      // Update user info if needed (for GitHub users)
      if (provider === 'github' && (githubId || name)) {
        await database.run(
          'UPDATE users SET github_id = ?, name = ?, github_token = ? WHERE id = ?',
          [githubId || null, name || null, githubToken || null, userId]
        )
        console.log('🗄️ SQLite: Updated user GitHub info')
      }
    } else {
      // Create new user based on provider
      if (provider === 'github') {
        const result = await database.run(
          'INSERT INTO users (github_id, email, name, github_token) VALUES (?, ?, ?, ?)',
          [githubId || null, email || null, name || null, githubToken || null]
        )
        userId = result.lastID
        console.log('🗄️ SQLite: Created new GitHub user:', userId)
      } else {
        const result = await database.run(
          'INSERT INTO users (google_id, email, name) VALUES (?, ?, ?)',
          [googleId || null, email || null, name || null]
        )
        userId = result.lastID
        console.log('🗄️ SQLite: Created new Google user:', userId)
      }
    }

    // Check if user already has an active session
    const existingSession = await database.get(
      'SELECT session_id, terminal_token, workspace_path FROM sessions WHERE user_id = ? AND is_active = 1 LIMIT 1',
      [userId]
    )
    
    let sessionId, terminalToken, workspacePath
    if (existingSession) {
      // Reuse existing active session
      sessionId = existingSession.session_id
      terminalToken = existingSession.terminal_token
      workspacePath = existingSession.workspace_path
      
      // Update last activity
      await database.run(
        'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = ?',
        [sessionId]
      )
      
      console.log('🗄️ SQLite: Reusing existing active session:', sessionId)
    } else {
      // Create new isolated session
      sessionId = `session_${userId}_${Date.now()}`
      terminalToken = generateTerminalToken()
      workspacePath = generateWorkspacePath(userId, sessionId)
      
      console.log('🗄️ SQLite: Creating new isolated session:', sessionId)
      console.log('🗄️ SQLite: Terminal token:', terminalToken)
      console.log('🗄️ SQLite: Workspace path:', workspacePath)
      
      await database.run(
        'INSERT INTO sessions (session_id, user_id, terminal_token, workspace_path) VALUES (?, ?, ?, ?)',
        [sessionId, userId, terminalToken, workspacePath]
      )
      
      // Ensure workspace directory exists
      await fs.ensureDir(workspacePath)
      console.log('🗄️ SQLite: Workspace directory created:', workspacePath)
    }

    await database.run('COMMIT')
    console.log('🗄️ SQLite: Transaction committed')
    
    return { 
      userId, 
      sessionId, 
      terminalToken, 
      workspacePath 
    }
  } catch (error) {
    console.error('🗄️ SQLite: Error in upsertUserAndCreateSession:', error)
    await database.run('ROLLBACK')
    throw error
  }
}

export async function verifyTerminalSession(sessionId, terminalToken) {
  const database = await getDatabase()
  
  try {
    const session = await database.get(
      'SELECT session_id, user_id, workspace_path, is_active FROM sessions WHERE session_id = ? AND terminal_token = ? AND is_active = 1',
      [sessionId, terminalToken]
    )
    
    if (session) {
      // Update last activity
      await database.run(
        'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = ?',
        [sessionId]
      )
      
      console.log('✅ SQLite: Terminal session verified:', sessionId)
      return session
    }
    
    console.log('❌ SQLite: Terminal session verification failed:', sessionId)
    return null
  } catch (error) {
    console.error('❌ SQLite: Error verifying terminal session:', error)
    throw error
  }
}

export async function saveFile({ sessionId, filename, content }) {
  const database = await getDatabase()
  
  try {
    const contentBuffer = Buffer.from(content)
    const fileSize = contentBuffer.length
    
    // Try to update existing file first
    const updateResult = await database.run(
      'UPDATE files SET content = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND filename = ?',
      [contentBuffer, fileSize, sessionId, filename]
    )
    
    // If no rows were updated, insert new file
    if (updateResult.changes === 0) {
      await database.run(
        'INSERT INTO files (session_id, filename, content, file_size) VALUES (?, ?, ?, ?)',
        [sessionId, filename, contentBuffer, fileSize]
      )
      console.log('✅ SQLite: File created:', { sessionId, filename, contentLength: content.length })
    } else {
      console.log('✅ SQLite: File updated:', { sessionId, filename, contentLength: content.length })
    }
  } catch (error) {
    console.error('❌ SQLite: Error saving file:', error)
    throw error
  }
}

export async function batchSaveFiles({ sessionId, files }) {
  const database = await getDatabase()
  
  try {
    await database.run('BEGIN TRANSACTION')
    console.log(`📦 SQLite: Starting batch save of ${files.length} files for session: ${sessionId}`)
    
    let savedCount = 0
    let updatedCount = 0
    let errorCount = 0
    
    for (const { filename, content } of files) {
      try {
        const contentBuffer = Buffer.from(content)
        const fileSize = contentBuffer.length
        
        // Try to update existing file first
        const updateResult = await database.run(
          'UPDATE files SET content = ?, file_size = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND filename = ?',
          [contentBuffer, fileSize, sessionId, filename]
        )
        
        // If no rows were updated, insert new file
        if (updateResult.changes === 0) {
          await database.run(
            'INSERT INTO files (session_id, filename, content, file_size) VALUES (?, ?, ?, ?)',
            [sessionId, filename, contentBuffer, fileSize]
          )
          savedCount++
          console.log(`✅ SQLite: INSERTED file: ${filename} (${content.length} bytes)`)
        } else {
          updatedCount++
          console.log(`✅ SQLite: UPDATED file: ${filename} (${content.length} bytes)`)
        }
      } catch (fileError) {
        console.error(`❌ SQLite: Error saving file ${filename}:`, fileError)
        errorCount++
      }
    }
    
    await database.run('COMMIT')
    console.log(`✅ SQLite: Batch save completed - Saved: ${savedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`)
    
    // Verify data was actually saved
    const verifyResult = await database.get(
      'SELECT COUNT(*) as count FROM files WHERE session_id = ?',
      [sessionId]
    )
    console.log(`🔍 SQLite: Verification - Total files in DB for session: ${verifyResult.count}`)
    
    return {
      success: true,
      saved: savedCount,
      updated: updatedCount,
      errors: errorCount,
      total: files.length
    }
  } catch (error) {
    await database.run('ROLLBACK')
    console.error('❌ SQLite: Batch save transaction failed:', error)
    throw error
  }
}

export async function readFileByName({ sessionId, filename }) {
  const database = await getDatabase()
  
  try {
    const row = await database.get(
      'SELECT content FROM files WHERE session_id = ? AND filename = ? LIMIT 1',
      [sessionId, filename]
    )
    
    if (row && row.content !== null && row.content !== undefined) {
      // Handle both Buffer and string content
      if (Buffer.isBuffer(row.content)) {
        return row.content.toString('utf8')
      } else if (typeof row.content === 'string') {
        return row.content
      } else {
        console.log('⚠️ SQLite: Unexpected content type for:', filename, typeof row.content)
        return String(row.content)
      }
    }
    
    console.log('⚠️ SQLite: File not found:', filename)
    return null
  } catch (error) {
    console.error('❌ SQLite: Error reading file:', error)
    throw error
  }
}

export async function listFilesBySession(sessionId) {
  const database = await getDatabase()
  
  try {
    const rows = await database.all(
      'SELECT filename, file_size, created_at, updated_at FROM files WHERE session_id = ? ORDER BY filename',
      [sessionId]
    )
    return rows
  } catch (error) {
    console.error('❌ SQLite: Error listing files:', error)
    throw error
  }
}

export async function deleteFileByName({ sessionId, filename }) {
  const database = await getDatabase()
  
  try {
    await database.run(
      'DELETE FROM files WHERE session_id = ? AND filename = ?',
      [sessionId, filename]
    )
    console.log('✅ SQLite: File deleted:', { sessionId, filename })
  } catch (error) {
    console.error('❌ SQLite: Error deleting file:', error)
    throw error
  }
}

export async function deleteSession(sessionId) {
  const database = await getDatabase()
  
  try {
    await database.run('BEGIN TRANSACTION')
    
    // Get session info for cleanup
    const session = await database.get(
      'SELECT workspace_path FROM sessions WHERE session_id = ?',
      [sessionId]
    )
    
    // Delete files (cascade will handle this, but explicit for clarity)
    await database.run(
      'DELETE FROM files WHERE session_id = ?',
      [sessionId]
    )
    
    // Mark session as inactive instead of deleting (for audit trail)
    await database.run(
      'UPDATE sessions SET is_active = 0 WHERE session_id = ?',
      [sessionId]
    )
    
    await database.run('COMMIT')
    
    // Clean up workspace directory
    if (session && session.workspace_path) {
      try {
        await fs.remove(session.workspace_path)
        console.log('🗑️ SQLite: Workspace directory cleaned up:', session.workspace_path)
      } catch (cleanupError) {
        console.warn('⚠️ SQLite: Failed to cleanup workspace directory:', cleanupError.message)
      }
    }
    
    console.log('✅ SQLite: Session deactivated:', sessionId)
    return true
  } catch (error) {
    await database.run('ROLLBACK')
    console.error('❌ SQLite: Error deleting session:', error)
    throw error
  }
}

export async function getSessionInfo(sessionId) {
  const database = await getDatabase()
  
  try {
    const row = await database.get(
      `SELECT s.session_id, s.user_id, u.email, s.terminal_token, s.workspace_path, 
              s.is_active, s.created_at, s.last_activity 
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.session_id = ?`,
      [sessionId]
    )
    
    return row || null
  } catch (error) {
    console.error('❌ SQLite: Error getting session info:', error)
    throw error
  }
}

export async function getUserSessionByGoogleAccount({ googleId, email }) {
  const database = await getDatabase()
  
  try {
    const row = await database.get(
      `SELECT u.id, u.google_id, u.email, s.session_id, s.terminal_token, s.workspace_path
       FROM users u 
       LEFT JOIN sessions s ON u.id = s.user_id AND s.is_active = 1
       WHERE u.google_id = ? OR u.email = ? 
       LIMIT 1`,
      [googleId || null, email || null]
    )
    
    if (row) {
      if (row.session_id) {
        console.log('✅ SQLite: Found existing session for user:', { userId: row.id, sessionId: row.session_id })
        return { 
          userId: row.id, 
          sessionId: row.session_id, 
          terminalToken: row.terminal_token,
          workspacePath: row.workspace_path 
        }
      } else {
        console.log('⚠️ SQLite: User exists but no active session found:', { userId: row.id })
        return null
      }
    }
    
    console.log('ℹ️ SQLite: No user found for:', { googleId, email })
    return null
  } catch (error) {
    console.error('❌ SQLite: Error getting user session:', error)
    throw error
  }
}

// Clean up inactive sessions older than specified hours
export async function cleanupExpiredSessions(maxAgeHours = 168) { // 7 days default
  const database = await getDatabase()
  
  try {
    console.log(`🧹 SQLite: Cleaning up sessions inactive for ${maxAgeHours} hours...`)
    
    // Get sessions to cleanup
    const sessionsToCleanup = await database.all(
      `SELECT session_id, workspace_path FROM sessions 
       WHERE is_active = 1 AND datetime(last_activity, '+${maxAgeHours} hours') < datetime('now')`
    )
    
    let cleanedCount = 0
    for (const session of sessionsToCleanup) {
      try {
        await deleteSession(session.session_id)
        cleanedCount++
      } catch (error) {
        console.error(`⚠️ SQLite: Failed to cleanup session ${session.session_id}:`, error.message)
      }
    }
    
    console.log(`🧹 SQLite: Cleaned up ${cleanedCount} expired sessions`)
    return cleanedCount
  } catch (error) {
    console.error('⚠️ SQLite: Error cleaning up expired sessions:', error.message)
    return 0
  }
}

// Verify database data and connection
export async function verifyDatabaseData(sessionId) {
  const database = await getDatabase()
  
  try {
    console.log('🔍 SQLite: Verifying database data...')
    console.log('🔍 SQLite: Database path:', path.resolve(DB_PATH))
    
    // Test connection
    const connectionTest = await database.get('SELECT 1 as test')
    console.log('✅ SQLite: Connection test successful:', connectionTest)
    
    // Check users table
    const users = await database.get('SELECT COUNT(*) as count FROM users')
    console.log(`📊 SQLite: Users in database: ${users.count}`)
    
    // Check sessions table
    const sessions = await database.get('SELECT COUNT(*) as count FROM sessions WHERE is_active = 1')
    console.log(`📊 SQLite: Active sessions in database: ${sessions.count}`)
    
    // Check files table
    const files = await database.get('SELECT COUNT(*) as count FROM files')
    console.log(`📊 SQLite: Total files in database: ${files.count}`)
    
    // Check files for specific session
    if (sessionId) {
      const sessionFiles = await database.get('SELECT COUNT(*) as count FROM files WHERE session_id = ?', [sessionId])
      console.log(`📊 SQLite: Files for session ${sessionId}: ${sessionFiles.count}`)
      
      // Get sample files for this session
      const sampleFiles = await database.all('SELECT filename, file_size FROM files WHERE session_id = ? LIMIT 5', [sessionId])
      console.log('📄 SQLite: Sample files for session:')
      sampleFiles.forEach(file => {
        console.log(`  - ${file.filename} (${file.file_size} bytes)`)
      })
    }
    
    return {
      connection: true,
      users: users.count,
      sessions: sessions.count,
      totalFiles: files.count,
      sessionFiles: sessionId ? (await database.get('SELECT COUNT(*) as count FROM files WHERE session_id = ?', [sessionId])).count : 0
    }
  } catch (error) {
    console.error('❌ SQLite: Database verification failed:', error)
    throw error
  }
}

// Get database statistics
export async function getDatabaseStats() {
  const database = await getDatabase()
  
  try {
    const stats = await database.get(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM sessions WHERE is_active = 1) as active_sessions,
        (SELECT COUNT(*) FROM sessions WHERE is_active = 0) as inactive_sessions,
        (SELECT COUNT(*) FROM files) as total_files,
        (SELECT SUM(file_size) FROM files) as total_file_size
    `)
    
    return stats
  } catch (error) {
    console.error('❌ SQLite: Error getting database stats:', error)
    throw error
  }
}