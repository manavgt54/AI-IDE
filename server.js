import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { ENV_CONFIG, getPort, getWorkspaceDir, isDevelopment, isProduction } from './src/config/env.js';
import { initSchema, upsertUserAndCreateSession, getUserSessionByGoogleAccount, readFileByName, saveFile, listFilesBySession, deleteSession, getPool, deleteFileByName, getSessionInfo } from './src/db/mysql.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global variables for multiple user sessions - each session is a container
let sessions = new Map(); // sessionId -> { ws, ptyProcess, userId, currentCwd, ptyReady, containerId }
let pty = null;
let mockPty = null;

// Environment variables from config
const PORT = getPort();
const WORKSPACE_DIR = getWorkspaceDir();

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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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

// Initialize DB schema
initSchema().then(() => console.log('🗄️ MySQL schema ready')).catch(e => console.error('MySQL init failed', e));

// Minimal Google auth endpoint: expects { googleId, email }
app.post('/auth/google', async (req, res) => {
    try {
        console.log('🔐 Google auth request received:', req.body);
        const { googleId, email } = req.body || {};
        if (!googleId && !email) {
            console.log('❌ Missing googleId or email');
            return res.status(400).json({ error: 'googleId or email required' });
        }
        console.log('📝 Creating user and session for:', { googleId, email });
        
        const { userId, sessionId } = await upsertUserAndCreateSession({ googleId, email });
        console.log('✅ User and session created:', { userId, sessionId });
        return res.json({ ok: true, userId, sessionId });
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
            return res.json({ ok: true, userId: existingSession.userId, sessionId: existingSession.sessionId });
        } else {
            // Create new permanent session if none exists
            console.log('🆕 Creating new permanent session for user');
            const result = await upsertUserAndCreateSession({ googleId, email });
            return res.json({ ok: true, userId: result.userId, sessionId: result.sessionId });
        }
    } catch (e) {
        console.error('❌ /auth/session error:', e);
        return res.status(500).json({ error: 'auth_session_failed', details: e.message });
    }
});

