# Use Apify's standard Node.js 22 image
FROM apify/actor-node:22

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

# Copy source code
COPY . ./

# Set environment variables
ENV APIFY_LOG_LEVEL=INFO

# Run the actor
CMD ["npm", "start", "--silent"]
