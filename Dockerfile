FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --omit=dev

# Copy source
COPY . .

# Default env
ENV SIGRANK_API_BASE=https://signalaf.com

# Run the MCP server over stdio
CMD ["node", "index.mjs"]
