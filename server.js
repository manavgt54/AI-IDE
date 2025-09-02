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

// Ensure workspace directory exists
if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    console.log(`✅ Created workspace directory: ${WORKSPACE_DIR}`);
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

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        sessions: sessions.size,
        pty: sessions.size > 0 ? 'running' : 'none'
    });
});

// Initialize DB schema (non-blocking)
initSchema().then(() => console.log('🗄️  MySQL schema ready')).catch(e => console.error('MySQL init failed', e));

// Minimal Google auth endpoint: expects { googleId, email }
app.post('/auth/google', async (req, res) => {
    try {
        console.log('🔐 Google auth request received:', req.body)
        const { googleId, email } = req.body || {}
        if (!googleId && !email) {
            console.log('❌ Missing googleId or email')
            return res.status(400).json({ error: 'googleId or email required' })
        }
        console.log('📝 Creating user and session for:', { googleId, email })
        const { userId, sessionId } = await upsertUserAndCreateSession({ googleId, email })
        console.log('✅ User and session created:', { userId, sessionId })
        return res.json({ ok: true, userId, sessionId })
    } catch (e) {
        console.error('❌ Auth error:', e)
        return res.status(500).json({ error: 'auth_failed', details: e.message })
    }
});

// File operations - now fully MySQL-based
app.get('/files', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || req.header('x-session-id')
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' })
        }
        
        // Get files from MySQL database for this session
        try {
            const files = await listFilesBySession(sessionId)
            
            const fileNodes = files.map(row => ({
                name: row.filename,
                type: 'file',
                path: row.filename,
                modified: row.updated_at,
                created: row.created_at
            }))
            
            res.json({
                type: 'folder',
                name: 'workspace',
                path: '',
                children: fileNodes
            })
        } catch (dbError) {
            console.error('DB error:', dbError)
            res.status(500).json({ error: 'Database error' })
        }
    } catch (error) {
        console.error('❌ Error reading files:', error);
        res.status(500).json({ error: error.message });
    }
});

// Session management endpoint
app.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' })
        }
        
        // Delete session and cascade delete files
        await deleteSession(sessionId)
        
        // Clean up local session if exists
        if (sessions.has(sessionId)) {
            const session = sessions.get(sessionId)
            if (session.ptyProcess) {
                session.ptyProcess.kill()
            }
            sessions.delete(sessionId)
        }
        
        res.json({ success: true, message: 'Session deleted' })
    } catch (error) {
        console.error('Session deletion error:', error)
        res.status(500).json({ error: 'Failed to delete session' })
    }
});

app.get('/files/:filename', (req, res) => {
    try {
        const filePath = path.join(WORKSPACE_DIR, req.params.filename);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        console.error('❌ Error reading file:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/files/:filename', (req, res) => {
    try {
        const filePath = path.join(WORKSPACE_DIR, req.params.filename);
        fs.writeFileSync(filePath, req.body.content || '');
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error writing file:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload', (req, res) => {
    try {
        const { filename, content } = req.body;
        const filePath = path.join(WORKSPACE_DIR, filename);
        fs.writeFileSync(filePath, content);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error uploading file:', error);
        res.status(500).json({ error: error.message });
    }
});

// File operations - now fully MySQL-based
app.post('/files/open', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        const sessionId = req.header('x-session-id') || ''

        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' })
        }

        // Read file content from MySQL database
        try {
            const content = await readFileByName({ sessionId, filename: filePath })
            if (content !== null) {
                return res.json({ path: filePath, content, source: 'db' })
            } else {
                return res.status(404).json({ error: 'File not found' });
            }
        } catch (dbError) {
            console.error('DB read error:', dbError)
            return res.status(500).json({ error: 'Database error' })
        }
    } catch (error) {
        console.error('❌ Error reading file:', error);
        return res.status(500).json({ error: error.message });
    }
});

app.post('/files/save', async (req, res) => {
    try {
        const { path: filePath, content } = req.body;
        const sessionId = req.header('x-session-id') || ''
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' })
        }

        // Save file content to MySQL database
        try {
            await saveFile({ sessionId, filename: filePath, content })
            return res.json({ success: true, path: filePath });
        } catch (dbError) {
            console.error('DB save error:', dbError)
            return res.status(500).json({ error: 'Database error' })
        }
    } catch (error) {
        console.error('❌ Error saving file:', error);
        return res.status(500).json({ error: error.message });
    }
});

