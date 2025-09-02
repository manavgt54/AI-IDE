# Use Node.js 18 with Python for node-pty compilation
FROM node:18-bullseye

# Install system dependencies for node-pty compilation
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    git \
    curl \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set Python version and environment for node-pty
ENV PYTHON_VERSION=3.9
ENV PYTHON=/usr/bin/python3
ENV NODE_ENV=production
ENV NPM_CONFIG_PYTHON=/usr/bin/python3

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with compilation support
RUN npm install --unsafe-perm --production=false

# Force rebuild node-pty to ensure it's compiled for this environment
RUN npm rebuild node-pty --unsafe-perm

# Verify node-pty installation
RUN node -e "try { const pty = require('node-pty'); console.log('✅ node-pty loaded successfully, version:', pty.version); } catch(e) { console.error('❌ node-pty failed to load:', e.message); process.exit(1); }"

# Copy source code
COPY . .

# Create workspace directory
RUN mkdir -p workspace && chmod 755 workspace

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Start the application
CMD ["npm", "run", "start:direct"]
