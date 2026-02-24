# Dev container for toolbox - Node.js/Deno development
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# Install Redis CLI and MySQL client for debugging
RUN apt-get update && apt-get install -y --no-install-recommends \
    redis-tools \
    default-mysql-client \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno

USER vscode
WORKDIR /workspace
