FROM node:20-bookworm-slim

# git is required at runtime: every applied config change is committed to a
# dedicated git repo under DATA_DIR/config-backups.
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 4000
CMD ["node", "src/index.js"]
