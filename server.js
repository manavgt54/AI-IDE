import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import unzipper from 'unzipper';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { ENV_CONFIG, getPort, getWorkspaceDir, isDevelopment, isProduction, getGitHubClientId, getGitHubClientSecret, getFrontendUrl } from './src/config/env.js';
import { shouldPersistInDb, normalizeWorkspacePath, isExcludedPath } from './src/utils/persistence.js';
import { initSchema, upsertUserAndCreateSession, getUserSessionByGoogleAccount, readFileByName, saveFile, listFilesBySession, deleteSession, deleteFileByName, getSessionInfo, batchSaveFiles, verifyDatabaseData, verifyTerminalSession } from './src/db/sqlite.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global variables for multiple user sessions - each session is a container
let sessions = new Map(); // sessionId -> { ws, ptyProcess, userId, currentCwd, ptyReady, containerId }
let pty = null;
let mockPty = null;

// Environment variables from config
const PORT = getPort();
// Ensure absolute workspace path for both FS and PTY shell usage
const WORKSPACE_DIR = path.resolve(getWorkspaceDir());

console.log('🚀 Starting simplified terminal server...');
console.log(`📁 Workspace directory: ${WORKSPACE_DIR}`);
console.log(`🌐 Server port: ${PORT}`);
console.log('🔧 WebSocket fix applied - WebSocket constant properly imported');

// Check Python availability
try {
    const { execSync } = await import('child_process');
    const pythonVersion = execSync('python3 --version', { encoding: 'utf8' });
    console.log(`🐍 Python available: ${pythonVersion.trim()}`);
} catch (error) {
    console.log('⚠️ Python3 not available, trying python...');
    try {
        const { execSync } = await import('child_process');
        const pythonVersion = execSync('python --version', { encoding: 'utf8' });
        console.log(`🐍 Python available: ${pythonVersion.trim()}`);
    } catch (error2) {
        console.log('❌ Python not available on this system');
    }
}

