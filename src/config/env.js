// Backend Environment Configuration
export const ENV_CONFIG = {
  // Server Configuration
  PORT: process.env.PORT || 8000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Workspace Configuration
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || './workspace',
  // Persistence Configuration
  PERSIST_MAX_FILE_MB: parseInt(process.env.PERSIST_MAX_FILE_MB || '10'),
  // Comma-separated list
  PERSIST_EXCLUDE_DIRS: (process.env.PERSIST_EXCLUDE_DIRS || 'node_modules,.git,dist,build,.cache').split(',').map(s => s.trim()).filter(Boolean),
  USER_VOLUME_MODE: process.env.USER_VOLUME_MODE || 'per_user',
  
  // Terminal Configuration
  TERM: process.env.TERM || 'xterm-256color',
  SHELL: process.env.SHELL || '/bin/bash',
  PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  
  // PTY Configuration
  PTY_ALLOWED: process.env.PTY_ALLOWED !== 'false', // Default to true
  MAX_TERMINAL_SESSIONS: parseInt(process.env.MAX_TERMINAL_SESSIONS || '10'),
  
  // WebSocket Configuration
  WS_HEARTBEAT_INTERVAL: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
  WS_MAX_PAYLOAD_SIZE: parseInt(process.env.WS_MAX_PAYLOAD_SIZE || '1048576'), // 1MB
  
  // Python Configuration
  PYTHON_VERSION: process.env.PYTHON_VERSION || '3.9',
  PYTHON: process.env.PYTHON || 'python3',
  NPM_CONFIG_PYTHON: process.env.NPM_CONFIG_PYTHON || 'python3',
  
  // Node.js Configuration
  NODE_VERSION: process.env.NODE_VERSION || '18.x',
  
  // npm Configuration for cleaner terminal output
  NPM_CONFIG_LOGLEVEL: process.env.NPM_CONFIG_LOGLEVEL || 'warn',
  NPM_CONFIG_PROGRESS: process.env.NPM_CONFIG_PROGRESS || 'false',
  NPM_CONFIG_AUDIT: process.env.NPM_CONFIG_AUDIT || 'false',
  
  // Security Configuration
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'https://frontend-ide.vercel.app',
  CORS_ENABLED: process.env.CORS_ENABLED !== 'false', // Default to true
  
  // GitHub OAuth Configuration
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'Ov23liJOQMa53qoe6VaE',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || 'your_github_client_secret',
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://frontend-ide.vercel.app/',
  
  // Logging Configuration
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FORMAT: process.env.LOG_FORMAT || 'combined',
  
  // Health Check Configuration
  HEALTH_CHECK_ENDPOINT: process.env.HEALTH_CHECK_ENDPOINT || '/health',
  HEALTH_CHECK_INTERVAL: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'),
};

// Helper functions
export const getPort = () => ENV_CONFIG.PORT;
export const getWorkspaceDir = () => ENV_CONFIG.WORKSPACE_DIR;
export const getPersistMaxFileMb = () => ENV_CONFIG.PERSIST_MAX_FILE_MB;
export const getPersistExcludeDirs = () => ENV_CONFIG.PERSIST_EXCLUDE_DIRS;
export const getUserVolumeMode = () => ENV_CONFIG.USER_VOLUME_MODE;
export const getNodeEnv = () => ENV_CONFIG.NODE_ENV;
export const isDevelopment = () => ENV_CONFIG.NODE_ENV === 'development';
export const isProduction = () => ENV_CONFIG.NODE_ENV === 'production';
export const isPtyAllowed = () => ENV_CONFIG.PTY_ALLOWED;
export const getMaxTerminalSessions = () => ENV_CONFIG.MAX_TERMINAL_SESSIONS;
export const getGitHubClientId = () => ENV_CONFIG.GITHUB_CLIENT_ID;
export const getGitHubClientSecret = () => ENV_CONFIG.GITHUB_CLIENT_SECRET;
export const getFrontendUrl = () => ENV_CONFIG.FRONTEND_URL;
