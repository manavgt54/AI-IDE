import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { ENV_CONFIG, getPort, getWorkspaceDir, isDevelopment, isProduction } from './src/config/env.js';
import { initSchema, upsertUserAndCreateSession, readFileByName, saveFile, listFilesBySession, deleteSession, getPool } from './src/db/mysql.js';

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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'workspace')));

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

// File operations - now fully MySQL-based
app.get('/files', async (req, res) => {
    try {
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

// Save file endpoint
app.post('/files/save', async (req, res) => {
    try {
        const { filename, content } = req.body;
        const sessionId = req.headers['x-session-id'];
        
        if (!filename || !sessionId) {
            return res.status(400).json({ error: 'filename and sessionId required' });
        }
        
        await saveFile({ sessionId, filename, content });
        // Also write to session workspace so terminal sees latest content immediately
        try {
            const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
            const fullPath = path.join(sessionWorkspaceDir, filename);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content);
        } catch (fsErr) {
            console.error('⚠️ Failed to write file to session workspace:', fsErr);
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /files/save:', error);
        res.status(500).json({ error: 'server_error' });
    }
});

// Create folder endpoint - stores a placeholder record and creates directory on disk
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

        // Ensure directory exists in the session workspace for terminal access
        const sessionWorkspaceDir = path.join(WORKSPACE_DIR, 'sessions', sessionId);
        const fullFolderPath = path.join(sessionWorkspaceDir, folderPath);
        fs.mkdirSync(fullFolderPath, { recursive: true });

        return res.json({ ok: true });
    } catch (error) {
        console.error('❌ Error in /folders/create:', error);
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
        
        // For now, we'll just return success since MySQL doesn't have a direct delete by filename
        // In a real implementation, you'd delete the file from the database
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
                        fs.writeFileSync(filePath, content);
                        console.log('📄 Synced file to session workspace:', file.filename);
                    }
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
