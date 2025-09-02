import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use local SQLite database instead of remote MySQL
const DB_PATH = path.join(__dirname, '../../data/terminal.db');

let db = null;

export async function getDb() {
    if (!db) {
        console.log('🗄️ SQLite: Initializing database at:', DB_PATH);
        db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });
        console.log('🗄️ SQLite: Database connection established');
    }
    return db;
}

export async function initSchema() {
    console.log('🗄️ SQLite: Initializing database schema...');
    const database = await getDb();
    
    // Create users table
    await database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id TEXT UNIQUE,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('🗄️ SQLite: Users table created');

    // Create sessions table
    await database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    console.log('🗄️ SQLite: Sessions table created');

    // Create files table
    await database.exec(`
        CREATE TABLE IF NOT EXISTS files (
            file_id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            content BLOB,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
    `);
    console.log('🗄️ SQLite: Files table created');

    // Create indexes for better performance
    await database.exec('CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id)');
    await database.exec('CREATE INDEX IF NOT EXISTS idx_files_name ON files(filename)');
    console.log('🗄️ SQLite: Indexes created');

    console.log('✅ SQLite: Database schema initialized successfully');
}

export async function upsertUserAndCreateSession({ googleId, email }) {
    console.log('🗄️ SQLite: Starting upsertUserAndCreateSession for:', { googleId, email });
    const database = await getDb();
    
    try {
        await database.run('BEGIN TRANSACTION');
        console.log('🗄️ SQLite: Transaction started');
        
        // Check if user exists
        const existingUser = await database.get(
            'SELECT id FROM users WHERE google_id = ? OR email = ? LIMIT 1',
            [googleId || null, email || null]
        );
        console.log('🗄️ SQLite: User query result:', existingUser);
        
        let userId;
        if (existingUser) {
            userId = existingUser.id;
            console.log('🗄️ SQLite: Found existing user:', userId);
        } else {
            const result = await database.run(
                'INSERT INTO users (google_id, email) VALUES (?, ?)',
                [googleId || null, email || null]
            );
            userId = result.lastID;
            console.log('🗄️ SQLite: Created new user:', userId);
        }

        const sessionId = `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`;
        console.log('🗄️ SQLite: Creating session:', sessionId);
        
        await database.run(
            'INSERT INTO sessions (session_id, user_id) VALUES (?, ?)',
            [sessionId, userId]
        );
        console.log('🗄️ SQLite: Session created successfully');

        await database.run('COMMIT');
        console.log('🗄️ SQLite: Transaction committed');
        return { userId, sessionId };
    } catch (e) {
        console.error('🗄️ SQLite: Error in upsertUserAndCreateSession:', e);
        await database.run('ROLLBACK');
        throw e;
    }
}

export async function saveFile({ sessionId, filename, content }) {
    const database = await getDb();
    await database.run(
        `INSERT INTO files (session_id, filename, content) VALUES (?, ?, ?) 
         ON CONFLICT(session_id, filename) DO UPDATE SET content=excluded.content, updated_at=CURRENT_TIMESTAMP`,
        [sessionId, filename, Buffer.from(content)]
    );
}

export async function readFileByName({ sessionId, filename }) {
    const database = await getDb();
    const row = await database.get(
        'SELECT content FROM files WHERE session_id = ? AND filename = ? LIMIT 1',
        [sessionId, filename]
    );
    if (row && row.content) {
        return Buffer.from(row.content).toString();
    }
    return null;
}

export async function listFilesBySession(sessionId) {
    const database = await getDb();
    const rows = await database.all(
        'SELECT filename, created_at, updated_at FROM files WHERE session_id = ? ORDER BY filename',
        [sessionId]
    );
    return rows;
}

export async function deleteSession(sessionId) {
    const database = await getDb();
    try {
        await database.run('BEGIN TRANSACTION');
        
        // Delete files first
        await database.run(
            'DELETE FROM files WHERE session_id = ?',
            [sessionId]
        );
        
        // Delete session
        await database.run(
            'DELETE FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        
        await database.run('COMMIT');
        return true;
    } catch (e) {
        await database.run('ROLLBACK');
        throw e;
    }
}

export async function getSessionInfo(sessionId) {
    const database = await getDb();
    const row = await database.get(
        `SELECT s.session_id, s.user_id, u.email, s.created_at 
         FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.session_id = ?`,
        [sessionId]
    );
    return row || null;
}

export async function cleanupExpiredSessions(maxAgeHours = 24) {
    const database = await getDb();
    try {
        await database.run('BEGIN TRANSACTION');
        
        // Find expired sessions
        const expiredSessions = await database.all(
            'SELECT session_id FROM sessions WHERE created_at < datetime("now", "-" || ? || " hours")',
            [maxAgeHours]
        );
        
        if (expiredSessions.length > 0) {
            const sessionIds = expiredSessions.map(row => row.session_id);
            
            // Delete files for expired sessions
            await database.run(
                'DELETE FROM files WHERE session_id IN (' + sessionIds.map(() => '?').join(',') + ')',
                sessionIds
            );
            
            // Delete expired sessions
            await database.run(
                'DELETE FROM sessions WHERE session_id IN (' + sessionIds.map(() => '?').join(',') + ')',
                sessionIds
            );
            
            console.log(`🧹 Cleaned up ${expiredSessions.length} expired sessions`);
        }
        
        await database.run('COMMIT');
        return expiredSessions.length;
    } catch (e) {
        await database.run('ROLLBACK');
        throw e;
    }
}