// Ensure workspace directory exists and clean it
if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    console.log(`✅ Created workspace directory: ${WORKSPACE_DIR}`);
} else {
    // Clean existing workspace files (remove backend files)
    try {
        const files = fs.readdirSync(WORKSPACE_DIR);
        for (const file of files) {
            if (file !== 'sessions') { // Keep sessions directory
                const filePath = path.join(WORKSPACE_DIR, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Removed backend file: ${file}`);
                }
            }
        }
        console.log('🧹 Cleaned backend workspace files');
    } catch (cleanError) {
        console.error('⚠️ Error cleaning workspace:', cleanError);
    }
}

const app = express();
app.set('etag', false); // disable ETag to avoid 304 on API responses
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = ENV_CONFIG.ALLOWED_ORIGINS === '*'
      ? ['*'] // Allow all origins if configured as such
      : ENV_CONFIG.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS blocked request from origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow cookies to be sent
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'workspace')));
// Multer in-memory storage for binary-safe uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        timestamp: new Date().toISOString(),
        sessions: sessions.size,
        pty: sessions.size > 0 ? 'running' : 'none'
    });
});

// Debug endpoint to check session files
app.get('/debug/files/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const files = await listFilesBySession(sessionId);
        res.json({ 
            sessionId,
            totalFiles: files.length,
            files: files.map(f => ({
                filename: f.filename,
                created: f.created_at,
                modified: f.updated_at
            }))
        });
    } catch (error) {
        console.error('❌ Debug files error:', error);
        res.status(500).json({ error: 'debug_failed', details: error.message });
    }
});

// Debug endpoint to read a specific file
app.get('/debug/read/:sessionId/*', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const filename = req.params[0]; // Everything after sessionId/
        const content = await readFileByName({ sessionId, filename });
        res.json({ 
            sessionId,
            filename,
            contentLength: content ? content.length : 0,
            content: content ? content.substring(0, 500) + (content.length > 500 ? '...' : '') : null,
            isNull: content === null,
            isEmpty: content === ''
        });
    } catch (error) {
        console.error('❌ Debug read error:', error);
        res.status(500).json({ error: 'debug_read_failed', details: error.message });
    }
});

// Database test endpoint
app.get('/test-db', async (req, res) => {
    try {
        const pool = await getPool();
        const [rows] = await pool.query('SELECT 1 as test');
        res.json({ 
            status: 'database_connected', 
            test: rows[0].test,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Database test failed:', error);
        res.status(500).json({ 
            status: 'database_error', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        sessions: sessions.size,
        pty: sessions.size > 0 ? 'running' : 'none'
    });
});

// ✅ ADDED: Database verification endpoint
app.get('/verify-db', async (req, res) => {
    try {
        const sessionId = req.query.sessionId;
        const verification = await verifyDatabaseData(sessionId);
        res.json({
            success: true,
            verification,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Database verification failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ✅ ADDED: Manual terminal sync endpoint
app.post('/terminal/sync', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        
        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'session not found' });
        }
        
        if (!session.ptyProcess || !session.ptyReady) {
            return res.status(400).json({ error: 'terminal not ready' });
        }
        
        console.log(`🔄 Manual terminal sync requested for session: ${sessionId}`);
        
        // Trigger terminal refresh
        session.ptyProcess.write('echo "🔄 Manual sync triggered..."\n');
        session.ptyProcess.write('pwd\n');
        session.ptyProcess.write('ls -la\n');
        
        res.json({ 
            ok: true, 
            message: 'Terminal sync triggered',
            sessionId: sessionId
        });
        
    } catch (error) {
        console.error('❌ Error in terminal sync:', error);
        res.status(500).json({ error: 'sync_failed', details: error.message });
    }
});

// Initialize DB schema
initSchema().then(() => console.log('🗄️ SQLite schema ready')).catch(e => console.error('SQLite init failed', e));

// Minimal Google auth endpoint: expects { googleId, email }
app.post('/auth/google', async (req, res) => {
    try {
        console.log('🔐 Google auth request received');
        console.log('   ↳ origin:', req.headers.origin, 'referer:', req.headers.referer);
        console.log('   ↳ body:', req.body);
        const { googleId, email } = req.body || {};
        if (!googleId && !email) {
            console.log('❌ Missing googleId or email');
            return res.status(400).json({ error: 'googleId or email required' });
        }
        console.log('📝 Creating user and session for:', { googleId, email });
        
        const { userId, sessionId, terminalToken, workspacePath } = await upsertUserAndCreateSession({ googleId, email, provider: 'google' });
        console.log('✅ User and session created:', { userId, sessionId, workspacePath });
        return res.json({ ok: true, userId, sessionId, terminalToken, workspacePath });
    } catch (e) {
        console.error('❌ Auth error:', e);
        return res.status(500).json({ error: 'auth_failed', details: e.message });
    }
});

// Return a stable session for a given Google account (create if missing)
app.post('/auth/session', async (req, res) => {
    try {
        const { googleId, email } = req.body || {};
        if (!googleId && !email) {
            return res.status(400).json({ error: 'googleId or email required' });
        }
        // First try to get existing permanent session
        const existingSession = await getUserSessionByGoogleAccount({ googleId, email });
        
        if (existingSession) {
            console.log('✅ Reusing existing permanent session for user:', existingSession.sessionId);
            return res.json({ 
                ok: true, 
                userId: existingSession.userId, 
                sessionId: existingSession.sessionId,
                terminalToken: existingSession.terminalToken,
                workspacePath: existingSession.workspacePath
            });
        } else {
            // Create new permanent session if none exists
            console.log('🆕 Creating new permanent session for user');
            const result = await upsertUserAndCreateSession({ googleId, email, provider: 'google' });
            return res.json({ 
                ok: true, 
                userId: result.userId, 
                sessionId: result.sessionId,
                terminalToken: result.terminalToken,
                workspacePath: result.workspacePath
            });
        }
    } catch (e) {
        console.error('❌ /auth/session error:', e);
        return res.status(500).json({ error: 'auth_session_failed', details: e.message });
    }
});

// GitHub OAuth callback
app.get('/auth/github/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        
        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' });
        }

        // Exchange code for access token
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: getGitHubClientId(),
                client_secret: getGitHubClientSecret(),
                code: code,
                state: state,
                redirect_uri: `${getFrontendUrl()}/auth/github/callback` // Add this line
            })
        });

        const tokenData = await tokenResponse.json();
        
        if (tokenData.error) {
            throw new Error(`GitHub OAuth error: ${tokenData.error_description}`);
        }

        // Get user info from GitHub
        const userResponse = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${tokenData.access_token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        const userData = await userResponse.json();
        
        if (!userData.email) {
            // Get user email from GitHub API
            const emailResponse = await fetch('https://api.github.com/user/emails', {
                headers: {
                    'Authorization': `token ${tokenData.access_token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            const emails = await emailResponse.json();
            const primaryEmail = emails.find(email => email.primary);
            userData.email = primaryEmail ? primaryEmail.email : userData.login + '@users.noreply.github.com';
        }

        // Create or get user session
        const sessionData = await upsertUserAndCreateSession({
            googleId: null,
            email: userData.email,
            name: userData.name || userData.login,
            provider: 'github',
            githubId: userData.id.toString(),
            githubToken: tokenData.access_token
        });

        // Redirect to frontend with session data
        const redirectUrl = `${getFrontendUrl()}/auth/github/success?sessionId=${sessionData.sessionId}&terminalToken=${sessionData.terminalToken}&token=${tokenData.access_token}`;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('❌ GitHub OAuth error:', error);
        const errorUrl = `${getFrontendUrl()}/auth/github/error?error=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});

// Validate an existing sessionId, and if it's missing in memory allow backend to recreate in-memory state
app.post('/auth/session/validate', async (req, res) => {
    try {
        const { sessionId, terminalToken, googleId, email } = req.body || {};
        if (!sessionId && !googleId && !email) {
            return res.status(400).json({ error: 'sessionId or google identity required' });
        }

        // 1) If sessionId + terminalToken provided, validate strictly
        if (sessionId && terminalToken) {
            const session = await verifyTerminalSession(sessionId, terminalToken);
            if (session) {
                return res.json({ ok: true, sessionId: session.session_id, userId: session.user_id, terminalToken, workspacePath: session.workspace_path });
            }
            return res.status(401).json({ ok: false, error: 'invalid_token' });
        }

        // 2) Fallback by Google identity to recover the user's permanent session
        if (googleId || email) {
            const existing = await getUserSessionByGoogleAccount({ googleId, email });
            if (existing) {
                return res.json({ ok: true, sessionId: existing.sessionId, userId: existing.userId, terminalToken: existing.terminalToken, workspacePath: existing.workspacePath });
            }
        }

        // 3) Nothing found
        return res.status(404).json({ ok: false, error: 'session_not_found' });
    } catch (e) {
        console.error('❌ /auth/session/validate error:', e);
        return res.status(500).json({ error: 'validate_failed', details: e.message });
    }
});

// File operations - now fully MySQL-based
app.get('/files', async (req, res) => {
    try {
        // prevent caches / proxies from serving stale content
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.type('application/json');
        const sessionId = req.query.sessionId || req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        // Get files from database for this session
        try {
            const files = await listFilesBySession(sessionId);
            // Return a flat list of filenames; frontend will build the tree
            const fileList = files.map(row => ({
                filename: row.filename,
                created: row.created_at,
                modified: row.updated_at
            }));
            res.json({ files: fileList });
        } catch (dbError) {
            console.error('❌ Database error in /files:', dbError);
            res.status(500).json({ error: 'database_error', details: dbError.message });
        }
    } catch (error) {
        console.error('❌ Error in /files:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Open file endpoint
app.post('/files/open', async (req, res) => {
    try {
        const { filename } = req.body;
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        const content = await readFileByName({ sessionId, filename });
        
        if (content === null) {
            return res.status(404).json({ error: 'file_not_found' });
        }
        
        res.json({ path: filename, content });
    } catch (error) {
        console.error('❌ Error in /files/open:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Save file endpoint (DB-only; no local FS writes)
app.post('/files/save', async (req, res) => {
    try {
        const { filename, content } = req.body;
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        // Persist in DB only if allowed by policy
        if (shouldPersistInDb(filename, content)) {
            await saveFile({ sessionId, filename, content });
        }
        
        // Immediately sync to session workspace for terminal access
        try {
            const sessionWorkspaceDir = path.resolve(verified.workspace_path).replace(/\\/g, '/');
            const filePath = path.join(sessionWorkspaceDir, filename);
            const dirPath = path.dirname(filePath);
            
            // Ensure directory exists
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            
            // Write file to session workspace
            fs.writeFileSync(filePath, content);
            console.log(`📄 Synced saved file to session workspace: ${filename}`);
            
            // Trigger terminal refresh to show updated files
            const session = sessions.get(sessionId);
            if (session && session.ptyProcess && session.ptyReady) {
                session.ptyProcess.write('echo "📁 File updated: ' + filename + '"\n');
                session.ptyProcess.write('ls -la\n');
            }
        } catch (syncError) {
            console.error(`⚠️ Error syncing saved file ${filename}:`, syncError);
        }
        
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /files/save:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Create folder endpoint - DB-only placeholder, no local FS writes
app.post('/folders/create', async (req, res) => {
    try {
        const { folderPath } = req.body;
        const sessionId = req.headers['x-session-id'];
        if (!folderPath || !sessionId) {
            return res.status(400).json({ error: 'folderPath and sessionId required' });
        }

        // Save a placeholder to represent the folder in DB
        const placeholder = path.join(folderPath, '.folder');
        await saveFile({ sessionId, filename: placeholder, content: '' });
        return res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /folders/create:', error);
        return res.status(500).json({ error: 'server_error' });
    }
});

// Save entire workspace in single API call (prevents server overload)
app.post('/files/workspace', async (req, res) => {
    try {
        const { workspace, timestamp } = req.body;
        const sessionId = req.headers['x-session-id'];
        
        if (!workspace || !sessionId) {
            return res.status(400).json({ error: 'workspace data and sessionId required' });
        }
        
        console.log(`💾 Saving entire workspace (${Object.keys(workspace).length} files) for session: ${sessionId}`);
        
        // 🔍 DEBUG: Check what's actually in the workspace data
        console.log('🔍 DEBUG: Workspace data sample:');
        const sampleFiles = Object.entries(workspace).slice(0, 3);
        sampleFiles.forEach(([path, content]) => {
            console.log(`  📄 ${path}: ${typeof content} (${content ? content.length : 0} chars)`);
            if (content && content.length > 0) {
                console.log(`    Preview: ${content.substring(0, 100)}...`);
            } else {
                console.log(`    ⚠️ EMPTY CONTENT!`);
            }
        });
        
        // Get session info to use correct workspace path
        const terminalToken = req.headers['x-terminal-token'];
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        // Create session workspace directory using correct path
        const sessionWorkspaceDir = path.resolve(verified.workspace_path).replace(/\\/g, '/');
        if (!fs.existsSync(sessionWorkspaceDir)) {
            fs.mkdirSync(sessionWorkspaceDir, { recursive: true });
        }
        
        // ✅ STEP 1: Save all files locally instantly for immediate access
        const localSavePromises = Object.entries(workspace).map(async ([filePath, content]) => {
            try {
                // Save to session workspace for terminal access
                const fullPath = path.join(sessionWorkspaceDir, filePath);
                const dirPath = path.dirname(fullPath);
                
                // Ensure directory exists
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }
                
                // Write file to session workspace
                fs.writeFileSync(fullPath, content);
                
                // 🔍 DEBUG: Log what's being saved
                console.log(`📄 Saved file: ${filePath} -> ${fullPath} (${content.length} bytes)`);
                
                return { path: filePath, success: true };
            } catch (error) {
                console.error(`❌ Error saving file locally ${filePath}:`, error);
                return { path: filePath, success: false, error: error.message };
            }
        });
        
        // Wait for all files to be saved locally
        const localResults = await Promise.all(localSavePromises);
        
        // ✅ STEP 2: Batch save all files to MySQL database
        const filesToSave = Object.entries(workspace)
            .filter(([filePath, content]) => shouldPersistInDb(filePath, content))
            .map(([filePath, content]) => ({ filename: filePath, content }));
        
        let batchResult = { success: true, saved: 0, updated: 0, errors: 0, total: filesToSave.length };
        try {
            batchResult = await batchSaveFiles({ sessionId, files: filesToSave });
            console.log(`📦 Batch save completed: ${batchResult.saved} saved, ${batchResult.updated} updated, ${batchResult.errors} errors`);
        } catch (batchError) {
            console.error('❌ Batch save failed:', batchError);
            batchResult = { success: false, error: batchError.message };
        }
        
        const results = localResults;
        
        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;
        
        console.log(`✅ Workspace saved: ${successCount} files successful, ${errorCount} errors`);
        
        // ✅ ADDED: Immediate terminal sync after MySQL save
        try {
            const session = sessions.get(sessionId);
            if (session && session.ptyProcess && session.ptyReady) {
                console.log(`🔄 Triggering immediate terminal refresh for session: ${sessionId}`);
                // Send a refresh command to terminal to show updated files
                session.ptyProcess.write('echo "📁 Files updated - refreshing..."\n');
                session.ptyProcess.write('pwd\n');
                session.ptyProcess.write('ls -la\n');
                console.log(`✅ Terminal refresh triggered for session: ${sessionId}`);
            } else {
                console.log(`⚠️ Terminal not ready for session: ${sessionId}`);
            }
        } catch (syncError) {
            console.error('⚠️ Error triggering terminal refresh:', syncError);
        }
        
        res.json({ 
            ok: true, 
            saved: successCount, 
            errors: errorCount,
            timestamp: timestamp || Date.now(),
            batchSave: batchResult,
            terminalRefreshed: true
        });
        
    } catch (error) {
        console.error('❌ Error in /files/workspace:', error);
        res.status(500).json({ error: 'server_error', details: error.message });
    }
});

// Fast bulk-save: save large workspaces primarily to disk with ignore rules (faster UX)
app.post('/files/workspace-fast', async (req, res) => {
    try {
        const { workspace, timestamp } = req.body;
        const sessionId = req.headers['x-session-id'];

        if (!workspace || !sessionId) {
            return res.status(400).json({ error: 'workspace data and sessionId required' });
        }

        // Get session info to use correct workspace path
        const terminalToken = req.headers['x-terminal-token'];
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }

        const sessionWorkspaceDir = path.resolve(verified.workspace_path).replace(/\\/g, '/');
        if (!fs.existsSync(sessionWorkspaceDir)) {
            fs.mkdirSync(sessionWorkspaceDir, { recursive: true });
        }

        // Ignore patterns to avoid ghost/system files
        const shouldIgnore = (filePath) => {
            const p = filePath.replace(/\\/g, '/');
            return (
                p.includes('/.git/') || p.startsWith('.git/') ||
                p.includes('/.idea/') || p.includes('/.vscode/') ||
                p.includes('/__MACOSX/') || p.endsWith('/.DS_Store') ||
                /(^|\/)Thumbs\.db$/i.test(p) || /(^|\/)desktop\.ini$/i.test(p) ||
                /\.(png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|mp4|mp3|zip|tar|gz)$/i.test(p)
            );
        };

        // Thresholds
        // Use configured threshold
        const LARGE_FILE_BYTES = Math.max(0, ENV_CONFIG.PERSIST_MAX_FILE_MB) * 1024 * 1024;

        let savedToDisk = 0;
        let queuedForDb = 0;
        let skipped = 0;
        const errors = [];

        // Save to disk immediately for speed; queue DB writes asynchronously for smaller files
        const entries = Object.entries(workspace);
        for (const [filePathRaw, content] of entries) {
            const filePath = filePathRaw.replace(/^\/+/, '').replace(/\\/g, '/');
            if (!filePath) { skipped++; continue; }
            if (shouldIgnore(filePath)) { skipped++; continue; }
            if (isExcludedPath(filePath)) { skipped++; continue; }

            try {
                const fullPath = path.join(sessionWorkspaceDir, filePath);
                const dirPath = path.dirname(fullPath);
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }

                // Write to disk (content could be string or Buffer-like)
                const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
                fs.writeFileSync(fullPath, data);
                savedToDisk++;

                // Only queue DB save for smaller files to avoid DB bloat and slowness
                if (data.length <= LARGE_FILE_BYTES && shouldPersistInDb(filePath, data)) {
                    queuedForDb++;
                    // Schedule without blocking response
                    setImmediate(async () => {
                        try {
                            await saveFile({ sessionId, filename: filePath, content: data });
                        } catch (e) {
                            console.error(`⚠️ Async DB save failed for ${filePath}:`, e);
                        }
                    });
                }
            } catch (e) {
                console.error('❌ Error saving to disk:', filePath, e);
                errors.push({ file: filePath, message: e.message });
            }
        }

        console.log(`⚡ workspace-fast: disk=${savedToDisk}, dbQueued=${queuedForDb}, skipped=${skipped}, errors=${errors.length}`);

        return res.json({
            ok: true,
            mode: 'fast',
            savedToDisk,
            dbQueued: queuedForDb,
            skipped,
            errors,
            timestamp: timestamp || Date.now(),
        });
    } catch (error) {
        console.error('❌ Error in /files/workspace-fast:', error);
        res.status(500).json({ error: 'server_error', details: error.message });
    }
});

// Compress and store node_modules for faster restoration
app.post('/files/compress-node-modules', async (req, res) => {
    try {
        const { nodeModulesData } = req.body;
        const sessionId = req.headers['x-session-id'];
        
        if (!nodeModulesData || !sessionId) {
            return res.status(400).json({ error: 'nodeModulesData and sessionId required' });
        }
        
        // Get session info to use correct workspace path
        const terminalToken = req.headers['x-terminal-token'];
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        console.log(`🗜️ Compressing node_modules for session: ${sessionId}`);
        
        // Create compressed storage directory using correct path
        const compressedDir = path.join(path.resolve(verified.workspace_path), 'compressed');
        if (!fs.existsSync(compressedDir)) {
            fs.mkdirSync(compressedDir, { recursive: true });
        }
        
        // Compress node_modules data
        const compressedPath = path.join(compressedDir, 'node_modules.gz');
        const writeStream = fs.createWriteStream(compressedPath);
        const gzipStream = createGzip({ level: 9 }); // Maximum compression
        
        await pipeline(
            fs.createReadStream(Buffer.from(JSON.stringify(nodeModulesData))),
            gzipStream,
            writeStream
        );
        
        // Get compressed file size
        const stats = fs.statSync(compressedPath);
        const originalSize = JSON.stringify(nodeModulesData).length;
        const compressionRatio = ((originalSize - stats.size) / originalSize * 100).toFixed(1);
        
        console.log(`✅ Node_modules compressed: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(stats.size / 1024 / 1024).toFixed(1)}MB (${compressionRatio}% reduction)`);
        
        res.json({ 
            ok: true, 
            originalSize,
            compressedSize: stats.size,
            compressionRatio: `${compressionRatio}%`
        });
        
    } catch (error) {
        console.error('❌ Error compressing node_modules:', error);
        res.status(500).json({ error: 'compression_error', details: error.message });
    }
});

// Restore node_modules from compressed storage
app.post('/files/restore-node-modules', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        
        console.log(`📦 Restoring node_modules for session: ${sessionId}`);
        
        const compressedPath = path.join(path.resolve(verified?.workspace_path || WORKSPACE_DIR), 'compressed', 'node_modules.gz');
        
        if (!fs.existsSync(compressedPath)) {
            return res.status(404).json({ error: 'No compressed node_modules found' });
        }
        
        // Decompress node_modules
        const readStream = fs.createReadStream(compressedPath);
        const gunzipStream = createGunzip();
        const chunks = [];
        
        readStream.pipe(gunzipStream);
        
        gunzipStream.on('data', (chunk) => {
            chunks.push(chunk);
        });
        
        gunzipStream.on('end', async () => {
            try {
                const decompressedData = Buffer.concat(chunks).toString();
                const nodeModulesData = JSON.parse(decompressedData);
                
                // Restore files to session workspace
                const sessionWorkspaceDir = path.resolve(verified?.workspace_path || path.join(WORKSPACE_DIR, 'sessions', sessionId));
                let restoredCount = 0;
                
                for (const [filePath, content] of Object.entries(nodeModulesData)) {
                    try {
                        // Save to database
                        await saveFile({ sessionId, filename: filePath, content });
                        
                        // Save to session workspace
                        const fullPath = path.join(sessionWorkspaceDir, filePath);
                        const dirPath = path.dirname(fullPath);
                        
                        if (!fs.existsSync(dirPath)) {
                            fs.mkdirSync(dirPath, { recursive: true });
                        }
                        
                        fs.writeFileSync(fullPath, content);
                        restoredCount++;
                    } catch (error) {
                        console.error(`❌ Error restoring file ${filePath}:`, error);
                    }
                }
                
                console.log(`✅ Node_modules restored: ${restoredCount} files`);
                
                res.json({ 
                    ok: true, 
                    restored: restoredCount,
                    totalFiles: Object.keys(nodeModulesData).length
                });
                
            } catch (error) {
                console.error('❌ Error parsing decompressed data:', error);
                res.status(500).json({ error: 'decompression_error', details: error.message });
            }
        });
        
        gunzipStream.on('error', (error) => {
            console.error('❌ Decompression error:', error);
            res.status(500).json({ error: 'decompression_error', details: error.message });
        });
        
    } catch (error) {
        console.error('❌ Error restoring node_modules:', error);
        res.status(500).json({ error: 'restore_error', details: error.message });
    }
});

// Receive zipped workspace (single request) and extract safely
app.post('/upload/zip', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const project = (req.query.project || 'workspace').toString().replace(/[^a-zA-Z0-9_\-\/]/g, '');
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        if (!terminalToken) return res.status(401).json({ error: 'Terminal token required' });
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) return res.status(401).json({ error: 'Invalid session or token' });

        const sessionDir = path.resolve(verified.workspace_path);
        const targetDir = path.join(sessionDir, project);
        const tempDir = path.join(sessionDir, `.upload_tmp_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // Stream unzip into temp directory first to avoid partial overwrite
        await new Promise((resolve, reject) => {
            const extract = unzipper.Extract({ path: tempDir });
            extract.on('close', resolve);
            extract.on('error', reject);
            req.pipe(extract);
        });

        // Ensure target exists
        fs.mkdirSync(targetDir, { recursive: true });

        // Move files from temp to target (preserve existing if missing)
        const moveRecursive = (src, dst) => {
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                const srcPath = path.join(src, entry.name);
                const dstPath = path.join(dst, entry.name);
                if (entry.isDirectory()) {
                    fs.mkdirSync(dstPath, { recursive: true });
                    moveRecursive(srcPath, dstPath);
                } else {
                    // Write file (overwrite is OK because we finished full unzip)
                    fs.copyFileSync(srcPath, dstPath);
                }
            }
        };
        moveRecursive(tempDir, targetDir);
        fs.rmSync(tempDir, { recursive: true, force: true });

        console.log(`✅ ZIP extracted to ${targetDir}`);
        res.json({ ok: true, project });
    } catch (e) {
        console.error('❌ Error handling zip upload:', e);
        res.status(500).json({ error: 'zip_extract_error', details: e.message });
    }
});

