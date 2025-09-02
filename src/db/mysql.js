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

    await pool.query(`CREATE TABLE IF NOT EXISTS files (
      file_id INT AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      filename VARCHAR(512) NOT NULL,
      content LONGBLOB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_files_session FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      INDEX idx_files_session (session_id),
      INDEX idx_files_name (filename)
    ) ENGINE=InnoDB;`)
    console.log('✅ MySQL: Files table created');
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

    const sessionId = `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`
    console.log('🗄️ MySQL: Creating session:', sessionId)
    await conn.execute(
      'INSERT INTO sessions (session_id, user_id) VALUES (?, ?)',
      [sessionId, userId]
    )
    console.log('🗄️ MySQL: Session created successfully')

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
  await pool.execute(
    'INSERT INTO files (session_id, filename, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content=VALUES(content)',
    [sessionId, filename, Buffer.from(content)]
  )
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

export async function cleanupExpiredSessions(maxAgeHours = 24) {
  const pool = await getPool()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    
    // Find expired sessions
    const [expiredSessions] = await conn.execute(
      'SELECT session_id FROM sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)',
      [maxAgeHours]
    )
    
    if (expiredSessions.length > 0) {
      const sessionIds = expiredSessions.map(row => row.session_id)
      
      // Delete files for expired sessions
      await conn.execute(
        'DELETE FROM files WHERE session_id IN (?)',
        [sessionIds]
      )
      
      // Delete expired sessions
      await conn.execute(
        'DELETE FROM sessions WHERE session_id IN (?)',
        [sessionIds]
      )
      
      console.log(`🧹 Cleaned up ${expiredSessions.length} expired sessions`)
    }
    
    await conn.commit()
    return expiredSessions.length
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
