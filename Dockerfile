FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY README.md .env.example ./

ENV NODE_ENV=production

CMD ["npm", "start"]