// Chunked zip upload (very large zips)
app.post('/upload/zip-chunk', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const id = (req.query.id || '').toString();
        const project = (req.query.project || 'workspace').toString().replace(/[^a-zA-Z0-9_\-\/]/g, '');
        const index = parseInt((req.query.index || '0').toString(), 10);
        if (!sessionId || !id || Number.isNaN(index)) return res.status(400).json({ error: 'missing params' });
        if (!terminalToken) return res.status(401).json({ error: 'Terminal token required' });
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) return res.status(401).json({ error: 'Invalid session or token' });

        const chunkDir = path.join(path.resolve(verified.workspace_path), '.chunks', id);
        fs.mkdirSync(chunkDir, { recursive: true });
        const chunkPath = path.join(chunkDir, `${index}.part`);

        const ws = fs.createWriteStream(chunkPath);
        await new Promise((resolve, reject) => {
            req.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
        });

        res.json({ ok: true });
    } catch (e) {
        console.error('❌ zip-chunk error:', e);
        res.status(500).json({ error: 'zip_chunk_error', details: e.message });
    }
});

app.post('/upload/zip-chunk/complete', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const id = (req.query.id || '').toString();
        const project = (req.query.project || 'workspace').toString().replace(/[^a-zA-Z0-9_\-\/]/g, '');
        if (!sessionId || !id) return res.status(400).json({ error: 'missing params' });
        if (!terminalToken) return res.status(401).json({ error: 'Terminal token required' });
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) return res.status(401).json({ error: 'Invalid session or token' });

        const baseDir = path.resolve(verified.workspace_path);
        const chunkDir = path.join(baseDir, '.chunks', id);
        const tempZip = path.join(baseDir, `.upload_${id}.zip`);

        // Concatenate parts in order
        const parts = fs.readdirSync(chunkDir).filter(n => n.endsWith('.part')).sort((a, b) => parseInt(a) - parseInt(b));
        const ws = fs.createWriteStream(tempZip);
        for (const p of parts) {
            const buf = fs.readFileSync(path.join(chunkDir, p));
            ws.write(buf);
        }
        ws.end();
        await new Promise(r => ws.on('close', r));

        // Extract zip into temp then move like single zip handler
        const tempDir = path.join(baseDir, `.upload_tmp_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        await new Promise((resolve, reject) => {
            const extract = unzipper.Extract({ path: tempDir });
            extract.on('close', resolve);
            extract.on('error', reject);
            fs.createReadStream(tempZip).pipe(extract);
        });

        const targetDir = path.join(baseDir, project);
        fs.mkdirSync(targetDir, { recursive: true });
        const moveRecursive = (src, dst) => {
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                const srcPath = path.join(src, entry.name);
                const dstPath = path.join(dst, entry.name);
                if (entry.isDirectory()) {
                    fs.mkdirSync(dstPath, { recursive: true });
                    moveRecursive(srcPath, dstPath);
                } else {
                    fs.copyFileSync(srcPath, dstPath);
                }
            }
        };
        moveRecursive(tempDir, targetDir);
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(chunkDir, { recursive: true, force: true });
        fs.rmSync(tempZip, { force: true });

        console.log(`✅ Chunked ZIP extracted to ${targetDir}`);
        res.json({ ok: true, project });
    } catch (e) {
        console.error('❌ zip-chunk complete error:', e);
        res.status(500).json({ error: 'zip_chunk_complete_error', details: e.message });
    }
});

// Batch upload system with staging and atomic commits
app.post('/api/files/upload-batch', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const { batchId, files, projectId = 'workspace' } = req.body;
        
        if (!sessionId || !batchId || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'sessionId, batchId, and files array required' });
        }
        if (!terminalToken) return res.status(401).json({ error: 'Terminal token required' });
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) return res.status(401).json({ error: 'Invalid session or token' });

        console.log(`📦 Processing batch ${batchId} with ${files.length} files for session: ${sessionId}`);

        // Create staging directory
        const stagingDir = path.join(path.resolve(verified.workspace_path), '.staging', batchId);
        const sessionDir = path.resolve(verified.workspace_path);
        const projectDir = path.join(sessionDir, projectId);
        
        fs.mkdirSync(stagingDir, { recursive: true });
        fs.mkdirSync(projectDir, { recursive: true });

        const results = [];
        let successCount = 0;
        let errorCount = 0;

        // Process each file in the batch
        for (const fileData of files) {
            try {
                const { path: filePath, content, size, mtime, hash } = fileData;
                
                // Validate file data
                if (!filePath || content === undefined) {
                    throw new Error('Invalid file data: missing path or content');
                }

                // Write to staging first
                const stagingPath = path.join(stagingDir, filePath);
                const stagingDirPath = path.dirname(stagingPath);
                
                if (!fs.existsSync(stagingDirPath)) {
                    fs.mkdirSync(stagingDirPath, { recursive: true });
                }
                
                fs.writeFileSync(stagingPath, content);
                
                results.push({
                    path: filePath,
                    success: true,
                    staged: true
                });
                
                successCount++;
                
            } catch (error) {
                console.error(`❌ Error processing file in batch:`, error);
                results.push({
                    path: fileData.path || 'unknown',
                    success: false,
                    error: error.message
                });
                errorCount++;
            }
        }

        // If all files staged successfully, commit to final location
        if (errorCount === 0) {
            try {
                // Move files from staging to final location
                const moveRecursive = (src, dst) => {
                    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                        const srcPath = path.join(src, entry.name);
                        const dstPath = path.join(dst, entry.name);
                        
                        if (entry.isDirectory()) {
                            fs.mkdirSync(dstPath, { recursive: true });
                            moveRecursive(srcPath, dstPath);
                        } else {
                            fs.copyFileSync(srcPath, dstPath);
                        }
                    }
                };
                
                moveRecursive(stagingDir, projectDir);
                
                // Save to database
                for (const fileData of files) {
                    try {
                        if (shouldPersistInDb(fileData.path, fileData.content)) {
                            await saveFile({ 
                                sessionId, 
                                filename: fileData.path, 
                                content: fileData.content 
                            });
                        }
                    } catch (error) {
                        console.error(`❌ Error saving to database:`, error);
                    }
                }
                
                // Clean up staging
                fs.rmSync(stagingDir, { recursive: true, force: true });
                
                console.log(`✅ Batch ${batchId} committed successfully: ${successCount} files`);
                
            } catch (error) {
                console.error(`❌ Error committing batch ${batchId}:`, error);
                // Clean up staging on error
                fs.rmSync(stagingDir, { recursive: true, force: true });
                throw error;
            }
        } else {
            // Clean up staging on partial failure
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        res.json({
            ok: true,
            batchId,
            successCount,
            errorCount,
            results
        });

    } catch (error) {
        console.error('❌ Error in /api/files/upload-batch:', error);
        res.status(500).json({ error: 'batch_upload_error', details: error.message });
    }
});

// Single file upload for batch system
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const { path: filePath, size, mtime, hash } = req.body;
        
        if (!sessionId || !req.file) {
            return res.status(400).json({ error: 'sessionId and file required' });
        }

        const actualPath = filePath || req.file.originalname;
        const content = req.file.buffer.toString('utf8');
        const terminalToken = req.headers['x-terminal-token'];
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        // Save to database (policy-gated)
        if (shouldPersistInDb(actualPath, content)) {
            await saveFile({ sessionId, filename: actualPath, content });
        }
        
        // Save to session workspace (use verified workspace_path)
        const sessionDir = path.resolve(verified.workspace_path);
        const fullPath = path.join(sessionDir, actualPath);
        const dirPath = path.dirname(fullPath);
        
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        fs.writeFileSync(fullPath, content);
        
        res.json({
            ok: true,
            path: actualPath,
            size: content.length
        });

    } catch (error) {
        console.error('❌ Error in /api/files/upload:', error);
        res.status(500).json({ error: 'upload_error', details: error.message });
    }
});

// Chunked file upload for large files
app.post('/api/files/upload-chunk', upload.single('file'), async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const { path: filePath, chunkIndex, totalChunks, uploadId, hash } = req.body;
        
        if (!sessionId || !req.file || !filePath || chunkIndex === undefined || totalChunks === undefined || !uploadId) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }

        // Create chunk directory
        const chunkDir = path.join(path.resolve(verified.workspace_path), '.chunks', uploadId);
        fs.mkdirSync(chunkDir, { recursive: true });
        
        // Save chunk
        const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
        fs.writeFileSync(chunkPath, req.file.buffer);
        
        res.json({ ok: true, chunkIndex });

    } catch (error) {
        console.error('❌ Error in /api/files/upload-chunk:', error);
        res.status(500).json({ error: 'chunk_upload_error', details: error.message });
    }
});

// Complete chunked upload
app.post('/api/files/upload-complete', async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        const { path: filePath, uploadId, totalChunks, hash } = req.body;
        
        if (!sessionId || !filePath || !uploadId || !totalChunks) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }

        // Reconstruct file from chunks
        const chunkDir = path.join(path.resolve(verified.workspace_path), '.chunks', uploadId);
        const chunks = [];
        
        for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(chunkDir, `chunk_${i}`);
            if (fs.existsSync(chunkPath)) {
                chunks.push(fs.readFileSync(chunkPath));
            } else {
                throw new Error(`Missing chunk ${i}`);
            }
        }
        
        const content = Buffer.concat(chunks).toString('utf8');
        
        // Save to database (policy-gated)
        if (shouldPersistInDb(filePath, content)) {
            await saveFile({ sessionId, filename: filePath, content });
        }
        
        // Save to session workspace (use verified workspace_path)
        const sessionDir = path.resolve(verified.workspace_path);
        const fullPath = path.join(sessionDir, filePath);
        const dirPath = path.dirname(fullPath);
        
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        fs.writeFileSync(fullPath, content);
        
        // Clean up chunks
        fs.rmSync(chunkDir, { recursive: true, force: true });
        
        res.json({
            ok: true,
            path: filePath,
            size: content.length
        });

    } catch (error) {
        console.error('❌ Error in /api/files/upload-complete:', error);
        res.status(500).json({ error: 'upload_complete_error', details: error.message });
    }
});

// Upload multiple files (DB-only), preserving provided relative paths
app.post('/files/upload', upload.array('files'), async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        const pathsRaw = (req.body && req.body.paths) ? req.body.paths : '[]';
        let paths = [];
        try { paths = JSON.parse(pathsRaw); } catch { paths = []; }

        const filesArr = req.files || [];
        if (!Array.isArray(filesArr) || filesArr.length === 0) {
            return res.status(400).json({ error: 'no_files' });
        }

        for (let i = 0; i < filesArr.length; i++) {
            const file = filesArr[i];
            const relPath = (paths[i] || file.originalname || '').replace(/^\/+/, '').replace(/\\/g, '/');
            if (!relPath) continue;
            
            // Save to database (policy-gated)
            if (shouldPersistInDb(relPath, file.buffer)) {
                await saveFile({ sessionId, filename: relPath, content: file.buffer });
            }
            
            // Immediately sync to session workspace for terminal access
            try {
                const sessionWorkspaceDir = path.resolve(verified.workspace_path);
                const filePath = path.join(sessionWorkspaceDir, relPath);
                const dirPath = path.dirname(filePath);
                
                // Ensure directory exists
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }
                
                // Write file to session workspace
                fs.writeFileSync(filePath, file.buffer);
                console.log(`📄 Synced uploaded file to session workspace: ${relPath}`);
            } catch (syncError) {
                console.error(`⚠️ Error syncing uploaded file ${relPath}:`, syncError);
            }
        }

        res.json({ ok: true, uploaded: filesArr.length });
    } catch (error) {
        console.error('❌ Error in /files/upload:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Delete folder recursively: remove all DB files with prefix and delete from workspace
app.post('/folders/delete', async (req, res) => {
    try {
        const { folderPath } = req.body;
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        if (!folderPath || !sessionId) {
            return res.status(400).json({ error: 'folderPath and sessionId required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        const files = await listFilesBySession(sessionId);
        const toDelete = files.filter(f => f.filename.startsWith(folderPath + '/'));
        for (const f of toDelete) {
            await deleteFileByName({ sessionId, filename: f.filename });
        }
        // Remove placeholder if present
        await deleteFileByName({ sessionId, filename: path.join(folderPath, '.folder') });
        // Remove on disk
        const sessionWorkspaceDir = path.resolve(verified.workspace_path);
        const fullFolder = path.join(sessionWorkspaceDir, folderPath);
        if (fs.existsSync(fullFolder)) {
            fs.rmSync(fullFolder, { recursive: true, force: true });
        }
        return res.json({ ok: true, deleted: toDelete.length });
    } catch (error) {
        console.error('❌ Error in /folders/delete:', error);
        return res.status(500).json({ error: 'server_error' });
    }
});

// Delete file endpoint
app.delete('/files/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }
        
        await deleteFileByName({ sessionId, filename });
        // Also remove from session workspace
        try {
            const sessionWorkspaceDir = path.resolve(verified.workspace_path);
            const fullPath = path.join(sessionWorkspaceDir, filename);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch {}
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /files/delete:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Delete session endpoint
app.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        
        await deleteSession(sessionId);
        
        // Also clean up the session from memory
        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (session.ptyProcess) {
                session.ptyProcess.kill();
            }
            if (session.ws) {
                session.ws.close();
            }
            sessions.delete(sessionId);
        }
        
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /sessions/delete:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server with better configuration
const wss = new WebSocketServer({ 
    server,
    // Increase timeout and add keep-alive settings
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024, // 16MB max payload
    handshakeTimeout: 30000, // 30 seconds
    // Add ping/pong settings
    pingTimeout: 60000, // 60 seconds
    pingInterval: 30000 // 30 seconds
});

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket connection established');
    
    let currentSessionId = null;
    let heartbeatInterval = null;
    let isAlive = true;
    
    // Set up heartbeat to keep connection alive
    const startHeartbeat = () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (isAlive && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.ping();
                } catch (error) {
                    console.log('❌ Heartbeat ping failed:', error.message);
                    isAlive = false;
                    clearInterval(heartbeatInterval);
                }
            }
        }, 30000); // Ping every 30 seconds
    };
    
    ws.on('pong', () => {
        isAlive = true;
    });
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received message:', data.type);
            
            // Reset heartbeat on any message
            isAlive = true;
            
            switch (data.type) {
                case 'init':
                    await handleInit(ws, data);
                    startHeartbeat(); // Start heartbeat after init
                    break;
                case 'reconnect':
                    await handleReconnect(ws, data);
                    startHeartbeat(); // Start heartbeat after reconnect
                    break;
                case 'input':
                    await handleInput(ws, data);
                    break;
                case 'ping':
                    // Respond to client ping
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                default:
                    console.log('❌ Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('❌ Error handling WebSocket message:', error);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log('🔌 WebSocket connection closed:', code, reason.toString());
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (currentSessionId && sessions.has(currentSessionId)) {
            const session = sessions.get(currentSessionId);
            if (session.ptyProcess) {
                // Don't kill the PTY process immediately - let it finish
                console.log('🔄 Keeping PTY process alive for potential reconnection');
            }
            if (session.keepAliveInterval) {
                clearInterval(session.keepAliveInterval);
            }
            // Keep session alive for reconnection but mark WebSocket as null
            session.ws = null;
            console.log('🔄 Keeping session alive for potential reconnection, WebSocket set to null');
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        // Don't close the connection immediately on error
        // Let the client handle reconnection
    });
    
    async function handleInit(ws, data) {
        try {
            const { sessionId, terminalToken } = data;
            if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
                return;
            }
            
            if (!terminalToken) {
                ws.send(JSON.stringify({ type: 'error', message: 'Terminal token required for session verification' }));
                return;
            }
            
            // Verify terminal session with SQLite
            const sessionInfo = await verifyTerminalSession(sessionId, terminalToken);
            if (!sessionInfo) {
                console.error('❌ Session verification failed:', { sessionId, terminalToken });
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid session or terminal token' }));
                return;
            }
            
            // Check if session already exists in memory and reuse it
            if (sessions.has(sessionId)) {
                console.log('🔄 Session already exists, reusing existing session:', sessionId);
                const existingSession = sessions.get(sessionId);
                existingSession.ws = ws; // Update WebSocket reference
                currentSessionId = sessionId;
                ws.send(JSON.stringify({ type: 'pty-ready' }));
                return;
            }
            
            currentSessionId = sessionId;
            console.log('🔧 Initializing verified session:', sessionId, 'for user:', sessionInfo.user_id);
            
            // Use SQLite session's isolated workspace directory
            const sessionWorkspaceDir = path.resolve(sessionInfo.workspace_path).replace(/\\/g, '/');
            if (!fs.existsSync(sessionWorkspaceDir)) {
                fs.mkdirSync(sessionWorkspaceDir, { recursive: true });
                console.log('📁 Created isolated session workspace:', sessionWorkspaceDir);
            } else {
                console.log('📁 Using existing isolated session workspace:', sessionWorkspaceDir);
            }
            
            // Create new session 
            const session = {
                ws,
                ptyProcess: null,
                userId: sessionInfo.user_id,
                currentCwd: sessionWorkspaceDir,
                ptyReady: false,
                containerId: null,
                commandTimeout: null,  // ✅ ADDED: Command timeout property
                terminalToken: terminalToken,  // Store terminal token for verification
                workspacePath: sessionInfo.workspace_path  // Store workspace path
            };
            
            sessions.set(sessionId, session);
            
            // Sync files from database to session workspace
            try {
                const files = await listFilesBySession(sessionId);
                for (const file of files) {
                    const content = await readFileByName({ sessionId, filename: file.filename });
                    if (content) {
                        const filePath = path.join(sessionWorkspaceDir, file.filename);
                        fs.mkdirSync(path.dirname(filePath), { recursive: true });
                        fs.writeFileSync(filePath, content);
                        console.log('📄 Synced file to session workspace:', file.filename);
                    }
                }
                // Auto-select project root: if there is exactly one top-level folder and no files at root, cd into it
                try {
                    const topLevels = new Set();
                    let hasRootFiles = false;
                    for (const row of files) {
                        const parts = String(row.filename).split('/').filter(Boolean);
                        if (parts.length === 0) continue;
                        if (parts.length === 1) {
                            // a file directly at root
                            hasRootFiles = true;
                        }
                        topLevels.add(parts[0]);
                    }
                    if (!hasRootFiles && topLevels.size === 1) {
                        const only = Array.from(topLevels)[0];
                        const newCwd = path.join(sessionWorkspaceDir, only);
                        if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
                            session.currentCwd = newCwd;
                            // Update PTY working directory
                            session.ptyProcess?.write('cd "' + newCwd + '"\n');
                        }
                    }
                } catch (autocdErr) {
                    console.log('ℹ️ Auto-cd detection skipped:', autocdErr?.message);
                }
            } catch (syncError) {
                console.error('⚠️ Error syncing files to session workspace:', syncError);
            }
            
            // Initialize PTY process with restricted environment
            try {
                const { spawn } = await import('node-pty');
                
                // Create restricted environment - only allow access to session workspace
                const restrictedEnv = {
                    ...process.env,
                    HOME: sessionWorkspaceDir,
                    PWD: sessionWorkspaceDir,
                    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                    TERM: 'xterm-color',
                    // npm Configuration for cleaner terminal output and better reliability
                    NPM_CONFIG_LOGLEVEL: 'warn',
                    NPM_CONFIG_PROGRESS: 'false',
                    NPM_CONFIG_AUDIT: 'false',
                    NPM_CONFIG_FUND: 'false',
                    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
                    // ✅ FIXED: Use system npm cache instead of session-specific (causes permission issues)
                    // NPM_CONFIG_CACHE: path.join(sessionWorkspaceDir, '.npm-cache'),
                    // NPM_CONFIG_PREFIX: path.join(sessionWorkspaceDir, '.npm-global'),
                    // Increase timeout for long-running commands
                    NPM_CONFIG_TIMEOUT: '300000', // 5 minutes
                    NPM_CONFIG_REGISTRY_TIMEOUT: '300000',
                    // Disable some features that might cause issues
                    NPM_CONFIG_SAVE: 'false',
                    NPM_CONFIG_SAVE_EXACT: 'false'
                };
                
                session.ptyProcess = spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', ['-i'], {
                    name: 'xterm-color',
                    cols: 80,
                    rows: 30,
                    cwd: sessionWorkspaceDir,
                    env: restrictedEnv,
                    // Add options to prevent process from being killed
                    detached: false,
                    stdio: 'pipe',
                    // Add process options for better stability
                    windowsHide: true,
                    // Increase buffer sizes for long-running commands
                    maxBuffer: 1024 * 1024 * 10, // 10MB buffer
                    // Prevent process from being killed by parent
                    killSignal: 'SIGTERM'
                    // ❌ REMOVED: timeout: 30000 - This was killing the entire process!
                });
                
                // ✅ FIXED: Properly initialize terminal in session directory
                console.log(`📁 Initializing terminal in: ${sessionWorkspaceDir}`);
                
                // Wait for terminal to be ready, then change directory
                setTimeout(() => {
                    console.log(`🔄 Changing terminal directory to: ${sessionWorkspaceDir}`);
                    session.ptyProcess.write('cd "' + sessionWorkspaceDir + '"\n');
                    session.ptyProcess.write('export PWD="' + sessionWorkspaceDir + '"\n');
                    session.ptyProcess.write('export HOME="' + sessionWorkspaceDir + '"\n');
                    // Ensure npm paths use absolute session path (not relative)
                    session.ptyProcess.write('export NPM_CONFIG_CACHE="' + sessionWorkspaceDir + '/.npm-cache"\n');
                    session.ptyProcess.write('export NPM_CONFIG_PREFIX="' + sessionWorkspaceDir + '/.npm-global"\n');
                    // Ensure permissions so cd/ls work reliably
                    session.ptyProcess.write('chmod -R 777 "' + sessionWorkspaceDir + '" 2>/dev/null || true\n');
                    // Make prompt show absolute cwd instead of ~
                    session.ptyProcess.write('export PS1="\\u@\\h:$(pwd)# "\n');
                    session.ptyProcess.write('pwd\n'); // Verify directory
                    session.ptyProcess.write('ls -la\n'); // Show contents
                    session.ptyProcess.write('echo "📁 Checking for frontend folder..."\n');
                    session.ptyProcess.write('ls -la frontend/ 2>/dev/null || echo "❌ No frontend folder found"\n');
                    session.ptyProcess.write('echo "📁 Checking for backend folder..."\n');
                    session.ptyProcess.write('ls -la backend/ 2>/dev/null || echo "❌ No backend folder found"\n');
                    console.log(`✅ Terminal directory change completed`);
                }, 1000); // Wait 1 second for terminal to be ready
                
                // ✅ FIXED: Create npm directories and set proper permissions
                session.ptyProcess.write('mkdir -p .npm-cache .npm-global 2>/dev/null || true\n');
                session.ptyProcess.write('export NPM_CONFIG_CACHE="' + sessionWorkspaceDir + '/.npm-cache"\n');
                session.ptyProcess.write('export NPM_CONFIG_PREFIX="' + sessionWorkspaceDir + '/.npm-global"\n');
                
                // ✅ ADDED: Periodic sync of terminal-created files to database
                const syncTerminalFiles = async () => {
                    try {
                        const files = await scanDirectoryForFiles(sessionWorkspaceDir, sessionWorkspaceDir);
                        if (files.length > 0) {
                            console.log(`🔄 Syncing ${files.length} terminal-created files to database...`);
                            const result = await batchSaveFiles({ sessionId, files });
                            console.log(`✅ Terminal sync completed: ${result.saved} saved, ${result.updated} updated`);
                        }
                    } catch (error) {
                        console.error('⚠️ Error syncing terminal files:', error);
                    }
                };
                
                // Sync every 30 seconds
                session.syncInterval = setInterval(syncTerminalFiles, 30000);
                
                // Initialize git configuration in the session directory (local config)
                // Wait a moment for the shell to be ready
                setTimeout(() => {
                    // Initialize git repo first, then set config
                    session.ptyProcess.write('git init 2>/dev/null || true\n');
                    session.ptyProcess.write('git config user.name "IDE User" 2>/dev/null || true\n');
                    session.ptyProcess.write('git config user.email "user@ide.local" 2>/dev/null || true\n');
                }, 1000);
                session.ptyProcess.write('function cd() { if [[ "$1" == "/"* ]] && [[ "$1" != "' + sessionWorkspaceDir + '"* ]]; then echo "Access denied: Cannot access system directories"; return 1; fi; builtin cd "$@"; }\n');
                session.ptyProcess.write('export -f cd\n');
                
                // Add command timeout handling
                let commandTimeout = null;
                let currentCommand = '';
                let terminalReady = false; // ✅ ADDED: Terminal readiness flag
                
                session.ptyProcess.onData((data) => {
                    lastActivity = Date.now(); // Update activity timestamp
                    
                    // ✅ ADDED: Debug PTY output
                    console.log(`📤 PTY OUTPUT (${data.length} bytes):`, data.toString().substring(0, 100));
                    
                    // Clear any existing timeout when we get output
                    if (session.commandTimeout) {
                        clearTimeout(session.commandTimeout);
                        session.commandTimeout = null;
                    }
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'output', data }));
                        console.log(`📤 Sent to frontend: ${data.toString().substring(0, 50)}...`);
                    } else {
                        console.log('⚠️ WebSocket not ready, cannot send output');
                    }
                });
                
                session.ptyProcess.onExit(({ exitCode, signal }) => {
                    console.log('🔌 PTY process exited:', { exitCode, signal });
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
                    }
                });
                
                // Add process monitoring to prevent unexpected kills
                session.ptyProcess.on('error', (error) => {
                    console.error('❌ PTY process error:', error);
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.send(JSON.stringify({ type: 'error', message: `PTY process error: ${error.message}` }));
                    }
                });
                
                // Keep-alive mechanism that doesn't interfere with commands
                let lastActivity = Date.now();
                let keepAliveInterval = setInterval(() => {
                    const now = Date.now();
                    const timeSinceActivity = now - lastActivity;
                    
                    // If no activity for 2 minutes, send a harmless command to keep connection alive
                    if (timeSinceActivity > 120000 && session.ptyProcess && !session.ptyProcess.killed) {
                        try {
                            // Send a harmless command that won't interfere with npm install
                            session.ptyProcess.write('echo "\\r\\n[Keep-alive ping]\\r\\n"\n');
                            lastActivity = now;
                        } catch (error) {
                            console.log('Keep-alive ping failed:', error.message);
                        }
                    }
                    
                    // Check if PTY process was killed and restart if needed
                    if (session.ptyProcess && session.ptyProcess.killed) {
                        console.log('⚠️ PTY process was killed, attempting to restart...');
                        try {
                            session.ptyProcess = spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
                                name: 'xterm-color',
                                cols: 80,
                                rows: 30,
                                cwd: sessionWorkspaceDir,
                                env: restrictedEnv,
                                detached: false,
                                stdio: 'pipe'
                            });
                            
                            session.ptyProcess.write('cd "' + sessionWorkspaceDir + '"\n');
                            session.ptyProcess.write('export PWD="' + sessionWorkspaceDir + '"\n');
                            session.ptyProcess.write('export HOME="' + sessionWorkspaceDir + '"\n');
                            
                            session.ptyProcess.onData((data) => {
                                lastActivity = Date.now(); // Update activity timestamp
                                if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                    session.ws.send(JSON.stringify({ type: 'output', data }));
                                }
                            });
                            
                            session.ptyProcess.onExit(({ exitCode, signal }) => {
                                console.log('🔌 PTY process exited:', { exitCode, signal });
                                if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                    session.ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
                                }
                            });
                            
                            session.ptyProcess.on('error', (error) => {
                                console.error('❌ PTY process error:', error);
                                if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                                    session.ws.send(JSON.stringify({ type: 'error', message: `PTY process error: ${error.message}` }));
                                }
                            });
                            
                            console.log('✅ PTY process restarted');
                        } catch (restartError) {
                            console.error('❌ Failed to restart PTY process:', restartError);
                        }
                    }
                }, 30000); // Check every 30 seconds
                
                // Store the interval ID so we can clear it later
                session.keepAliveInterval = keepAliveInterval;
                
                session.ptyReady = true;
                console.log('✅ PTY process initialized for session:', sessionId);
                
                ws.send(JSON.stringify({ type: 'pty-ready', sessionId: sessionId, message: 'Terminal ready' }));
            } catch (ptyError) {
                console.error('❌ Failed to initialize PTY:', ptyError);
                ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize terminal' }));
            }
        } catch (error) {
            console.error('❌ Error in handleInit:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Initialization failed' }));
        }
    }
    
    async function handleReconnect(ws, data) {
        try {
            const { sessionId, terminalToken } = data;
            if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
                return;
            }
            
            if (!terminalToken) {
                ws.send(JSON.stringify({ type: 'error', message: 'Terminal token required for session verification' }));
                return;
            }
            
            // Verify terminal session with SQLite
            const sessionInfo = await verifyTerminalSession(sessionId, terminalToken);
            if (!sessionInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid session or terminal token' }));
                return;
            }
            
            currentSessionId = sessionId;
            console.log('🔧 Reconnecting to verified session:', sessionId, 'for user:', sessionInfo.user_id);
            
            if (sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                session.ws = ws;
                
                if (session.ptyReady) {
                    // Re-assert environment, cwd, and absolute npm vars on reconnect
                    const sessionWorkspaceDir = path.resolve(sessionInfo.workspace_path).replace(/\\/g, '/');
                    try {
                        session.ptyProcess.write('cd "' + sessionWorkspaceDir + '"\n');
                        session.ptyProcess.write('export PWD="' + sessionWorkspaceDir + '"\n');
                        session.ptyProcess.write('export HOME="' + sessionWorkspaceDir + '"\n');
                        session.ptyProcess.write('export NPM_CONFIG_CACHE="' + sessionWorkspaceDir + '/.npm-cache"\n');
                        session.ptyProcess.write('export NPM_CONFIG_PREFIX="' + sessionWorkspaceDir + '/.npm-global"\n');
                        session.ptyProcess.write('pwd\n');
                    } catch {}
                    ws.send(JSON.stringify({ type: 'pty-ready', sessionId: sessionId, message: 'Terminal ready' }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Session not ready' }));
                }
            } else {
                // Session doesn't exist in memory, but exists in database
                // Create a new session in memory for this sessionId
                console.log('🆕 Creating new session in memory for existing sessionId:', sessionId);
                await handleInit(ws, { sessionId, terminalToken });
            }
        } catch (error) {
            console.error('❌ Error in handleReconnect:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Reconnection failed' }));
        }
    }
    
    async function handleInput(ws, data) {
        try {
            const { input, sessionId } = data;
            if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
                return;
            }
            
            currentSessionId = sessionId;
            
            if (sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                if (session.ptyProcess && session.ptyReady) {
                    // Only block navigating to backend root
                    const dangerousCommands = ['cd /app'];
                    
                    const inputLower = input.toLowerCase().trim();
                    const isDangerous = dangerousCommands.some(cmd => 
                        inputLower.includes(cmd.toLowerCase())
                    );
                    
                    if (isDangerous) {
                        ws.send(JSON.stringify({ 
                            type: 'output', 
                            data: `\r\n\x1b[31m[SECURITY] Access denied: Command blocked for security reasons\x1b[0m\r\n` 
                        }));
                        return;
                    }

                    // Basic session-scoped FS sync for common commands
                    try {
                        // Use the session's stored workspace path
                        const sessionWorkspaceDir = session.workspacePath ? path.resolve(session.workspacePath).replace(/\\/g, '/') : session.currentCwd;
                        if (!session.currentCwd) session.currentCwd = sessionWorkspaceDir;
                        const trimmed = input.trim();
                        const parts = trimmed.split(/\s+/);
                        const cmd = parts[0];

                        const toRel = (p) => {
                            const resolved = path.isAbsolute(p) ? p : path.resolve(session.currentCwd || sessionWorkspaceDir, p);
                            if (resolved.startsWith(sessionWorkspaceDir)) {
                                return path.relative(sessionWorkspaceDir, resolved).replace(/^\\/g, '').replace(/\\/g, '/');
                            }
                            return null; // outside workspace -> ignore
                        };

                        // Track cd to keep a server-side cwd for DB path resolution
                        if (cmd === 'cd' && parts.length >= 2) {
                            const target = parts.slice(1).join(' ');
                            const newCwdAbs = path.isAbsolute(target)
                                ? target
                                : path.resolve(session.currentCwd || sessionWorkspaceDir, target);
                            if (newCwdAbs.startsWith(sessionWorkspaceDir)) {
                                session.currentCwd = newCwdAbs;
                            }
                        }

                        // Comprehensive command analysis and execution
                        const analysis = await analyzeAndExecuteCommand({
                            raw: trimmed,
                            sessionId,
                            sessionWorkspaceDir,
                            currentCwdAbs: session.currentCwd
                        });
                        if (!analysis.ok) {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[31m[ERROR]\x1b[0m ${analysis.message}\r\n`
                            }));
                            return;
                        }
                        // Handle command actions (redirect, prepare, etc.)
                        if (analysis.action === 'redirect') {
                            const targetAbs = path.resolve(sessionWorkspaceDir, analysis.newCwd);
                            if (targetAbs.startsWith(sessionWorkspaceDir)) {
                                session.currentCwd = targetAbs;
                                session.ptyProcess.write('cd "' + targetAbs + '"\n');
                                ws.send(JSON.stringify({ 
                                    type: 'output', 
                                    data: `\r\n\x1b[36m[AUTO]\x1b[0m ${analysis.message}\r\n` 
                                }));
                            }
                        }

                        // Handle mkdir (single path)
                        if (cmd === 'mkdir' && parts.length >= 2) {
                            const folderArg = parts[parts.length - 1];
                            const rel = toRel(folderArg);
                            if (rel) {
                                const placeholder = path.join(rel, '.folder');
                                await saveFile({ sessionId, filename: placeholder, content: '' });
                            }
                        }

                        // Handle touch (can accept multiple paths)
                        if (cmd === 'touch' && parts.length >= 2) {
                            const fileArgs = parts.slice(1);
                            for (const f of fileArgs) {
                                const rel = toRel(f);
                                if (rel) {
                                    // Delay a bit, then read actual content from disk and persist to DB
                                    setTimeout(() => {
                                        try {
                                            const full = path.join(sessionWorkspaceDir, rel);
                                            if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                                                const content = fs.readFileSync(full, 'utf8');
                                                saveFile({ sessionId, filename: rel, content }).catch(() => {});
                                            } else {
                                                // File may not exist yet; create empty entry
                                                saveFile({ sessionId, filename: rel, content: '' }).catch(() => {});
                                            }
                                        } catch {}
                                    }, 300);
                                }
                            }
                        }

                        // Handle rm (file) and rm -rf (folder)
                        if (cmd === 'rm' && parts.length >= 2) {
                            const flags = parts.slice(1, -1).join(' ');
                            const target = parts[parts.length - 1];
                            const rel = toRel(target);
                            if (rel) {
                                if (/\-r|\-rf|\-fr/.test(flags)) {
                                    // Folder delete: remove all DB entries with prefix
                                    try {
                                        const files = await listFilesBySession(sessionId);
                                        for (const row of files) {
                                            if (row.filename.startsWith(rel + '/')) {
                                                await deleteFileByName({ sessionId, filename: row.filename });
                                            }
                                        }
                                        await deleteFileByName({ sessionId, filename: path.join(rel, '.folder') });
                                    } catch {}
                                } else {
                                    // File delete
                                    try { await deleteFileByName({ sessionId, filename: rel }); } catch {}
                                }
                            }
                        }
                    } catch (syncErr) {
                        console.error('⚠️ Command sync error:', syncErr);
                    }
                    
                    // ✅ CRITICAL FIX: Actually execute the command after all analysis and special handling
                    console.log(`🚀 EXECUTING COMMAND: ${input.trim()}`);
                    console.log(`🔍 PTY Process ready: ${session.ptyReady}, PID: ${session.ptyProcess.pid}`);
                    session.ptyProcess.write(input);
                    
                    // ✅ ADDED: Debug output for npm install specifically
                    if (input.trim().startsWith('npm install')) {
                        console.log('📦 npm install command sent, waiting for output...');
                        // Send a test message to frontend to confirm command was sent
                        ws.send(JSON.stringify({
                            type: 'output',
                            data: `\r\n\x1b[36m[SYSTEM]\x1b[0m npm install command sent to terminal...\r\n`
                        }));
                    }
                    
                    // Clear any existing timeout when sending new command
                    if (session.commandTimeout) {
                        clearTimeout(session.commandTimeout);
                        session.commandTimeout = null;
                    }
                    
                    // Set timeout for long-running commands
                    if (input.trim().startsWith('npm install') || input.trim().startsWith('npm i')) {
                        session.commandTimeout = setTimeout(() => {
                            console.log('⚠️ npm install timeout, sending interrupt signal');
                            session.ptyProcess.write('\x03'); // Send Ctrl+C
                            session.commandTimeout = null;
                        }, 120000); // 2 minutes for npm install
                    } else if (input.trim().startsWith('npm') || input.trim().startsWith('node') || input.trim().startsWith('python')) {
                        session.commandTimeout = setTimeout(() => {
                            console.log('⚠️ Command timeout, sending interrupt signal');
                            session.ptyProcess.write('\x03'); // Send Ctrl+C
                            session.commandTimeout = null;
                        }, 30000); // 30 seconds for other commands
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Terminal not ready' }));
                }
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            }
        } catch (error) {
            console.error('❌ Error in handleInput:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Input failed' }));
        }
    }
    
    ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
        if (currentSessionId && sessions.has(currentSessionId)) {
            const session = sessions.get(currentSessionId);
            if (session.ptyProcess) {
                session.ptyProcess.kill();
            }
            // ✅ ADDED: Cleanup sync interval
            if (session.syncInterval) {
                clearInterval(session.syncInterval);
                console.log('🔄 Sync interval cleared for session:', currentSessionId);
            }
            sessions.delete(currentSessionId);
        }
    });
});

