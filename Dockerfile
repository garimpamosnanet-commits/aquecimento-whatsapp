FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p sessions data media/audios media/images media/stickers

EXPOSE 3001

CMD ["node", "server.js"]