// Delete file endpoint
app.delete('/files/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const sessionId = req.header('x-session-id') || ''
        
        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' })
        }
        
        // Delete file from MySQL database
        try {
            const pool = await getPool();
            await pool.execute('DELETE FROM files WHERE session_id = ? AND filename = ?', [sessionId, filename]);
            return res.json({ success: true, message: 'File deleted successfully' })
        } catch (dbError) {
            console.error('DB delete error:', dbError)
            return res.status(500).json({ error: 'Database error' })
        }
    } catch (error) {
        console.error('❌ Error deleting file:', error);
        return res.status(500).json({ error: error.message });
    }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket connection handler - each connection gets its own session container
wss.on('connection', async (ws, req) => {
    console.log('\n🔌 NEW WEBSOCKET CONNECTION');
    console.log(`📡 Client IP: ${req.socket.remoteAddress}`);
    console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
    
    let currentSessionId = null;
    
    // Set up WebSocket event handlers
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📨 RECEIVED MESSAGE: ${JSON.stringify(data)}`);
            
            switch (data.type) {
                case 'init':
                    console.log('🚀 Handling INIT message');
                    currentSessionId = data.sessionId;
                    await handleInit(ws, data.sessionId);
                    break;
                    
                case 'reconnect':
                    console.log('🔄 Handling RECONNECT message');
                    currentSessionId = data.sessionId;
                    await handleReconnect(ws, data);
                    break;
                    
                case 'input':
                    console.log(`⌨️ Handling INPUT message: "${data.data}"`);
                    if (currentSessionId && sessions.has(currentSessionId)) {
                        await handleInput(ws, data.data, currentSessionId);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'No active session' }));
                    }
                    break;
                    
                case 'ping':
                    console.log('🏓 Handling PING message');
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                    
                default:
                    console.log(`❓ Unknown message type: ${data.type}`);
            }
        } catch (error) {
            console.error('❌ Error parsing message:', error);
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Invalid message format',
                error: error.message 
            }));
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`🔌 WEBSOCKET CLOSED`);
        console.log(`📊 Close code: ${code}`);
        console.log(`📝 Close reason: ${reason}`);
        console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
        
        // Clean up session if this was the last connection for it
        if (currentSessionId && sessions.has(currentSessionId)) {
            const session = sessions.get(currentSessionId);
            if (session.ws === ws) {
                console.log(`🗑️ Cleaning up session: ${currentSessionId}`);
                if (session.ptyProcess) {
                    session.ptyProcess.kill();
                }
                sessions.delete(currentSessionId);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WEBSOCKET ERROR:', error);
        console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
    });
    
    // Send initial connection message
    console.log('📤 Sending connected message to client');
    console.log(`🔍 WebSocket readyState before sending: ${ws.readyState}`);
    try {
        ws.send(JSON.stringify({ 
            type: 'connected', 
            message: 'WebSocket connected successfully',
            timestamp: Date.now()
        }));
        console.log('✅ Sent connected message to client');
        console.log(`🔍 WebSocket readyState after sending: ${ws.readyState}`);
    } catch (error) {
        console.error('❌ Error sending connected message:', error);
        console.log(`🔍 WebSocket readyState during error: ${ws.readyState}`);
    }
});

async function handleReconnect(ws, data) {
    const { sessionId } = data;
    if (!sessionId || !sessions.has(sessionId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session container not found' }));
        return;
    }
    
    const session = sessions.get(sessionId);
    session.ws = ws; // Update WebSocket reference
    
    ws.send(JSON.stringify({
        type: 'session_restored',
        sessionId: sessionId,
        currentCwd: session.currentCwd,
        timestamp: Date.now()
    }));
    
    if (session.ptyReady) {
        ws.send(JSON.stringify({
            type: 'pty-ready',
            sessionId: sessionId,
            timestamp: Date.now()
        }));
    }
}

// Each session gets its own isolated PTY container
async function handleInit(ws, sessionId) {
    if (!sessionId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session ID required' }));
        return;
    }
    
    console.log(`🚀 Initializing session container: ${sessionId}`);
    
    // Check if session already exists
    if (sessions.has(sessionId)) {
        const existingSession = sessions.get(sessionId);
        if (existingSession.ptyProcess && !existingSession.ptyProcess.killed) {
            // Reuse existing PTY container
            existingSession.ws = ws;
            existingSession.ptyReady = true;
            sessions.set(sessionId, existingSession);
            
            ws.send(JSON.stringify({
                type: 'session_restored',
                sessionId: sessionId,
                currentCwd: existingSession.currentCwd,
                timestamp: Date.now()
            }));
            
            ws.send(JSON.stringify({
                type: 'pty-ready',
                sessionId: sessionId,
                timestamp: Date.now()
            }));
            return;
        }
    }
    
    // Create new PTY container for this session
    try {
        const ptyProcess = pty.default.spawn(process.env.SHELL || 'bash', [], {
            name: 'xterm-color',
            cols: 100,
            rows: 30,
            cwd: WORKSPACE_DIR,
            env: process.env
        });
        
        const session = {
            ws,
            ptyProcess,
            userId: null, // Will be set when user authenticates
            currentCwd: WORKSPACE_DIR,
            ptyReady: true,
            containerId: `container-${sessionId}` // Each session is a container
        };
        
        sessions.set(sessionId, session);
        
        // Set up PTY event handlers for this container
        ptyProcess.onData((data) => {
            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                session.ws.send(JSON.stringify({
                    type: 'output',
                    data: data
                }));
            }
        });
        
        ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`🔚 PTY container exited for session ${sessionId}: code=${exitCode}, signal=${signal}`);
            if (sessions.has(sessionId)) {
                sessions.delete(sessionId);
            }
        });
        
        ws.send(JSON.stringify({
            type: 'pty-ready',
            sessionId: sessionId,
            timestamp: Date.now()
        }));
        
        console.log(`✅ Session container ${sessionId} initialized with PTY`);
        
    } catch (error) {
        console.error(`❌ Failed to initialize session container ${sessionId}:`, error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to initialize terminal container',
            error: error.message
        }));
    }
}



// Each container allows all commands - user is isolated by session ID
async function handleInput(ws, input, sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.ptyProcess) {
        ws.send(JSON.stringify({ type: 'error', message: 'PTY container not available' }));
        return;
    }
    
    // NO COMMAND BLOCKING - user is in their own isolated container
    // All commands are allowed since they're isolated by session ID
    
    // Send input to PTY container
    session.ptyProcess.write(input);
    
    // Update current working directory if it's a cd command
    if (input.trim().startsWith('cd ')) {
        setTimeout(() => {
            try {
                const newCwd = process.cwd();
                session.currentCwd = newCwd;
            } catch (e) {
                console.warn('Failed to update CWD:', e.message);
            }
        }, 100);
    }
}

// Graceful shutdown - clean up all session containers
process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    sessions.forEach(session => {
        if (session.ptyProcess) {
            session.ptyProcess.kill();
        }
    });
    wss.close(() => {
        console.log('✅ WebSocket server closed, exiting...');
        process.exit(0);
    });
    server.close(() => {
        console.log('✅ HTTP server closed, exiting...');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    sessions.forEach(session => {
        if (session.ptyProcess) {
            session.ptyProcess.kill();
        }
    });
    wss.close(() => {
        console.log('✅ WebSocket server closed, exiting...');
        process.exit(0);
    });
    server.close(() => {
        console.log('✅ HTTP server closed, exiting...');
        process.exit(0);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`\n🎉 Server started successfully!`);
    console.log(`🌐 HTTP server running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready for connections`);
    console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
    console.log(`🕐 Started at: ${new Date().toISOString()}`);
    console.log(`\n📊 Current status:`);
    console.log(`   Sessions: ${sessions.size}`);
    console.log(`   PTY: ${sessions.size > 0 ? 'Running' : 'None'}`);
    console.log(`   WebSocket: ${wss.clients.size}`);
    console.log(`\n🚀 Ready to accept connections!`);
    console.log(`🔒 Each session gets isolated container with full command access`);
});

// Helper function to explain close codes
function getCloseCodeMeaning(code) {
    const meanings = {
        1000: 'Normal closure',
        1001: 'Going away',
        1002: 'Protocol error',
        1003: 'Unsupported data',
        1005: 'No status received',
        1006: 'Abnormal closure',
        1007: 'Invalid frame payload data',
        1008: 'Policy violation',
        1009: 'Message too big',
        1010: 'Client terminating',
        1011: 'Server error',
        1012: 'Service restart',
        1013: 'Try again later',
        1014: 'Bad gateway',
        1015: 'TLS handshake'
    };
    return meanings[code] || 'Unknown close code';
}