// -------------------------
// File System Utilities
// -------------------------

// ✅ ADDED: Scan directory for files and return them in batch save format
async function scanDirectoryForFiles(rootDir, currentDir) {
    const files = [];
    
    try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
            
            // Skip hidden files and common ignore patterns
            if (entry.name.startsWith('.') || 
                entry.name === '.git' ||
                entry.name === '.npm-cache' ||
                entry.name === '.npm-global') {
                continue;
            }
            
            if (entry.isDirectory()) {
                // Recursively scan subdirectories
                const subFiles = await scanDirectoryForFiles(rootDir, fullPath);
                files.push(...subFiles);
            } else if (entry.isFile()) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    files.push({
                        filename: relativePath,
                        content: content
                    });
                } catch (readError) {
                    console.error(`⚠️ Error reading file ${relativePath}:`, readError);
                }
            }
        }
    } catch (error) {
        console.error(`⚠️ Error scanning directory ${currentDir}:`, error);
    }
    
    return files;
}

// -------------------------
// Comprehensive Command Analysis & Execution System
// -------------------------

/**
 * Analyzes command behavior and ensures proper file synchronization
 * This replaces the simple precheck with a comprehensive system
 */
async function analyzeAndExecuteCommand({ raw, sessionId, sessionWorkspaceDir, currentCwdAbs }) {
    try {
        const tokens = raw.trim().split(/\s+/);
        if (tokens.length === 0) return { ok: true, action: 'execute' };
        
        const executable = tokens[0].toLowerCase();
        const args = tokens.slice(1);
        
        // Simple commands that don't need any analysis - execute directly
        const simpleCommands = [
            'ls', 'dir', 'pwd', 'cd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'cat', 'echo', 'clear', 'whoami',
            'date', 'time', 'ps', 'top', 'kill', 'killall', 'jobs', 'bg', 'fg', 'history', 'alias',
            'which', 'where', 'type', 'help', 'man', 'info', 'apropos', 'whatis', 'locate', 'find',
            'grep', 'awk', 'sed', 'sort', 'uniq', 'wc', 'head', 'tail', 'less', 'more', 'touch',
            'chmod', 'chown', 'ln', 'df', 'du', 'free', 'uptime', 'uname', 'env', 'export', 'set',
            'unset', 'source', '.', 'exit', 'logout', 'su', 'sudo', 'passwd', 'id', 'groups',
            'w', 'who', 'last', 'finger', 'ping', 'traceroute', 'netstat', 'ss', 'lsof', 'curl',
            'wget', 'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2',
            'xz', '7z', 'rar', 'unrar', 'mount', 'umount', 'fdisk', 'parted', 'mkfs', 'fsck'
        ];
        
        // If it's a simple command, execute directly without analysis
        if (simpleCommands.includes(executable)) {
            return { ok: true, action: 'execute' };
        }
        
        // Only log analysis for complex commands that need it
        const needsAnalysis = ['npm', 'node', 'npx', 'git', 'python', 'pip', 'go', 'cargo', 'java', 'javac', 'gcc', 'g++'];
        if (needsAnalysis.includes(executable)) {
            console.log('🔍 COMMAND ANALYSIS:', {
                command: raw,
                executable,
                args,
                sessionId: sessionId.substring(0, 8) + '...',
                currentCwd: currentCwdAbs
            });
        }

        // Step 1: Ensure all files are synced to workspace before command execution
        await ensureFilesSynced(sessionId, sessionWorkspaceDir);
        
        // Step 2: Analyze command requirements
        const analysis = await analyzeCommandRequirements(executable, args, sessionId, sessionWorkspaceDir, currentCwdAbs);
        
        // Step 3: Handle command-specific logic
        if (analysis.action === 'block') {
            return { ok: false, message: analysis.message };
        } else if (analysis.action === 'redirect') {
            return { ok: true, action: 'redirect', newCwd: analysis.newCwd, message: analysis.message };
        } else if (analysis.action === 'prepare') {
            // Prepare environment for command (e.g., create missing files)
            await prepareCommandEnvironment(analysis);
        }
        
        return { ok: true, action: 'execute' };
        
    } catch (error) {
        console.error('❌ Command analysis error:', error);
        return { ok: true, action: 'execute' }; // Allow command to proceed on analysis error
    }
}

