import mysql from 'mysql2/promise'

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || 'mysql-24b00d04-dekatc-d39e.h.aivencloud.com',
  user: process.env.MYSQL_USER || 'avnadmin',
  password: process.env.MYSQL_PASSWORD || 'AVNS_FkeJInRYwsl-nOBEGIz',
  database: process.env.MYSQL_DATABASE || 'defaultdb',
  port: parseInt(process.env.MYSQL_PORT || '14386'),
  ssl: { rejectUnauthorized: false },
  // Add connection timeout settings
  connectTimeout: 60000, // 60 seconds
  acquireTimeout: 60000, // 60 seconds
  timeout: 60000, // 60 seconds
  // Add connection pool settings
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Add retry settings
  maxRetries: 3,
  retryDelay: 1000,
}

let pool

export async function getPool() {
  if (!pool) {
    console.log('🗄️ MySQL: Creating connection pool...');
    console.log('🗄️ MySQL: Host:', DB_CONFIG.host);
    console.log('🗄️ MySQL: Port:', DB_CONFIG.port);
    console.log('🗄️ MySQL: Database:', DB_CONFIG.database);
    console.log('🗄️ MySQL: User:', DB_CONFIG.user);
    
    pool = mysql.createPool({
      ...DB_CONFIG,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
    
    // Test the connection
    try {
      const connection = await pool.getConnection();
      console.log('✅ MySQL: Connection test successful');
      connection.release();
    } catch (error) {
      console.error('❌ MySQL: Connection test failed:', error);
      throw error;
    }
  }
  return pool
}

export async function initSchema() {
  console.log('🗄️ MySQL: Initializing database schema...');
  const pool = await getPool()
  
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      google_id VARCHAR(128) UNIQUE,
      email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`)
    console.log('✅ MySQL: Users table created');

    await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;`)
    console.log('✅ MySQL: Sessions table created');

    // Drop and recreate files table to ensure proper constraints
    try {
      await pool.query('DROP TABLE IF EXISTS files');
      console.log('🗑️ MySQL: Dropped existing files table');
    } catch (dropError) {
      console.log('ℹ️ MySQL: No existing files table to drop');
    }
    
    // Create files table with proper unique constraint
    await pool.query(`CREATE TABLE files (
      file_id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      filename VARCHAR(512) NOT NULL,
      content LONGBLOB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_files_session FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      UNIQUE KEY unique_session_filename (session_id, filename),
      INDEX idx_files_session (session_id),
      INDEX idx_files_name (filename)
    ) ENGINE=InnoDB;`)
    console.log('✅ MySQL: Files table recreated with proper constraints');
    
    // Clean up any duplicate files that might exist
    await cleanupDuplicateFiles(pool);
    
    console.log('✅ MySQL: Database schema initialized successfully');
  } catch (error) {
    console.error('❌ MySQL: Schema initialization failed:', error);
    throw error;
  }
}

export async function upsertUserAndCreateSession({ googleId, email }) {
  console.log('🗄️ MySQL: Starting upsertUserAndCreateSession for:', { googleId, email })
  const pool = await getPool()
  console.log('🗄️ MySQL: Got connection pool')
  const conn = await pool.getConnection()
  console.log('🗄️ MySQL: Got connection')
  try {
    await conn.beginTransaction()
    console.log('🗄️ MySQL: Transaction started')
    
    const [u] = await conn.execute(
      'SELECT id FROM users WHERE google_id = ? OR email = ? LIMIT 1',
      [googleId || null, email || null]
    )
    console.log('🗄️ MySQL: User query result:', u)
    
    let userId
    if (Array.isArray(u) && u.length > 0) {
      userId = u[0].id
      console.log('🗄️ MySQL: Found existing user:', userId)
    } else {
      const [r] = await conn.execute(
        'INSERT INTO users (google_id, email) VALUES (?, ?)',
        [googleId || null, email || null]
      )
      userId = r.insertId
      console.log('🗄️ MySQL: Created new user:', userId)
    }

    // Check if user already has a permanent session
    const [existingSessions] = await conn.execute(
      'SELECT session_id FROM sessions WHERE user_id = ? LIMIT 1',
      [userId]
    )
    
    let sessionId
    if (Array.isArray(existingSessions) && existingSessions.length > 0) {
      // Reuse existing permanent session
      sessionId = existingSessions[0].session_id
      console.log('🗄️ MySQL: Reusing existing permanent session:', sessionId)
    } else {
      // Create new permanent session for new user
      sessionId = `perm_${userId}_${Date.now()}`
      console.log('🗄️ MySQL: Creating new permanent session:', sessionId)
      await conn.execute(
        'INSERT INTO sessions (session_id, user_id) VALUES (?, ?)',
        [sessionId, userId]
      )
      console.log('🗄️ MySQL: Permanent session created successfully')
    }

    await conn.commit()
    console.log('🗄️ MySQL: Transaction committed')
    return { userId, sessionId }
  } catch (e) {
    console.error('🗄️ MySQL: Error in upsertUserAndCreateSession:', e)
    await conn.rollback()
    throw e
  } finally {
    conn.release()
    console.log('🗄️ MySQL: Connection released')
  }
}

