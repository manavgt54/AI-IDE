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
  // Add connection pool settings
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
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
      github_id VARCHAR(128) UNIQUE,
      email VARCHAR(255),
      name VARCHAR(255),
      github_token TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`)
    console.log('✅ MySQL: Users table created');

    // Add GitHub fields to existing users table (migration) - MySQL doesn't support IF NOT EXISTS for ADD COLUMN
    try {
      const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'github_id'")
      if (Array.isArray(columns) && columns.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN github_id VARCHAR(128) UNIQUE')
      }
      const [nameCol] = await pool.query("SHOW COLUMNS FROM users LIKE 'name'")
      if (Array.isArray(nameCol) && nameCol.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN name VARCHAR(255)')
      }
      const [tokenCol] = await pool.query("SHOW COLUMNS FROM users LIKE 'github_token'")
      if (Array.isArray(tokenCol) && tokenCol.length === 0) {
        await pool.query('ALTER TABLE users ADD COLUMN github_token TEXT')
      }
      console.log('✅ MySQL: GitHub fields ensured on users table')
    } catch (migrationError) {
      console.log('ℹ️ MySQL: GitHub fields ensure step skipped:', migrationError.message)
    }

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

export async function upsertUserAndCreateSession({ googleId, email, provider, githubId, githubToken, name }) {
  console.log('🗄️ MySQL: Starting upsertUserAndCreateSession for:', { googleId, email, provider, githubId })
  const pool = await getPool()
  console.log('🗄️ MySQL: Got connection pool')
  const conn = await pool.getConnection()
  console.log('🗄️ MySQL: Got connection')
  try {
    await conn.beginTransaction()
    console.log('🗄️ MySQL: Transaction started')
    
    // Build query based on provider
    let query, params
    if (provider === 'github') {
      query = 'SELECT id FROM users WHERE github_id = ? OR email = ? LIMIT 1'
      params = [githubId || null, email || null]
    } else {
      query = 'SELECT id FROM users WHERE google_id = ? OR email = ? LIMIT 1'
      params = [googleId || null, email || null]
    }
    
    const [u] = await conn.execute(query, params)
    console.log('🗄️ MySQL: User query result:', u)
    
    let userId
    if (Array.isArray(u) && u.length > 0) {
      userId = u[0].id
      console.log('🗄️ MySQL: Found existing user:', userId)
      
      // Update user info if needed (for GitHub users)
      if (provider === 'github' && (githubId || name)) {
        await conn.execute(
          'UPDATE users SET github_id = ?, name = ?, github_token = ? WHERE id = ?',
          [githubId || null, name || null, githubToken || null, userId]
        )
        console.log('🗄️ MySQL: Updated user GitHub info')
      }
    } else {
      // Create new user based on provider
      if (provider === 'github') {
        const [r] = await conn.execute(
          'INSERT INTO users (github_id, email, name, github_token) VALUES (?, ?, ?, ?)',
          [githubId || null, email || null, name || null, githubToken || null]
        )
        userId = r.insertId
        console.log('🗄️ MySQL: Created new GitHub user:', userId)
    } else {
      const [r] = await conn.execute(
          'INSERT INTO users (google_id, email, name) VALUES (?, ?, ?)',
          [googleId || null, email || null, name || null]
      )
      userId = r.insertId
        console.log('🗄️ MySQL: Created new Google user:', userId)
      }
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

// ✅ ADDED: Batch save files to MySQL for better performance
export async function batchSaveFiles({ sessionId, files }) {
  const pool = await getPool()
  const conn = await pool.getConnection()
  
  try {
    await conn.beginTransaction()
    console.log(`📦 MySQL: Starting batch save of ${files.length} files for session: ${sessionId}`)
    console.log(`🔍 MySQL: Database config - Host: ${DB_CONFIG.host}, Port: ${DB_CONFIG.port}, DB: ${DB_CONFIG.database}, User: ${DB_CONFIG.user}`)
    
    let savedCount = 0
    let updatedCount = 0
    let errorCount = 0
    
    for (const { filename, content } of files) {
      try {
        // First try to update existing file
        const [updateResult] = await conn.execute(
          'UPDATE files SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND filename = ?',
          [Buffer.from(content), sessionId, filename]
        )
        
        // If no rows were updated, insert new file
        if (updateResult.affectedRows === 0) {
          await conn.execute(
            'INSERT INTO files (session_id, filename, content) VALUES (?, ?, ?)',
            [sessionId, filename, Buffer.from(content)]
          )
          savedCount++
          console.log(`✅ MySQL: INSERTED file: ${filename} (${content.length} bytes)`)
        } else {
          updatedCount++
          console.log(`✅ MySQL: UPDATED file: ${filename} (${content.length} bytes)`)
        }
      } catch (fileError) {
        console.error(`❌ MySQL: Error saving file ${filename}:`, fileError)
        errorCount++
      }
    }
    
    await conn.commit()
    console.log(`✅ MySQL: Batch save completed - Saved: ${savedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`)
    
    // ✅ ADDED: Verify data was actually saved by querying the database
    try {
      const [verifyRows] = await conn.execute(
        'SELECT COUNT(*) as count FROM files WHERE session_id = ?',
        [sessionId]
      )
      console.log(`🔍 MySQL: Verification - Total files in DB for session: ${verifyRows[0].count}`)
    } catch (verifyError) {
      console.error('⚠️ MySQL: Verification query failed:', verifyError)
    }
    
    return {
      success: true,
      saved: savedCount,
      updated: updatedCount,
      errors: errorCount,
      total: files.length
    }
  } catch (error) {
    await conn.rollback()
    console.error('❌ MySQL: Batch save transaction failed:', error)
    throw error
  } finally {
    conn.release()
  }
}

export async function readFileByName({ sessionId, filename }) {
  const pool = await getPool()
  const [rows] = await pool.execute(
    'SELECT content FROM files WHERE session_id = ? AND filename = ? LIMIT 1',
    [sessionId, filename]
  )
  if (Array.isArray(rows) && rows.length > 0) {
    const content = rows[0].content
    if (content === null || content === undefined) {
      console.log('⚠️ MySQL: File content is null/undefined for:', filename)
      return ''
    }
    // Handle both Buffer and string content
    if (Buffer.isBuffer(content)) {
      return content.toString('utf8')
    } else if (typeof content === 'string') {
      return content
    } else {
      console.log('⚠️ MySQL: Unexpected content type for:', filename, typeof content)
      return String(content)
    }
  }
  console.log('⚠️ MySQL: File not found:', filename)
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

// ✅ ADDED: Function to verify database data and connection
export async function verifyDatabaseData(sessionId) {
  const pool = await getPool()
  try {
    console.log('🔍 MySQL: Verifying database data...')
    console.log(`🔍 MySQL: Database config - Host: ${DB_CONFIG.host}, Port: ${DB_CONFIG.port}, DB: ${DB_CONFIG.database}, User: ${DB_CONFIG.user}`)
    
    // Test connection
    const [connectionTest] = await pool.execute('SELECT 1 as test')
    console.log('✅ MySQL: Connection test successful:', connectionTest[0])
    
    // Check users table
    const [users] = await pool.execute('SELECT COUNT(*) as count FROM users')
    console.log(`📊 MySQL: Users in database: ${users[0].count}`)
    
    // Check sessions table
    const [sessions] = await pool.execute('SELECT COUNT(*) as count FROM sessions')
    console.log(`📊 MySQL: Sessions in database: ${sessions[0].count}`)
    
    // Check files table
    const [files] = await pool.execute('SELECT COUNT(*) as count FROM files')
    console.log(`📊 MySQL: Total files in database: ${files[0].count}`)
    
    // Check files for specific session
    if (sessionId) {
      const [sessionFiles] = await pool.execute('SELECT COUNT(*) as count FROM files WHERE session_id = ?', [sessionId])
      console.log(`📊 MySQL: Files for session ${sessionId}: ${sessionFiles[0].count}`)
      
      // Get sample files for this session
      const [sampleFiles] = await pool.execute('SELECT filename, LENGTH(content) as size FROM files WHERE session_id = ? LIMIT 5', [sessionId])
      console.log('📄 MySQL: Sample files for session:')
      sampleFiles.forEach(file => {
        console.log(`  - ${file.filename} (${file.size} bytes)`)
      })
    }
    
    return {
      connection: true,
      users: users[0].count,
      sessions: sessions[0].count,
      totalFiles: files[0].count,
      sessionFiles: sessionId ? (await pool.execute('SELECT COUNT(*) as count FROM files WHERE session_id = ?', [sessionId]))[0][0].count : 0
    }
  } catch (error) {
    console.error('❌ MySQL: Database verification failed:', error)
    throw error
  }
}

// ✅ ADDED: Batch save files function
export async function batchSaveFiles({ sessionId, files }) {
  const pool = await getPool()
  const conn = await pool.getConnection()
  
  try {
    console.log(`📦 MySQL: Starting batch save of ${files.length} files for session: ${sessionId}`)
    
    await conn.beginTransaction()
    
    let savedCount = 0
    let updatedCount = 0
    let errorCount = 0
    
    for (const file of files) {
      try {
        // Try to update existing file first
        const [updateResult] = await conn.execute(
          'UPDATE files SET content = ?, updated_at = NOW() WHERE session_id = ? AND filename = ?',
          [file.content, sessionId, file.filename]
        )
        
        if (updateResult.affectedRows > 0) {
          updatedCount++
          console.log(`✅ MySQL: UPDATED file: ${file.filename} (${file.content.length} bytes)`)
        } else {
          // Insert new file
          await conn.execute(
            'INSERT INTO files (session_id, filename, content, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
            [sessionId, file.filename, file.content]
          )
          savedCount++
          console.log(`✅ MySQL: INSERTED file: ${file.filename} (${file.content.length} bytes)`)
        }
      } catch (fileError) {
        console.error(`❌ MySQL: Error saving file ${file.filename}:`, fileError.message)
        errorCount++
      }
    }
    
    await conn.commit()
    
    // Verify the save
    const [verification] = await conn.execute(
      'SELECT COUNT(*) as count FROM files WHERE session_id = ?',
      [sessionId]
    )
    
    console.log(`🔍 MySQL: Verification - Total files in DB for session: ${verification[0].count}`)
    console.log(`📦 MySQL: Batch save completed - Saved: ${savedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`)
    
    return {
      success: true,
      saved: savedCount,
      updated: updatedCount,
      errors: errorCount,
      total: files.length
    }
    
  } catch (error) {
    await conn.rollback()
    console.error('❌ MySQL: Batch save failed:', error)
    throw error
  } finally {
    conn.release()
  }
}