/**
 * Ensures all database files are synced to session workspace
 */
async function ensureFilesSynced(sessionId, sessionWorkspaceDir) {
    try {
        const dbFiles = await listFilesBySession(sessionId);
        
        for (const fileRow of dbFiles) {
            const filePath = path.join(sessionWorkspaceDir, fileRow.filename);
            const dirPath = path.dirname(filePath);
            
            // Check if file exists and is up to date
            if (!fs.existsSync(filePath)) {
                // File doesn't exist in workspace, sync it
                const content = await readFileByName({ sessionId, filename: fileRow.filename });
                if (content) {
                    // Ensure directory exists
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }
                    // Write file to workspace
                    fs.writeFileSync(filePath, content);
                    console.log(`📄 Synced file to workspace: ${fileRow.filename}`);
                }
            }
        }
    } catch (error) {
        console.error('⚠️ Error syncing files:', error);
    }
}

/**
 * Analyzes command requirements and determines action needed
 */
async function analyzeCommandRequirements(executable, args, sessionId, sessionWorkspaceDir, currentCwdAbs) {
    const dbFiles = await listFilesBySession(sessionId);
    const fileSet = new Set(dbFiles.map(r => String(r.filename)));
    
    // Helper functions
    const resolvePath = (argPath) => {
        if (!argPath) return null;
        const abs = path.isAbsolute(argPath) ? argPath : path.resolve(currentCwdAbs, argPath);
        if (!abs.startsWith(sessionWorkspaceDir)) return null;
        return path.relative(sessionWorkspaceDir, abs).replace(/\\/g, '/');
    };
    
    const fileExists = (relPath) => relPath && fileSet.has(relPath);
    const fileExistsInWorkspace = (relPath) => {
        if (!relPath) return false;
        const fullPath = path.join(sessionWorkspaceDir, relPath);
        return fs.existsSync(fullPath);
    };
    
    // Detect project structure
    const projectRoot = detectProjectRoot(dbFiles, currentCwdAbs, sessionWorkspaceDir);
    
    // Command-specific analysis
    switch (executable) {
        case 'npm':
        case 'pnpm':
        case 'yarn':
            return analyzeNodeCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot);
            
        case 'node':
            return analyzeNodeExecution(args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'npx':
            return analyzeNpxCommand(args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot);
            
        case 'python':
        case 'python3':
        case 'py':
            return analyzePythonCommand(args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'pip':
        case 'pip3':
            return analyzePipCommand(args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'git':
            return analyzeGitCommand(args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot);
            
        case 'go':
            return analyzeGoCommand(args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'cargo':
            return analyzeCargoCommand(args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'javac':
        case 'java':
            return analyzeJavaCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace);
            
        case 'gcc':
        case 'g++':
            return analyzeCppCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace);
            
        default:
            // Generic analysis for unknown commands
            return analyzeGenericCommand(args, resolvePath, sessionWorkspaceDir);
    }
}

/**
 * Detects the project root directory based on file structure
 */
function detectProjectRoot(dbFiles, currentCwdAbs, sessionWorkspaceDir) {
    const fileSet = new Set(dbFiles.map(r => String(r.filename)));
    
    // Check for common project indicators
    const projectIndicators = [
        'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'requirements.txt', 'Pipfile', 'pyproject.toml',
        'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
        '.git', 'README.md', 'Makefile'
    ];
    
    // Find directories containing project indicators
    const projectDirs = new Set();
    for (const indicator of projectIndicators) {
        if (fileSet.has(indicator)) {
            projectDirs.add(''); // Root directory
        }
        for (const filename of fileSet) {
            if (filename.endsWith(`/${indicator}`)) {
                const dir = path.dirname(filename);
                if (dir !== '.') projectDirs.add(dir);
            }
        }
    }
    
    // If only one project directory found, suggest it
    if (projectDirs.size === 1) {
        const projectDir = Array.from(projectDirs)[0];
        if (projectDir && projectDir !== '') {
            return projectDir;
        }
    }
    
    return null;
}

/**
 * Analyzes Node.js package manager commands
 */
function analyzeNodeCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot) {
    // Commands that don't require package.json
    const noPackageJsonCommands = [
        '--version', '-v', 'version',
        '--help', '-h', 'help',
        'config', 'cache', 'doctor',
        'ping', 'whoami', 'logout', 'login',
        'search', 'view', 'info', 'show',
        'outdated', 'audit', 'fund'
    ];
    
    // If it's a command that doesn't need package.json, execute directly
    if (args.length > 0 && noPackageJsonCommands.includes(args[0])) {
        return { action: 'execute' };
    }
    
    const packageJsonPath = resolvePath('package.json');
    
    if (!fileExists(packageJsonPath)) {
        if (projectRoot && fileExists(`${projectRoot}/package.json`)) {
            return {
                action: 'redirect',
                newCwd: projectRoot,
                message: `package.json not found in current directory. Switching to ${projectRoot}/ where package.json exists.`
            };
        }
        
        // For install commands, allow them to create package.json or install without it
        if (['install', 'i', 'add', 'remove', 'uninstall', 'init'].includes(args[0])) {
            return { action: 'execute' };
        }
        
        return {
            action: 'block',
            message: `package.json not found. ${executable} commands require a package.json file.`
        };
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes Node.js execution commands
 */
function analyzeNodeExecution(args, resolvePath, fileExists, fileExistsInWorkspace) {
    // Node commands that don't require a file
    const noFileCommands = [
        '--version', '-v', 'version',
        '--help', '-h', 'help',
        '--eval', '-e', '--print', '-p'
    ];
    
    // If it's a command that doesn't need a file, execute directly
    if (args.length > 0 && noFileCommands.includes(args[0])) {
        return { action: 'execute' };
    }
    
    if (args.length < 1) return { action: 'execute' };
    
    const scriptPath = resolvePath(args[0]);
    if (scriptPath && !fileExists(scriptPath)) {
        return {
            action: 'block',
            message: `File not found: ${args[0]}. Make sure the file exists in your workspace.`
        };
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes npx commands
 */
function analyzeNpxCommand(args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot) {
    // npx commands that don't require package.json
    const noPackageJsonCommands = [
        '--version', '-v', 'version',
        '--help', '-h', 'help',
        'create', 'degit', 'dlx'
    ];
    
    // If it's a command that doesn't need package.json, execute directly
    if (args.length > 0 && noPackageJsonCommands.includes(args[0])) {
            return { action: 'execute' };
        }
        
    // For other npx commands, just execute (npx handles its own requirements)
    return { action: 'execute' };
}

/**
 * Analyzes Python commands
 */
function analyzePythonCommand(args, resolvePath, fileExists, fileExistsInWorkspace) {
    if (args.length < 1) return { action: 'execute' };
    
    // Find the first non-flag argument (the script to run)
    const scriptArg = args.find(arg => !arg.startsWith('-'));
    if (scriptArg) {
        const scriptPath = resolvePath(scriptArg);
        if (scriptPath && !fileExists(scriptPath)) {
            return {
                action: 'block',
                message: `Python script not found: ${scriptArg}. Make sure the file exists in your workspace.`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes pip commands
 */
function analyzePipCommand(args, resolvePath, fileExists, fileExistsInWorkspace) {
    // Check for requirements file
    const reqIndex = args.findIndex(arg => arg === '-r' || arg === '--requirement');
    if (reqIndex >= 0 && args[reqIndex + 1]) {
        const reqPath = resolvePath(args[reqIndex + 1]);
        if (reqPath && !fileExists(reqPath)) {
            return {
                action: 'block',
                message: `Requirements file not found: ${args[reqIndex + 1]}.`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes Git commands
 */
function analyzeGitCommand(args, resolvePath, fileExists, fileExistsInWorkspace, projectRoot) {
    // Git commands that don't require a repository
    const noRepoCommands = [
        '--version', '-v', 'version',
        '--help', '-h', 'help',
        'config', 'init', 'clone'
    ];
    
    // If it's a command that doesn't need a repo, execute directly
    if (args.length > 0 && noRepoCommands.includes(args[0])) {
        return { action: 'execute' };
    }
    
    // For other git commands, just execute (let git handle its own error messages)
    return { action: 'execute' };
}

/**
 * Analyzes Go commands
 */
function analyzeGoCommand(args, resolvePath, fileExists, fileExistsInWorkspace) {
    if (args[0] === 'run' && args[1]) {
        const goFile = resolvePath(args[1]);
        if (goFile && !fileExists(goFile)) {
            return {
                action: 'block',
                message: `Go file not found: ${args[1]}.`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes Cargo commands
 */
function analyzeCargoCommand(args, resolvePath, fileExists, fileExistsInWorkspace) {
    const cargoTomlPath = resolvePath('Cargo.toml');
    if (!fileExists(cargoTomlPath)) {
        return {
            action: 'block',
            message: 'Cargo.toml not found. Cargo commands require a Rust project.'
        };
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes Java commands
 */
function analyzeJavaCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace) {
    const javaFile = args.find(arg => arg.endsWith('.java'));
    if (javaFile) {
        const javaPath = resolvePath(javaFile);
        if (javaPath && !fileExists(javaPath)) {
            return {
                action: 'block',
                message: `Java file not found: ${javaFile}.`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes C/C++ commands
 */
function analyzeCppCommand(executable, args, resolvePath, fileExists, fileExistsInWorkspace) {
    const sourceFile = args.find(arg => /\.(c|cc|cpp|cxx|h|hpp)$/i.test(arg));
    if (sourceFile) {
        const sourcePath = resolvePath(sourceFile);
        if (sourcePath && !fileExists(sourcePath)) {
            return {
                action: 'block',
                message: `Source file not found: ${sourceFile}.`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Analyzes generic commands
 */
function analyzeGenericCommand(args, resolvePath, sessionWorkspaceDir) {
    // For generic commands, just check if any path arguments are outside workspace
    const pathArgs = args.filter(arg => /[\\/]/.test(arg) && !arg.startsWith('-'));
    
    for (const pathArg of pathArgs) {
        const resolved = resolvePath(pathArg);
        if (resolved === null) {
            return {
                action: 'block',
                message: `Access denied: Path is outside your workspace: ${pathArg}`
            };
        }
    }
    
    return { action: 'execute' };
}

/**
 * Prepares environment for command execution
 */
async function prepareCommandEnvironment(analysis) {
    // This can be extended to create missing files, set up environment variables, etc.
    console.log('🔧 Preparing command environment:', analysis);
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    shutdown();
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully...');
    shutdown();
});

function shutdown() {
    // Kill all PTY processes
    for (const [sessionId, session] of sessions.entries()) {
        if (session.ptyProcess) {
            session.ptyProcess.kill();
        }
        if (session.ws) {
            session.ws.close();
        }
    }
    
    // Close WebSocket server
    wss.close(() => {
        console.log('🔌 WebSocket server closed');
        
        // Close HTTP server
        server.close(() => {
            console.log('🌐 HTTP server closed');
            process.exit(0);
        });
    });
}

// Auto-sync files from DB to session workspace every 10 seconds
setInterval(async () => {
    try {
        for (const [sessionId, session] of sessions.entries()) {
            if (session.ptyReady && session.currentCwd) {
                // Use the session's stored workspace path
                const sessionWorkspaceDir = session.workspacePath ? path.resolve(session.workspacePath).replace(/\\/g, '/') : session.currentCwd;
                
                // Get all files from database for this session
                const dbFiles = await listFilesBySession(sessionId);
                
                // Sync each file to the session workspace
                for (const fileRow of dbFiles) {
                    try {
                        const content = await readFileByName({ sessionId, filename: fileRow.filename });
                        if (content) {
                            const filePath = path.join(sessionWorkspaceDir, fileRow.filename);
                            const dirPath = path.dirname(filePath);
                            
                            // Ensure directory exists
                            if (!fs.existsSync(dirPath)) {
                                fs.mkdirSync(dirPath, { recursive: true });
                            }
                            
                            // Write file to session workspace
                            fs.writeFileSync(filePath, content);
                        }
                    } catch (error) {
                        console.error(`⚠️ Error syncing file ${fileRow.filename} for session ${sessionId}:`, error);
                    }
                }
            }
        }
    } catch (error) {
        console.error('⚠️ Error in auto-sync:', error);
    }
}, 10000); // Every 10 seconds

// Batch create folders endpoint
app.post('/folders/batch-create', async (req, res) => {
    try {
        const { folders } = req.body;
        const sessionId = req.headers['x-session-id'];
        const terminalToken = req.headers['x-terminal-token'];
        
        if (!folders || !Array.isArray(folders)) {
            return res.status(400).json({ error: 'Folders array is required' });
        }
        
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        
        if (!terminalToken) {
            return res.status(401).json({ error: 'Terminal token required' });
        }
        
        const verified = await verifyTerminalSession(String(sessionId), String(terminalToken));
        if (!verified) {
            return res.status(401).json({ error: 'Invalid session or token' });
        }

        console.log(`📁 Batch creating ${folders.length} folders...`);
        
        // Filter out empty folders and sort by depth to create parents first
        const validFolders = folders.filter(f => f && f.trim() && f !== '');
        const sortedFolders = validFolders.sort((a, b) => {
            const aDepth = a.split('/').length;
            const bDepth = b.split('/').length;
            return aDepth - bDepth;
        });

        const createdFolders = [];
        const errors = [];

        for (const folderPath of sortedFolders) {
            try {
                // Create folder in session workspace using correct path
                const sessionWorkspaceDir = path.resolve(verified.workspace_path).replace(/\\/g, '/');
                const fullPath = path.join(sessionWorkspaceDir, folderPath);
                await fs.promises.mkdir(fullPath, { recursive: true });

                // Save to database (ignore if already exists)
                try {
                    await saveFile({ sessionId, filename: folderPath, content: '' });
                    createdFolders.push(folderPath);
                } catch (dbError) {
                    // Folder might already exist in DB, that's okay
                    createdFolders.push(folderPath);
                }
            } catch (error) {
                console.error(`Error creating folder ${folderPath}:`, error);
                errors.push({ folder: folderPath, error: error.message });
            }
        }

        console.log(`✅ Created ${createdFolders.length} folders successfully`);
        
        res.json({ 
            success: true, 
            message: `Created ${createdFolders.length} folders`,
            created: createdFolders,
            errors: errors
        });
    } catch (error) {
        console.error('Error batch creating folders:', error);
        res.status(500).json({ error: 'Failed to batch create folders' });
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready`);
    console.log(`🗄️ MySQL database integration active`);
    console.log(`🔄 Auto-sync enabled (10s interval)`);
});