export async function saveFile({ sessionId, filename, content }) {
  const pool = await getPool()
  try {
    // First try to update existing file
    const [updateResult] = await pool.execute(
      'UPDATE files SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND filename = ?',
      [Buffer.from(content), sessionId, filename]
    )
    
    // If no rows were updated, insert new file
    if (updateResult.affectedRows === 0) {
      await pool.execute(
        'INSERT INTO files (session_id, filename, content) VALUES (?, ?, ?)',
        [sessionId, filename, Buffer.from(content)]
      )
      console.log('✅ MySQL: File created:', { sessionId, filename, contentLength: content.length })
    } else {
      console.log('✅ MySQL: File updated:', { sessionId, filename, contentLength: content.length })
    }
  } catch (error) {
    console.error('❌ MySQL: Error saving file:', error)
    throw error
  }
}

export async function readFileByName({ sessionId, filename }) {
  const pool = await getPool()
  const [rows] = await pool.execute(
    'SELECT content FROM files WHERE session_id = ? AND filename = ? LIMIT 1',
    [sessionId, filename]
  )
  if (Array.isArray(rows) && rows.length > 0) {
    return Buffer.from(rows[0].content || '').toString()
  }
  return null
}

export async function listFilesBySession(sessionId) {
  const pool = await getPool()
  const [rows] = await pool.execute(
    'SELECT filename, created_at, updated_at FROM files WHERE session_id = ? ORDER BY filename',
    [sessionId]
  )
  return rows
}

export async function deleteFileByName({ sessionId, filename }) {
  const pool = await getPool()
  await pool.execute(
    'DELETE FROM files WHERE session_id = ? AND filename = ? LIMIT 1',
    [sessionId, filename]
  )
}

export async function deleteSession(sessionId) {
  const pool = await getPool()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    
    // Delete files first (cascade will handle this, but explicit for clarity)
    await conn.execute(
      'DELETE FROM files WHERE session_id = ?',
      [sessionId]
    )
    
    // Delete session
    await conn.execute(
      'DELETE FROM sessions WHERE session_id = ?',
      [sessionId]
    )
    
    await conn.commit()
    return true
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

export async function getSessionInfo(sessionId) {
  const pool = await getPool()
  const [rows] = await pool.execute(
    'SELECT s.session_id, s.user_id, u.email, s.created_at FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.session_id = ?',
    [sessionId]
  )
  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0]
  }
  return null
}

// Sessions are now permanent - no cleanup needed
export async function cleanupExpiredSessions(maxAgeHours = 24) {
  console.log('ℹ️ MySQL: Sessions are permanent - no cleanup needed');
  return 0;
}

export async function cleanupDuplicateFiles(pool) {
  try {
    console.log('🧹 MySQL: Cleaning up duplicate files...')
    
    // Find and remove duplicate files, keeping the most recent one
    const [duplicates] = await pool.execute(`
      DELETE f1 FROM files f1
      INNER JOIN files f2 
      WHERE f1.file_id < f2.file_id 
      AND f1.session_id = f2.session_id 
      AND f1.filename = f2.filename
    `)
    
    if (duplicates.affectedRows > 0) {
      console.log(`🧹 MySQL: Cleaned up ${duplicates.affectedRows} duplicate files`)
    } else {
      console.log('ℹ️ MySQL: No duplicate files found')
    }
  } catch (error) {
    console.error('⚠️ MySQL: Error cleaning up duplicates:', error.message)
    // Don't throw - this is cleanup, not critical
  }
}

export async function getUserSessionByGoogleAccount({ googleId, email }) {
  const pool = await getPool()
  try {
    const [users] = await pool.execute(
      'SELECT u.id, u.google_id, u.email, s.session_id FROM users u LEFT JOIN sessions s ON u.id = s.user_id WHERE u.google_id = ? OR u.email = ? LIMIT 1',
      [googleId || null, email || null]
    )
    
    if (Array.isArray(users) && users.length > 0) {
      const user = users[0]
      if (user.session_id) {
        console.log('✅ MySQL: Found existing session for user:', { userId: user.id, sessionId: user.session_id })
        return { userId: user.id, sessionId: user.session_id }
      } else {
        console.log('⚠️ MySQL: User exists but no session found:', { userId: user.id })
        return null
      }
    }
    
    console.log('ℹ️ MySQL: No user found for:', { googleId, email })
    return null
  } catch (error) {
    console.error('❌ MySQL: Error getting user session:', error)
    throw error
  }
}