// Validate an existing sessionId, and if it's missing in memory allow backend to recreate in-memory state
app.post('/auth/session/validate', async (req, res) => {
    try {
        const { sessionId, googleId, email } = req.body || {};
        if (!sessionId && !googleId && !email) {
            return res.status(400).json({ error: 'sessionId or google identity required' });
        }

        // 1) If sessionId provided, check it exists in DB
        if (sessionId) {
            const info = await getSessionInfo(sessionId);
            if (info) {
                return res.json({ ok: true, sessionId: info.session_id, userId: info.user_id });
            }
        }

        // 2) Fallback by Google identity to recover the user's permanent session
        if (googleId || email) {
            const existing = await getUserSessionByGoogleAccount({ googleId, email });
            if (existing) {
                return res.json({ ok: true, sessionId: existing.sessionId, userId: existing.userId });
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
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }
        
        // Get files from MySQL database for this session
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
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
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
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        
        await saveFile({ sessionId, filename, content });
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

// Upload multiple files (DB-only), preserving provided relative paths
app.post('/files/upload', upload.array('files'), async (req, res) => {
    try {
        const sessionId = req.headers['x-session-id'];
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
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
            await saveFile({ sessionId, filename: relPath, content: file.buffer });
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
        if (!folderPath || !sessionId) {
            return res.status(400).json({ error: 'folderPath and sessionId required' });
        }
        const files = await listFilesBySession(sessionId);
        const toDelete = files.filter(f => f.filename.startsWith(folderPath + '/'));
        for (const f of toDelete) {
            await deleteFileByName({ sessionId, filename: f.filename });
        }
        // Remove placeholder if present
        await deleteFileByName({ sessionId, filename: path.join(folderPath, '.folder') });
        // Remove on disk
        const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
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
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        
        await deleteFileByName({ sessionId, filename });
        // Also remove from session workspace
        try {
            const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
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

// Create WebSocket server
const wss = new WebSocketServer({ server });

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket connection established');
    
    let currentSessionId = null;
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received message:', data.type);
            
            switch (data.type) {
                case 'init':
                    await handleInit(ws, data);
                    break;
                case 'reconnect':
                    await handleReconnect(ws, data);
                    break;
                case 'input':
                    await handleInput(ws, data);
                    break;
                default:
                    console.log('❌ Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('❌ Error handling WebSocket message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
        if (currentSessionId && sessions.has(currentSessionId)) {
            const session = sessions.get(currentSessionId);
            if (session.ptyProcess) {
                session.ptyProcess.kill();
            }
            sessions.delete(currentSessionId);
        }
    });
    
    async function handleInit(ws, data) {
        try {
            const { sessionId } = data;
            if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
                return;
            }
            
            currentSessionId = sessionId;
            console.log('🔧 Initializing session:', sessionId);
            
            // Create session-specific workspace directory
            const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
            if (!fs.existsSync(sessionWorkspaceDir)) {
                fs.mkdirSync(sessionWorkspaceDir, { recursive: true });
                console.log('📁 Created session workspace:', sessionWorkspaceDir);
            }
            
            // Create new session
            const session = {
                ws,
                ptyProcess: null,
                userId: null,
                currentCwd: sessionWorkspaceDir,
                ptyReady: false,
                containerId: null
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
                    PATH: '/usr/local/bin:/usr/bin:/bin',
                    TERM: 'xterm-color'
                };
                
                session.ptyProcess = spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
                    name: 'xterm-color',
                    cols: 80,
                    rows: 30,
                    cwd: sessionWorkspaceDir,
                    env: restrictedEnv
                });
                
                // Override cd command to prevent access to parent directories
                session.ptyProcess.write('cd "' + sessionWorkspaceDir + '"\n');
                session.ptyProcess.write('export PWD="' + sessionWorkspaceDir + '"\n');
                session.ptyProcess.write('export HOME="' + sessionWorkspaceDir + '"\n');
                session.ptyProcess.write('function cd() { if [[ "$1" == "/"* ]] && [[ "$1" != "' + sessionWorkspaceDir + '"* ]]; then echo "Access denied: Cannot access system directories"; return 1; fi; builtin cd "$@"; }\n');
                session.ptyProcess.write('export -f cd\n');
                
                session.ptyProcess.onData((data) => {
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
            const { sessionId } = data;
            if (!sessionId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
                return;
            }
            
            currentSessionId = sessionId;
            console.log('🔧 Reconnecting to session:', sessionId);
            
            if (sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                session.ws = ws;
                
                if (session.ptyReady) {
                    ws.send(JSON.stringify({ type: 'pty-ready', sessionId: sessionId, message: 'Terminal ready' }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Session not ready' }));
                }
            } else {
                // Session doesn't exist in memory, but exists in database
                // Create a new session in memory for this sessionId
                console.log('🆕 Creating new session in memory for existing sessionId:', sessionId);
                await handleInit(ws, { sessionId });
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
                        const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
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

                        // Generalized pre-checks for common developer tools and file-based commands
                        const precheckResult = await precheckCommand({
                            raw: trimmed,
                            sessionId,
                            sessionWorkspaceDir,
                            currentCwdAbs: session.currentCwd
                        });
                        if (!precheckResult.ok) {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[33m[PRECHECK]\x1b[0m ${precheckResult.message}\r\n`
                            }));
                            return;
                        }
                        // Optional auto-cd suggested by precheck
                        if (precheckResult.autoCd && typeof precheckResult.autoCd === 'string') {
                            const targetAbs = path.resolve(sessionWorkspaceDir, precheckResult.autoCd);
                            if (targetAbs.startsWith(sessionWorkspaceDir) && fs.existsSync(targetAbs)) {
                                session.currentCwd = targetAbs;
                                session.ptyProcess.write('cd "' + targetAbs + '"\n');
                                ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[36m[AUTO]\x1b[0m switched directory to ${precheckResult.autoCd}\r\n` }));
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
                    
                    session.ptyProcess.write(input);
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
});

// -------------------------
// Command precheck utilities
// -------------------------
async function precheckCommand({ raw, sessionId, sessionWorkspaceDir, currentCwdAbs }) {
    try {
        const tokens = raw.split(/\s+/);
        if (tokens.length === 0) return { ok: true };
        const executable = tokens[0].toLowerCase();
        const args = tokens.slice(1);

        // Load file list for this session once
        let fileRows = [];
        try { fileRows = await listFilesBySession(sessionId); } catch {}
        const dbFiles = new Set((fileRows || []).map(r => String(r.filename)));
        // Detect single top-level directory
        const topLevelSet = new Set();
        let hasRootFiles = false;
        for (const row of fileRows || []) {
            const parts = String(row.filename).split('/').filter(Boolean);
            if (parts.length === 1) hasRootFiles = true;
            if (parts[0]) topLevelSet.add(parts[0]);
        }
        const singleTop = !hasRootFiles && topLevelSet.size === 1 ? Array.from(topLevelSet)[0] : null;

        const toRelFromCwd = (argPath) => {
            if (!argPath) return null;
            const abs = path.isAbsolute(argPath) ? argPath : path.resolve(currentCwdAbs, argPath);
            if (!abs.startsWith(sessionWorkspaceDir)) return null;
            const rel = path.relative(sessionWorkspaceDir, abs).replace(/\\/g, '/');
            return rel;
        };

        const existsRel = (relPath) => relPath && dbFiles.has(relPath);

        // Define generic rules
        const rules = [
            // npm/pnpm/yarn
            {
                match: (exe) => ['npm', 'pnpm', 'yarn'].includes(exe),
                check: () => {
                    const rel = toRelFromCwd('package.json');
                    if (!existsRel(rel)) {
                        // try single-top suggestion
                        if (singleTop && dbFiles.has(`${singleTop}/package.json`)) {
                            return { suggestCwd: singleTop, msg: `package.json not found here. Switching to ${singleTop}/ as project root.` };
                        }
                        return `Expected package.json in current directory for ${executable} commands.`;
                    }
                    return null;
                }
            },
            // node <file>
            {
                match: (exe) => exe === 'node',
                check: () => {
                    if (args.length < 1) return null;
                    const target = toRelFromCwd(args[0]);
                    if (target && !existsRel(target)) return `File not found: ${args[0]} (expected in workspace).`;
                    return null;
                }
            },
            // npx <tool> (usually requires package.json but allow globally too)
            {
                match: (exe) => exe === 'npx',
                check: () => {
                    const rel = toRelFromCwd('package.json');
                    if (!existsRel(rel)) return null; // soft requirement
                    return null;
                }
            },
            // python script.py
            {
                match: (exe) => ['python', 'python3', 'py'].includes(exe),
                check: () => {
                    if (args.length < 1) return null;
                    // Skip flags-only invocations
                    const firstArg = args.find(a => !a.startsWith('-'));
                    if (!firstArg) return null;
                    const target = toRelFromCwd(firstArg);
                    if (target && !existsRel(target)) return `File not found: ${firstArg} (expected in workspace).`;
                    return null;
                }
            },
            // pip install -r requirements.txt
            {
                match: (exe) => ['pip', 'pip3'].includes(exe),
                check: () => {
                    const idx = args.findIndex(a => a === '-r' || a === '--requirement');
                    if (idx >= 0 && args[idx + 1]) {
                        const reqRel = toRelFromCwd(args[idx + 1]);
                        if (reqRel && !existsRel(reqRel)) return `Requirements file not found: ${args[idx + 1]}.`;
                    }
                    return null;
                }
            },
            // go run <file.go>
            {
                match: (exe) => exe === 'go',
                check: () => {
                    if (args[0] === 'run' && args[1]) {
                        const target = toRelFromCwd(args[1]);
                        if (target && !existsRel(target)) return `File not found: ${args[1]}.`;
                    }
                    return null;
                }
            },
            // cargo build/run -> Cargo.toml
            {
                match: (exe) => exe === 'cargo',
                check: () => {
                    const rel = toRelFromCwd('Cargo.toml');
                    if (!existsRel(rel)) return `Expected Cargo.toml in current directory for cargo commands.`;
                    return null;
                }
            },
            // javac/java <file>
            {
                match: (exe) => exe === 'javac' || exe === 'java',
                check: () => {
                    const arg = args.find(a => /\.java$/i.test(a));
                    if (arg) {
                        const target = toRelFromCwd(arg);
                        if (target && !existsRel(target)) return `File not found: ${arg}.`;
                    }
                    return null;
                }
            },
            // gcc/g++ <file>
            {
                match: (exe) => exe === 'gcc' || exe === 'g++',
                check: () => {
                    const src = args.find(a => /\.(c|cc|cpp|cxx|h|hpp)$/i.test(a));
                    if (src) {
                        const target = toRelFromCwd(src);
                        if (target && !existsRel(target)) return `Source file not found: ${src}.`;
                    }
                    return null;
                }
            }
        ];

        for (const rule of rules) {
            if (rule.match(executable)) {
                const res = rule.check();
                if (typeof res === 'string' && res) return { ok: false, message: res };
                if (res && typeof res === 'object' && res.suggestCwd) {
                    return { ok: true, autoCd: res.suggestCwd };
                }
            }
        }

        // Generic safety: if command includes a path argument, ensure it's inside workspace
        const pathArg = args.find(a => /[\\/]/.test(a) && !a.startsWith('-'));
        if (pathArg) {
            const rel = toRelFromCwd(pathArg);
            if (rel === null) {
                return { ok: false, message: `Access denied: Path is outside your workspace: ${pathArg}` };
            }
        }

        return { ok: true };
    } catch (e) {
        // On error, do not block the command
        return { ok: true };
    }
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

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready`);
    console.log(`🗄️ MySQL database integration active`);
});
